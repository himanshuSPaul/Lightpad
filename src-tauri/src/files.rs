//! Reading and saving text files without losing their encoding or risking a half-written file.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use encoding_rs::WINDOWS_1252;
use serde::Serialize;

/// Files bigger than this are refused instead of freezing the editor.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
pub struct TextFile {
    text: String,
    encoding: &'static str,
    /// Last-modified time in milliseconds, used to notice changes made by other programs.
    modified: Option<u64>,
}

fn modified_ms(path: &Path) -> Option<u64> {
    let time = fs::metadata(path).ok()?.modified().ok()?;
    Some(time.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// The file's last-modified time in milliseconds, or None if it is gone.
#[tauri::command]
pub fn file_modified(path: String) -> Option<u64> {
    modified_ms(Path::new(&path))
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| if little_endian { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
        .collect();
    String::from_utf16_lossy(&units)
}

fn decode(bytes: &[u8]) -> Result<TextFile, String> {
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        let text = String::from_utf8(rest.to_vec()).map_err(|_| "File has a UTF-8 marker but is not valid UTF-8")?;
        return Ok(TextFile { text, encoding: "UTF-8 BOM", modified: None });
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        return Ok(TextFile { text: decode_utf16(rest, true), encoding: "UTF-16 LE", modified: None });
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        return Ok(TextFile { text: decode_utf16(rest, false), encoding: "UTF-16 BE", modified: None });
    }
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err("This looks like a binary file, so Lightpad won't open it.".into());
    }
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => Ok(TextFile { text, encoding: "UTF-8", modified: None }),
        // Not UTF-8: most likely a legacy Windows ("ANSI") file. Windows-1252 maps every byte,
        // so it is saved back byte for byte.
        Err(_) => Ok(TextFile { text: WINDOWS_1252.decode(bytes).0.into_owned(), encoding: "Windows-1252", modified: None }),
    }
}

fn encode(text: &str, encoding: &str) -> Result<Vec<u8>, String> {
    Ok(match encoding {
        "UTF-8 BOM" => [b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat(),
        "UTF-16 LE" => [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect(),
        "UTF-16 BE" => [0xFE, 0xFF].into_iter().chain(text.encode_utf16().flat_map(u16::to_be_bytes)).collect(),
        "Windows-1252" => {
            let (bytes, _, unmappable) = WINDOWS_1252.encode(text);
            if unmappable {
                return Err("The text has characters that Windows-1252 can't store. Save it as UTF-8 instead.".into());
            }
            bytes.into_owned()
        }
        _ => text.as_bytes().to_vec(),
    })
}

#[tauri::command]
pub fn read_file(path: String) -> Result<TextFile, String> {
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "This file is {} MB. Lightpad opens files up to {} MB.",
            size / (1024 * 1024),
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }
    let modified = modified_ms(Path::new(&path));
    let mut file = decode(&fs::read(&path).map_err(|e| e.to_string())?)?;
    file.modified = modified;
    Ok(file)
}

/// Writes to a temporary file next to the target and then renames it over the target, so a
/// crash or full disk can never leave a half-written file behind. Returns the new modified time.
#[tauri::command]
pub fn write_file(path: String, contents: String, encoding: Option<String>) -> Result<Option<u64>, String> {
    let bytes = encode(&contents, encoding.as_deref().unwrap_or("UTF-8"))?;
    // Save through symlinks to the real file instead of replacing the link.
    let target: PathBuf = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let dir = target.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = target.file_name().ok_or("Invalid file name")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.lightpad-save"));

    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        drop(f);
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        // The copied permissions may have made the temp file read-only, which blocks removing it on Windows.
        if let Ok(meta) = fs::metadata(&tmp) {
            let mut perms = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(&tmp, perms);
        }
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| e.to_string())?;
    Ok(modified_ms(&target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_encoding() {
        let text = "héllo wörld\r\nline 2 €";
        for enc in ["UTF-8", "UTF-8 BOM", "UTF-16 LE", "UTF-16 BE", "Windows-1252"] {
            let bytes = encode(text, enc).unwrap();
            let file = decode(&bytes).unwrap();
            assert_eq!(file.text, text, "{enc}");
            assert_eq!(file.encoding, enc);
        }
    }

    #[test]
    fn keeps_legacy_bytes_unchanged() {
        let original: Vec<u8> = (0x20..=0xFF).filter(|b| ![0x81, 0x8D, 0x8F, 0x90, 0x9D].contains(b)).collect();
        let file = decode(&original).unwrap();
        assert_eq!(file.encoding, "Windows-1252");
        assert_eq!(encode(&file.text, file.encoding).unwrap(), original);
    }

    #[test]
    fn refuses_binary_and_unstorable_text() {
        assert!(decode(b"MZ\0\0binary").is_err());
        assert!(encode("日本", "Windows-1252").is_err());
    }

    #[test]
    fn saves_atomically_and_replaces_content() {
        let dir = std::env::temp_dir().join(format!("lightpad-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.txt");
        fs::write(&p, "old content that is longer").unwrap();
        write_file(p.to_string_lossy().into(), "new".into(), None).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "temp file left behind");
        fs::remove_dir_all(&dir).unwrap();
    }
}

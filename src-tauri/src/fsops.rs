//! File and folder operations for the explorer's right-click menu. None of these overwrite an
//! existing file or folder, and Delete moves to the Recycle Bin instead of erasing.

use std::fs;
use std::path::{Path, PathBuf};

fn check_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(format!("\"{name}\" is not a valid name."));
    }
    if cfg!(windows) && name.contains([':', '*', '?', '"', '<', '>', '|']) {
        return Err("A name can't contain any of these characters: \\ / : * ? \" < > |".into());
    }
    Ok(name)
}

fn ensure_free(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err(format!("\"{}\" already exists.", path.file_name().unwrap_or_default().to_string_lossy()));
    }
    Ok(())
}

/// True when both paths name the same file on disk, e.g. "a.txt" and "A.txt" on Windows.
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        // Windows file systems ignore letter case, so a case-only rename names the same file.
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }
}

fn to_string(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

#[tauri::command]
pub fn create_file(dir: String, name: String) -> Result<String, String> {
    let path = Path::new(&dir).join(check_name(&name)?);
    ensure_free(&path)?;
    fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
    Ok(to_string(path))
}

#[tauri::command]
pub fn create_dir(dir: String, name: String) -> Result<String, String> {
    let path = Path::new(&dir).join(check_name(&name)?);
    ensure_free(&path)?;
    fs::create_dir(&path).map_err(|e| e.to_string())?;
    Ok(to_string(path))
}

#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let from = PathBuf::from(&path);
    let to = from.with_file_name(check_name(&new_name)?);
    if to == from {
        return Ok(path);
    }
    // Allow changing only the letter case on case-insensitive file systems, where the new name
    // already "exists" because it is the same file.
    if !(to.exists() && same_file(&from, &to)) {
        ensure_free(&to)?;
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(to_string(to))
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("Could not move it to the Recycle Bin: {e}"))
}

/// "name - Copy.ext", then "name - Copy (2).ext", ... like Windows Explorer.
fn free_copy_name(dir: &Path, src: &Path) -> PathBuf {
    let candidate = dir.join(src.file_name().unwrap_or_default());
    if !candidate.exists() {
        return candidate;
    }
    let stem = src.file_stem().unwrap_or_default().to_string_lossy();
    let ext = if src.is_dir() { None } else { src.extension().map(|e| e.to_string_lossy()) };
    (1..)
        .map(|n| {
            let suffix = if n == 1 { " - Copy".to_string() } else { format!(" - Copy ({n})") };
            let name = match &ext {
                Some(ext) => format!("{stem}{suffix}.{ext}"),
                None => format!("{}{suffix}", src.file_name().unwrap_or_default().to_string_lossy()),
            };
            dir.join(name)
        })
        .find(|p| !p.exists())
        .unwrap()
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    // Copy links as links. Following them could loop forever on a link to a parent folder.
    if fs::symlink_metadata(from)?.file_type().is_symlink() {
        let target = fs::read_link(from)?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(&target, to);
        #[cfg(windows)]
        return if from.is_dir() {
            std::os::windows::fs::symlink_dir(&target, to)
        } else {
            std::os::windows::fs::symlink_file(&target, to)
        };
    }
    if from.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

/// Pastes `src` into `dest_dir`: moves it when `cut` is true, otherwise copies it.
#[tauri::command]
pub fn paste_path(src: String, dest_dir: String, cut: bool) -> Result<String, String> {
    let src = PathBuf::from(src);
    let dest_dir = PathBuf::from(dest_dir);
    if !src.exists() {
        return Err(format!("\"{}\" no longer exists.", src.display()));
    }
    let src_real = fs::canonicalize(&src).map_err(|e| e.to_string())?;
    let dest_real = fs::canonicalize(&dest_dir).map_err(|e| e.to_string())?;
    if src_real.is_dir() && dest_real.starts_with(&src_real) {
        return Err("Can't paste a folder inside itself.".into());
    }
    if cut {
        if src_real.parent() == Some(dest_real.as_path()) {
            return Ok(to_string(src)); // already there
        }
        let to = dest_dir.join(src.file_name().unwrap_or_default());
        ensure_free(&to)?;
        if fs::rename(&src, &to).is_err() {
            // Moving across drives: copy, then remove the original.
            copy_recursive(&src, &to).map_err(|e| e.to_string())?;
            let removed = if src.is_dir() { fs::remove_dir_all(&src) } else { fs::remove_file(&src) };
            removed.map_err(|e| format!("Copied, but could not remove the original: {e}"))?;
        }
        Ok(to_string(to))
    } else {
        let to = free_copy_name(&dest_dir, &src);
        copy_recursive(&src, &to).map_err(|e| e.to_string())?;
        Ok(to_string(to))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lightpad-fsops-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn create_rename_and_refuse_overwrite() {
        let d = temp_dir("rename");
        let a = create_file(s(&d), "a.txt".into()).unwrap();
        create_file(s(&d), "b.txt".into()).unwrap();
        assert!(create_file(s(&d), "a.txt".into()).is_err());
        assert!(rename_path(a.clone(), "b.txt".into()).is_err(), "rename must not overwrite");
        assert!(rename_path(a.clone(), "x/y".into()).is_err());
        let c = rename_path(a, "c.txt".into()).unwrap();
        assert!(Path::new(&c).exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn copy_makes_numbered_copies_and_cut_moves() {
        let d = temp_dir("paste");
        let sub = create_dir(s(&d), "sub".into()).unwrap();
        let f = d.join("notes.txt");
        fs::write(&f, "hi").unwrap();
        let c1 = paste_path(s(&f), s(&d), false).unwrap();
        let c2 = paste_path(s(&f), s(&d), false).unwrap();
        assert!(c1.ends_with("notes - Copy.txt"), "{c1}");
        assert!(c2.ends_with("notes - Copy (2).txt"), "{c2}");
        let moved = paste_path(s(&f), sub.clone(), true).unwrap();
        assert!(!f.exists() && Path::new(&moved).exists());
        assert_eq!(fs::read_to_string(&moved).unwrap(), "hi");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn case_only_rename_never_overwrites_another_file() {
        let d = temp_dir("case");
        let lower = d.join("a.txt");
        fs::write(&lower, "lower").unwrap();
        let upper = d.join("A.txt");
        if upper.exists() {
            // Case-insensitive file system: "A.txt" is the same file, so the rename is allowed.
            assert!(rename_path(s(&lower), "A.txt".into()).is_ok());
        } else {
            fs::write(&upper, "UPPER").unwrap();
            assert!(rename_path(s(&lower), "A.txt".into()).is_err());
            assert_eq!(fs::read_to_string(&upper).unwrap(), "UPPER");
        }
        fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn copies_links_without_following_them() {
        let d = temp_dir("links");
        let proj = d.join("proj");
        fs::create_dir(&proj).unwrap();
        fs::write(proj.join("a.txt"), "a").unwrap();
        std::os::unix::fs::symlink(&proj, proj.join("self")).unwrap();
        let copy = paste_path(s(&proj), s(&d), false).unwrap();
        assert!(fs::symlink_metadata(Path::new(&copy).join("self")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(Path::new(&copy).join("a.txt")).unwrap(), "a");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn copies_folders_and_refuses_pasting_into_itself() {
        let d = temp_dir("folder");
        let sub = create_dir(s(&d), "sub".into()).unwrap();
        fs::write(Path::new(&sub).join("x.txt"), "x").unwrap();
        let copy = paste_path(sub.clone(), s(&d), false).unwrap();
        assert!(copy.ends_with("sub - Copy"), "{copy}");
        assert!(Path::new(&copy).join("x.txt").exists());
        assert!(paste_path(sub.clone(), sub.clone(), false).is_err());
        assert!(paste_path(s(&d), sub, true).is_err());
        fs::remove_dir_all(&d).unwrap();
    }
}

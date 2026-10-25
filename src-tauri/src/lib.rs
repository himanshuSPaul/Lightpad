mod pty;

use std::fs;
use std::path::Path;

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Lists a folder for the explorer: folders first, then files, by name.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            // Follows symlinks, so a link to a folder shows as a folder.
            is_dir: e.path().is_dir(),
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_exists,
            list_dir,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lightpad");
}

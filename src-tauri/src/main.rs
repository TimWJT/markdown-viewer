// Markdown Viewer — native shell.
//
// The entire UI is the same single HTML file the browser build produces. Rust
// only does the three things a web page cannot: read an arbitrary path off
// disk, report its mtime so the viewer can live-reload, and receive the file
// Windows/macOS hands us when someone double-clicks a .md document.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use tauri::{Emitter, Manager, State};

/// The file this process was launched with, if any. Taken exactly once by the
/// frontend during boot.
struct InitialFile(Mutex<Option<String>>);

/// First non-flag argument. Windows passes the document path this way when a
/// file association launches us.
fn first_file_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && !a.is_empty())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Milliseconds since the epoch, so the frontend can compare it the same way it
/// compares `File.lastModified` in the browser build.
#[tauri::command]
fn file_mtime(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let modified = meta.modified().map_err(|e| e.to_string())?;
    let ms = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    Ok(ms as u64)
}

#[tauri::command]
fn initial_file(state: State<'_, InitialFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

fn main() {
    let initial = first_file_arg(std::env::args());

    tauri::Builder::default()
        // Must be registered first: a second launch forwards its argv here
        // instead of opening a second window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = first_file_arg(argv) {
                let _ = app.emit("open-file", path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(InitialFile(Mutex::new(initial)))
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            file_mtime,
            initial_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Markdown Viewer");
}

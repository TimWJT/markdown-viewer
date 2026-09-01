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

/// Markdown files sitting next to `path`, sorted, so the frontend can offer
/// next/previous navigation through a docs folder.
#[tauri::command]
fn sibling_files(path: String) -> Result<Vec<String>, String> {
    const EXTS: [&str; 6] = ["md", "markdown", "mdown", "mkd", "mdx", "txt"];

    let file = std::path::Path::new(&path);
    let dir = file.parent().ok_or_else(|| "no parent directory".to_string())?;

    let mut out: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let p = entry.path();
            let ext = p.extension()?.to_str()?.to_ascii_lowercase();
            if !EXTS.contains(&ext.as_str()) {
                return None;
            }
            Some(p.to_string_lossy().into_owned())
        })
        .collect();

    // Case-insensitive so the order matches what a file manager shows.
    out.sort_by_key(|s| s.to_lowercase());
    Ok(out)
}

/// WebView2 implements its own pinch-to-zoom at the browser level, which scales
/// the entire UI — toolbar included — and swallows the gesture before the page
/// can act on it. The app does its own zoom on the document only, so turn the
/// built-in one off and let the frontend handle pinch.
#[cfg(target_os = "windows")]
fn disable_builtin_pinch_zoom(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings5;
    use windows::core::Interface;

    let result = window.with_webview(|webview| unsafe {
        let controller = webview.controller();
        if let Ok(core) = controller.CoreWebView2() {
            if let Ok(settings) = core.Settings() {
                if let Ok(settings5) = settings.cast::<ICoreWebView2Settings5>() {
                    let _ = settings5.SetIsPinchZoomEnabled(false);
                }
            }
        }
    });

    if let Err(e) = result {
        eprintln!("could not reach the webview to disable pinch zoom: {e}");
    }
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = _app.get_webview_window("main") {
                disable_builtin_pinch_zoom(&window);
            }
            Ok(())
        })
        .manage(InitialFile(Mutex::new(initial)))
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            file_mtime,
            initial_file,
            sibling_files
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Markdown Viewer");
}

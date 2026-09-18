// Markdown Viewer — native shell.
//
// The entire UI is the same single HTML file the browser build produces. Rust
// only does the three things a web page cannot: read an arbitrary path off
// disk, report its mtime so the viewer can live-reload, and receive the file
// Windows/macOS hands us when someone double-clicks a .md document.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashSet, VecDeque};
use std::sync::{mpsc, Mutex};
use std::time::UNIX_EPOCH;

use tauri::{Emitter, Manager, State};

/// The file this process was launched with, if any. Taken exactly once by the
/// frontend during boot.
struct InitialFile(Mutex<Option<String>>);

// One worker owns routing and the unclaimed queue. Window creation must not run
// in a synchronous IPC command or window-event callback (WebView2 deadlocks).
struct ExternalOpens(mpsc::Sender<OpenMessage>);

enum OpenMessage {
    Open(Option<String>),
    Ready(String),
    Destroyed(String),
    Claim {
        label: String,
        path: String,
        reply: mpsc::Sender<bool>,
    },
}

struct PendingOpen {
    path: String,
    recipient: Option<String>,
    notified: bool,
}

fn select_recipient<'a>(
    labels: impl IntoIterator<Item = &'a str>,
    unavailable: &HashSet<String>,
) -> Option<&'a str> {
    labels
        .into_iter()
        .filter(|label| {
            !unavailable.contains(*label) && (*label == "main" || label.starts_with("doc-"))
        })
        .min_by_key(|label| (*label != "main", *label))
}

fn external_recipient(
    app: &tauri::AppHandle,
    unavailable: &HashSet<String>,
) -> Option<tauri::WebviewWindow> {
    let mut windows = app.webview_windows();
    let label = select_recipient(windows.keys().map(String::as_str), unavailable)?.to_owned();
    windows.remove(&label)
}

fn revoke_recipient(pending: &mut VecDeque<PendingOpen>, label: &str) {
    for request in pending {
        if request.recipient.as_deref() == Some(label) {
            request.recipient = None;
            request.notified = false;
        }
    }
}

fn claim_pending(pending: &mut VecDeque<PendingOpen>, label: &str, path: &str, live: bool) -> bool {
    let index = pending.iter().position(|request| {
        live && request.recipient.as_deref() == Some(label)
            && request.path == path
            && request.notified
    });
    if let Some(index) = index {
        pending.remove(index);
        true
    } else {
        false
    }
}

fn focus_recipient(window: &tauri::WebviewWindow) {
    if let Err(error) = window.unminimize() {
        eprintln!("could not unminimise external-open recipient: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("could not focus external-open recipient: {error}");
    }
}

fn route_external_opens(app: tauri::AppHandle, receiver: mpsc::Receiver<OpenMessage>) {
    let mut ready = HashSet::new();
    // Failed labels stay excluded as well as destroyed ones. With the existing
    // label+path claim interface, reusing a failed label could let a delayed URL
    // or event claim a later assignment. A fresh label avoids that ambiguity.
    let mut unavailable = HashSet::new();
    let mut pending: VecDeque<PendingOpen> = VecDeque::new();
    let mut next_window = 0_u64;

    while let Ok(message) = receiver.recv() {
        match message {
            OpenMessage::Open(path) => {
                if let Some(path) = path {
                    pending.push_back(PendingOpen {
                        path,
                        recipient: None,
                        notified: false,
                    });
                } else if let Some(window) = external_recipient(&app, &unavailable) {
                    focus_recipient(&window);
                }
            }
            OpenMessage::Ready(label) => {
                // Failed-window callbacks must not trigger another retry cycle.
                if unavailable.contains(&label) {
                    continue;
                }
                ready.insert(label);
            }
            OpenMessage::Destroyed(label) => {
                // In particular, destroying our own partial build must not
                // turn persistent creation failure into a message-driven loop.
                if unavailable.contains(&label) {
                    continue;
                }
                ready.remove(&label);
                unavailable.insert(label.clone());
                revoke_recipient(&mut pending, &label);
            }
            OpenMessage::Claim { label, path, reply } => {
                if unavailable.contains(&label) {
                    let _ = reply.send(false);
                    continue;
                }
                // The frontend must claim BEFORE opening. An old event from a
                // destroyed recipient cannot claim a reassigned request. Each
                // repeated path remains a separate queue entry.
                let live = app.get_webview_window(&label).is_some();
                let claimed = claim_pending(&mut pending, &label, &path, live);
                // Acceptance transfers ownership to this frontend. Never retry
                // an accepted open: it may already have spawned another window.
                if reply.send(claimed).is_err() && claimed {
                    eprintln!("external-open recipient disconnected after accepting a request");
                }
            }
        }

        // Recover missing recipients even if their Destroyed message was lost
        // or has not arrived yet. Only unclaimed queue entries can be revoked.
        let missing: HashSet<_> = pending
            .iter()
            .filter_map(|request| request.recipient.as_ref())
            .filter(|label| app.get_webview_window(label).is_none())
            .cloned()
            .collect();
        for label in missing {
            eprintln!("external-open recipient {label} disappeared; revoking unclaimed requests");
            revoke_recipient(&mut pending, &label);
            ready.remove(&label);
            unavailable.insert(label);
        }

        // One initial attempt and at most one immediate retry per message.
        // Persistent failures remain unassigned until another routing message.
        for attempt in 0..2 {
            let mut failed = None;
            let mut failed_creation = false;
            if pending.iter().any(|request| request.recipient.is_none()) {
                let window = match external_recipient(&app, &unavailable) {
                    Some(window) => Some(window),
                    None => {
                        // Never collide with a frontend-created or partial window.
                        let label = loop {
                            next_window += 1;
                            let label = format!("doc-external-{next_window}");
                            if !unavailable.contains(&label)
                                && app.get_webview_window(&label).is_none()
                            {
                                break label;
                            }
                        };
                        let request = pending
                            .iter_mut()
                            .find(|request| request.recipient.is_none())
                            .expect("an unassigned request exists");
                        // Tauri's URL dependency escapes Unicode, &, and #.
                        let mut url = tauri::Url::parse("https://localhost/index.html")
                            .expect("static base URL is valid");
                        url.query_pairs_mut()
                            .append_pair("file", &request.path)
                            .append_pair("externalOpen", "1");
                        let relative = format!("index.html?{}", url.query().unwrap_or_default());
                        request.recipient = Some(label.clone());
                        request.notified = true; // URL notification, not acceptance.
                        match tauri::WebviewWindowBuilder::new(
                            &app,
                            &label,
                            tauri::WebviewUrl::App(relative.into()),
                        )
                        .title("Markdown Viewer")
                        .inner_size(1100.0, 820.0)
                        .build()
                        {
                            Ok(window) => Some(window),
                            Err(error) => {
                                eprintln!(
                                    "could not create external-open recipient {label}: {error}"
                                );
                                // A partial window may still boot. Quarantine its
                                // label and revoke its URL claim before retrying;
                                // never treat a failed build as a displayed file.
                                failed_creation = true;
                                failed = Some(label);
                                None
                            }
                        }
                    }
                };
                if let Some(window) = window {
                    focus_recipient(&window);
                    for request in &mut pending {
                        if request.recipient.is_none() {
                            request.recipient = Some(window.label().to_owned());
                        }
                    }
                }
            }

            if failed.is_none() {
                for request in &mut pending {
                    let Some(label) = request.recipient.as_deref() else {
                        continue;
                    };
                    if request.notified || !ready.contains(label) {
                        continue;
                    }
                    // JS registers with this same explicit target. Successful
                    // emit is not acceptance; only Claim removes the entry.
                    match app.emit_to(
                        tauri::EventTarget::webview_window(label),
                        "open-file",
                        request.path.clone(),
                    ) {
                        Ok(()) => request.notified = true,
                        Err(error) => {
                            eprintln!("external-open notification to {label} failed: {error}");
                            failed = Some(label.to_owned());
                            break;
                        }
                    }
                }
            }

            let Some(label) = failed else {
                break;
            };
            // Claims are processed by this worker, so none can be accepted
            // between a failed operation and revocation. Previously accepted
            // opens are already absent and can never be retried here.
            revoke_recipient(&mut pending, &label);
            ready.remove(&label);
            unavailable.insert(label.clone());
            // Clean up only a failed build, never an existing document window
            // whose emit failed: it may contain previously accepted opens.
            // Revocation comes first, so even a surviving partial URL is stale.
            if failed_creation {
                if let Some(window) = app.get_webview_window(&label) {
                    if let Err(error) = window.destroy() {
                        eprintln!("could not remove partial external-open window {label}: {error}");
                    }
                }
            }
            if attempt == 1 {
                eprintln!("external-open recovery failed twice; unclaimed requests retained unassigned for the next routing message");
            }
        }
    }
}

#[cfg(test)]
mod external_open_tests {
    use super::*;

    fn assigned(path: &str, label: &str, notified: bool) -> PendingOpen {
        PendingOpen {
            path: path.into(),
            recipient: Some(label.into()),
            notified,
        }
    }

    #[test]
    fn selection_prefers_main_then_sorted_documents_and_excludes_failed_labels() {
        let labels = ["settings", "doc-b", "main", "doc-a"];
        let mut unavailable = HashSet::new();
        assert_eq!(select_recipient(labels, &unavailable), Some("main"));
        unavailable.insert("main".into());
        assert_eq!(select_recipient(labels, &unavailable), Some("doc-a"));
        unavailable.insert("doc-a".into());
        unavailable.insert("doc-b".into());
        assert_eq!(select_recipient(labels, &unavailable), None);
    }

    #[test]
    fn failed_creation_revokes_partial_url_before_fresh_assignment() {
        let mut pending = VecDeque::from([assigned("a.md", "doc-old", true)]);
        revoke_recipient(&mut pending, "doc-old");
        assert!(pending[0].recipient.is_none());
        assert!(!pending[0].notified);
        assert!(!claim_pending(&mut pending, "doc-old", "a.md", true));
        pending[0].recipient = Some("doc-new".into());
        pending[0].notified = true;
        assert!(!claim_pending(&mut pending, "doc-old", "a.md", true));
        assert!(claim_pending(&mut pending, "doc-new", "a.md", true));
        assert!(!claim_pending(&mut pending, "doc-new", "a.md", true));
    }

    #[test]
    fn emit_failure_revokes_only_unclaimed_work_for_that_recipient() {
        let mut pending = VecDeque::from([
            assigned("completed.md", "main", true),
            assigned("sent.md", "main", true),
            assigned("failed.md", "main", false),
            assigned("other.md", "doc-other", true),
        ]);
        assert!(claim_pending(&mut pending, "main", "completed.md", true));
        revoke_recipient(&mut pending, "main");
        assert_eq!(pending.len(), 3);
        for request in pending.iter().take(2) {
            assert!(request.recipient.is_none());
            assert!(!request.notified);
        }
        assert!(!claim_pending(&mut pending, "main", "sent.md", true));
        assert!(!claim_pending(&mut pending, "main", "completed.md", true));
        assert!(claim_pending(&mut pending, "doc-other", "other.md", true));
    }

    #[test]
    fn claims_require_live_notified_assignment_and_consume_one_repeated_path() {
        let mut pending = VecDeque::from([
            assigned("same.md", "main", false),
            assigned("same.md", "main", true),
        ]);
        assert!(!claim_pending(&mut pending, "main", "same.md", false));
        assert!(!claim_pending(&mut pending, "doc-other", "same.md", true));
        assert!(!claim_pending(&mut pending, "main", "different.md", true));
        assert!(claim_pending(&mut pending, "main", "same.md", true));
        assert_eq!(pending.len(), 1);
        assert!(!claim_pending(&mut pending, "main", "same.md", true));
        pending[0].notified = true;
        assert!(claim_pending(&mut pending, "main", "same.md", true));
        assert!(pending.is_empty());
    }
}

#[tauri::command]
fn external_open_ready(
    window: tauri::WebviewWindow,
    state: State<'_, ExternalOpens>,
) -> Result<(), String> {
    state
        .0
        .send(OpenMessage::Ready(window.label().to_owned()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn claim_external_open(
    window: tauri::WebviewWindow,
    path: String,
    state: State<'_, ExternalOpens>,
) -> Result<bool, String> {
    let (reply, receiver) = mpsc::channel();
    state
        .0
        .send(OpenMessage::Claim {
            label: window.label().to_owned(),
            path,
            reply,
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

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
    let dir = file
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?;

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
    let (open_sender, open_receiver) = mpsc::channel();

    tauri::Builder::default()
        .manage(ExternalOpens(open_sender))
        // Must be registered first: a second launch forwards its argv here
        // instead of opening a second window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Err(error) = app
                .state::<ExternalOpens>()
                .0
                .send(OpenMessage::Open(first_file_arg(argv)))
            {
                eprintln!("could not queue external file open: {error}");
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            // The frontend closes a single window with destroy(), which skips
            // this. A native close request (title bar, Alt+F4) quits the whole
            // program instead, so nothing is left running in the background.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.app_handle().exit(0);
                return;
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                // Browser-style: focus moves to a remaining window. With none
                // left, Tauri exits the process on its own.
                if let Some(next) = external_recipient(
                    window.app_handle(),
                    &HashSet::from([window.label().to_owned()]),
                ) {
                    focus_recipient(&next);
                }
                if let Err(error) = window
                    .state::<ExternalOpens>()
                    .0
                    .send(OpenMessage::Destroyed(window.label().to_owned()))
                {
                    eprintln!("could not update external-open recipient state: {error}");
                }
            }
        })
        .setup(move |_app| {
            let handle = _app.handle().clone();
            std::thread::spawn(move || route_external_opens(handle, open_receiver));
            // The frontend drives the check, so the plugin only needs to exist.
            #[cfg(desktop)]
            _app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

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
            sibling_files,
            external_open_ready,
            claim_external_open
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Markdown Viewer");
}

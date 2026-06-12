mod chunk;
mod encoding;
mod menu;
mod prefs;
mod recent;
mod search;
mod session;
mod store;
mod watcher;

use serde::Serialize;
use std::sync::Mutex;
use tauri::Emitter;

/// Files requested via OS integration (file association, CLI args) before
/// the frontend was ready to receive events. Drained by the frontend on
/// startup through `take_pending_files`.
struct PendingFiles(Mutex<Vec<String>>);

/// Extract existing file paths from process-style arguments, skipping the
/// binary name and anything that looks like a flag.
fn existing_paths_from_args<I: Iterator<Item = String>>(args: I) -> Vec<String> {
    args.skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| std::path::Path::new(arg).is_file())
        .collect()
}

#[tauri::command]
fn take_pending_files(state: tauri::State<PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Open the native print dialog for the main webview. The frontend fills
/// its print-only view with the full document before calling this, because
/// the editor's virtualized viewport only renders visible lines.
#[tauri::command]
fn print_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .print()
        .map_err(|e| format!("Printing is not available: {e}"))
}

/// Files larger than this open as a read-only preview instead of loading
/// fully into the WebView.
const LARGE_FILE_THRESHOLD: u64 = 10 * 1024 * 1024;
/// How much of a large file the preview shows.
const PREVIEW_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    path: String,
    content: String,
    encoding: String,
    had_bom: bool,
    malformed: bool,
    line_ending: String,
    /// True when only a leading slice of the file was loaded (read-only).
    truncated: bool,
    total_size: u64,
    /// When truncated: file offset where the next chunk begins.
    next_offset: Option<u64>,
}

/// Cut a preview slice at the last line boundary so the tail is not a
/// half-loaded line (or a split multi-byte sequence) where avoidable.
fn preview_slice(bytes: &[u8], max: usize) -> &[u8] {
    if bytes.len() <= max {
        return bytes;
    }
    let slice = &bytes[..max];
    match slice.iter().rposition(|&b| b == b'\n') {
        Some(pos) => &slice[..=pos],
        None => slice,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    unmappable: bool,
}

/// Read a file from disk, decoding with the given encoding label or with
/// automatic detection when `encoding` is `None`. The returned content is
/// LF-normalized; the original line ending is reported in `line_ending`.
#[tauri::command]
fn open_document(path: String, encoding: Option<String>) -> Result<OpenedDocument, String> {
    let total_size = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let truncated = total_size > LARGE_FILE_THRESHOLD;
    let (bytes, next_offset) = if truncated {
        let slice = preview_slice(&bytes, PREVIEW_BYTES);
        (slice, Some(slice.len() as u64))
    } else {
        (&bytes[..], None)
    };
    let decoded = match encoding {
        Some(label) => encoding::decode_with(bytes, &label)?,
        None => encoding::decode_auto(bytes),
    };
    let line_ending = encoding::detect_line_ending(&decoded.content).to_string();
    Ok(OpenedDocument {
        path,
        content: encoding::normalize_to_lf(&decoded.content),
        encoding: decoded.encoding,
        had_bom: decoded.had_bom,
        malformed: decoded.malformed,
        line_ending,
        truncated,
        total_size,
        next_offset,
    })
}

/// Write bytes atomically: write to a temporary file in the same directory
/// (same filesystem), fsync, then rename over the target. A crash mid-save
/// leaves either the old file or the new one — never a half-written file.
/// Existing file permissions are carried over to the replacement.
fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp_path = dir.join(format!(".{file_name}.plume-tmp-{}", std::process::id()));

    let result = (|| {
        let mut tmp = std::fs::File::create(&tmp_path)?;
        tmp.write_all(bytes)?;
        tmp.sync_all()?;
        drop(tmp);
        if let Ok(meta) = std::fs::metadata(path) {
            let _ = std::fs::set_permissions(&tmp_path, meta.permissions());
        }
        // std::fs::rename replaces the destination on every platform
        // (MOVEFILE_REPLACE_EXISTING on Windows).
        std::fs::rename(&tmp_path, path)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
}

/// Encode LF-normalized content with the given encoding and line ending,
/// then write it to disk atomically. `unmappable` is true when characters
/// could not be represented in the target encoding.
#[tauri::command]
fn save_document(
    path: String,
    content: String,
    encoding: String,
    with_bom: bool,
    line_ending: String,
) -> Result<SaveResult, String> {
    let text = encoding::apply_line_ending(&content, &line_ending);
    let (bytes, unmappable) = encoding::encode(&text, &encoding, with_bom)?;
    atomic_write(std::path::Path::new(&path), &bytes)
        .map_err(|e| format!("Failed to write {path}: {e}"))?;
    Ok(SaveResult { unmappable })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // On Windows and Linux, opening an associated file launches a second
    // process; forward its arguments to the running instance instead.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
        let paths = existing_paths_from_args(argv.into_iter());
        if !paths.is_empty() {
            let _ = app.emit("plume://open-files", paths);
        }
    }));

    // Restores window size/position across launches (desktop only).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingFiles(Mutex::new(existing_paths_from_args(
            std::env::args(),
        ))))
        .setup(|app| {
            use tauri::Manager;
            let state = watcher::init(app.handle().clone())?;
            app.manage(state);
            // Built in setup (not Builder::menu) because the menu reads
            // preferences via app.path(), which is unavailable until the
            // path resolver state is managed.
            app.set_menu(menu::build(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("plume://menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            save_document,
            session::load_session,
            session::save_session,
            prefs::load_preferences,
            prefs::save_preferences,
            take_pending_files,
            print_window,
            chunk::read_document_chunk,
            chunk::read_document_chunk_before,
            watcher::watch_file,
            watcher::unwatch_file,
            recent::load_recent_files,
            recent::add_recent_file,
            search::search_in_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS delivers associated files through Apple Events; they can
            // arrive before the frontend is listening, so they are queued in
            // PendingFiles as well as emitted.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                use tauri::Manager;
                let paths: Vec<String> = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                if !paths.is_empty() {
                    _app.state::<PendingFiles>()
                        .0
                        .lock()
                        .unwrap()
                        .extend(paths.clone());
                    let _ = _app.emit("plume://open-files", paths);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{atomic_write, existing_paths_from_args, preview_slice};

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_files() {
        let dir = std::env::temp_dir().join("plume-atomic-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");

        atomic_write(&target, b"first version").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first version");
        atomic_write(&target, "第二版 with 中文".as_bytes()).unwrap();
        assert_eq!(
            std::fs::read(&target).unwrap(),
            "第二版 with 中文".as_bytes()
        );

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("plume-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp files may remain");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("plume-atomic-perms");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("script.sh");

        std::fs::write(&target, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        atomic_write(&target, b"#!/bin/sh\necho updated\n").unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_fails_cleanly_on_missing_directory() {
        let target = std::env::temp_dir()
            .join("plume-no-such-dir")
            .join("nested")
            .join("doc.txt");
        assert!(atomic_write(&target, b"x").is_err());
    }

    #[test]
    fn preview_slice_cuts_at_line_boundary() {
        let bytes = b"line one\nline two\nline three";
        let slice = preview_slice(bytes, 12);
        assert_eq!(slice, b"line one\n");
        // No newline within the budget: keep the raw slice.
        let slice = preview_slice(b"abcdefgh", 4);
        assert_eq!(slice, b"abcd");
        // Small files pass through whole.
        let slice = preview_slice(b"tiny\n", 100);
        assert_eq!(slice, b"tiny\n");
    }

    #[test]
    fn filters_args_to_existing_files() {
        let file = std::env::temp_dir().join("plume-args-test.txt");
        std::fs::write(&file, "x").unwrap();
        let args = vec![
            "plume".to_string(),
            "--flag".to_string(),
            "/no/such/file.txt".to_string(),
            file.to_string_lossy().into_owned(),
        ];
        let paths = existing_paths_from_args(args.into_iter());
        assert_eq!(paths, vec![file.to_string_lossy().into_owned()]);
        std::fs::remove_file(&file).ok();
    }
}

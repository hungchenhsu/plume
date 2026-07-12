mod backup;
mod chunk;
mod encoding;
mod hexdump;
mod menu;
mod prefs;
mod recent;
mod search;
mod session;
mod startup_probe;
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
    written: bool,
}

/// Read a file from disk, decoding with the given encoding label or with
/// automatic detection when `encoding` is `None`. The returned content is
/// LF-normalized; the original line ending is reported in `line_ending`.
///
/// `extension_encoding` is an advisory hint forwarded by the frontend: the
/// encoding its per-extension preferences table maps this file's extension
/// to, if any (resolved from `Preferences::extension_encodings` — see
/// `src/extensionEncodings.ts`). It only takes effect during auto-detection
/// (`encoding: None`); the core decision — BOM first, then confident UTF-8
/// (valid non-ASCII UTF-8 is never reinterpreted by the hint), then the
/// hint if it decodes the bytes without malformed sequences, else the
/// statistical fallback — is made in `encoding::detect_with_extension`,
/// not here or in the frontend.
#[tauri::command]
fn open_document(
    path: String,
    encoding: Option<String>,
    extension_encoding: Option<String>,
) -> Result<OpenedDocument, String> {
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
        None => encoding::decode_auto_with_extension(bytes, extension_encoding.as_deref()),
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

/// Diagnostics evidence never touches raw bytes: `bom` is a formatted
/// description, not the bytes themselves (ARCHITECTURE.md: raw bytes never
/// cross IPC).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionExplanation {
    /// e.g. "UTF-8 BOM (EF BB BF)"; `None` when no BOM was found.
    bom: Option<String>,
    /// chardetng's verdict on the sampled bytes, e.g. "windows-1252".
    detector_verdict: String,
    sampled_bytes: usize,
    total_size: u64,
    /// "{encoding} ({reason})" where reason is "bom" | "extension" |
    /// "detector" | "fallback" — the encoding `open_document`'s
    /// auto-detection would pick, and why.
    would_choose: String,
}

/// Diagnostics sample size: large enough for chardetng to reach a stable
/// verdict, small enough to never require reading a whole large file just
/// to explain a detection.
const EXPLAIN_SAMPLE_BYTES: usize = 64 * 1024;

/// Re-read a bounded prefix of `path` and report the evidence behind the
/// encoding auto-detection would use, without decoding or returning any
/// raw bytes. This is a read-only diagnostics command: it never affects
/// `open_document`'s behavior and reuses `encoding::detect_with_extension`,
/// the same function `decode_auto_with_extension` (and therefore
/// `open_document`) calls, so the two can never disagree for files at or
/// under the sample size — see the `detect_agrees_with_decode_auto_*`
/// tests in `encoding.rs`. `extension_encoding` is the same advisory hint
/// the frontend passes to `open_document` (see there).
#[tauri::command]
fn explain_detection(
    path: String,
    extension_encoding: Option<String>,
) -> Result<DetectionExplanation, String> {
    let total_size = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let sample_len = bytes.len().min(EXPLAIN_SAMPLE_BYTES);
    let sample = &bytes[..sample_len];

    let detection = encoding::detect_with_extension(sample, extension_encoding.as_deref());
    Ok(DetectionExplanation {
        bom: encoding::describe_bom(sample),
        detector_verdict: detection.detector_guess.name().to_string(),
        sampled_bytes: sample_len,
        total_size,
        would_choose: format!("{} ({})", detection.chosen.name(), detection.reason),
    })
}

/// Write bytes atomically: write to a temporary file in the same directory
/// (same filesystem), fsync, then rename over the target. A crash mid-save
/// leaves either the old file or the new one — never a half-written file.
/// Existing file permissions are carried over to the replacement.
pub(crate) fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
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
/// then write it to disk atomically.
///
/// This is a two-phase save. `unmappable` is true when characters could not
/// be represented in the target encoding. When that happens and
/// `allow_lossy` is `false`, nothing is written — the file on disk is left
/// exactly as it was, and the caller must re-invoke with `allow_lossy: true`
/// (after explicit user confirmation) to actually write the lossy bytes.
/// This guarantees a save can never silently overwrite the user's original
/// text with lossy replacement bytes before they've agreed to that trade.
#[tauri::command]
fn save_document(
    path: String,
    content: String,
    encoding: String,
    with_bom: bool,
    line_ending: String,
    allow_lossy: bool,
) -> Result<SaveResult, String> {
    let text = encoding::apply_line_ending(&content, &line_ending);
    let (bytes, unmappable) = encoding::encode(&text, &encoding, with_bom)?;
    if unmappable && !allow_lossy {
        return Ok(SaveResult {
            unmappable: true,
            written: false,
        });
    }
    atomic_write(std::path::Path::new(&path), &bytes)
        .map_err(|e| format!("Failed to write {path}: {e}"))?;
    Ok(SaveResult {
        unmappable,
        written: true,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // As early as possible: the startup probe measures from here.
    startup_probe::mark_process_start();
    startup_probe::checkpoint("run() entered");

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
            startup_probe::checkpoint("setup() completed");
            Ok(())
        })
        .on_page_load(|_window, payload| {
            use tauri::webview::PageLoadEvent;
            match payload.event() {
                PageLoadEvent::Started => startup_probe::checkpoint("on_page_load: Started"),
                PageLoadEvent::Finished => startup_probe::checkpoint("on_page_load: Finished"),
            }
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("plume://menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            explain_detection,
            save_document,
            session::load_session,
            session::save_session,
            prefs::load_preferences,
            prefs::save_preferences,
            menu::sync_theme_menu,
            menu::retitle_menu,
            take_pending_files,
            print_window,
            chunk::read_document_chunk,
            chunk::read_document_chunk_before,
            watcher::watch_file,
            watcher::unwatch_file,
            recent::load_recent_files,
            recent::add_recent_file,
            search::search_in_folder,
            backup::save_backup,
            backup::load_backup,
            backup::delete_backup,
            hexdump::read_hex_dump,
            startup_probe::report_startup_ready
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
    use super::{
        atomic_write, existing_paths_from_args, explain_detection, open_document, preview_slice,
        save_document,
    };

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

    /// Pull the encoding name out of a `"{encoding} ({reason})"` would-choose
    /// string, mirroring the parsing the frontend does.
    fn would_choose_encoding(would_choose: &str) -> &str {
        would_choose.split(" (").next().unwrap_or(would_choose)
    }

    /// `explain_detection`'s `wouldChoose` must agree with what
    /// `open_document`'s auto-detection actually picks, for every scenario
    /// the diagnostics popup is meant to explain — including when both are
    /// given the same per-extension encoding hint. All fixtures here are
    /// well under the 64 KB sample cap, so the sample is the whole file and
    /// the two commands see identical bytes.
    fn assert_explain_matches_open_with_ext(
        bytes: &[u8],
        dir_name: &str,
        ext_encoding: Option<&str>,
    ) {
        let dir = std::env::temp_dir().join(dir_name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, bytes).unwrap();
        let path = file.to_string_lossy().into_owned();
        let ext = ext_encoding.map(str::to_string);

        let opened = open_document(path.clone(), None, ext.clone()).unwrap();
        let explained = explain_detection(path, ext).unwrap();

        assert_eq!(
            would_choose_encoding(&explained.would_choose),
            opened.encoding,
            "explain_detection and open_document disagree for {dir_name}"
        );
        assert_eq!(explained.sampled_bytes, bytes.len());
        assert_eq!(explained.total_size, bytes.len() as u64);

        std::fs::remove_dir_all(&dir).ok();
    }

    fn assert_explain_matches_open(bytes: &[u8], dir_name: &str) {
        assert_explain_matches_open_with_ext(bytes, dir_name, None);
    }

    #[test]
    fn explain_detection_agrees_with_open_utf8_bom() {
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        assert_explain_matches_open(&bytes, "plume-explain-utf8-bom");

        let dir = std::env::temp_dir().join("plume-explain-utf8-bom-evidence");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, bytes).unwrap();
        let explained = explain_detection(file.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(explained.bom.as_deref(), Some("UTF-8 BOM (EF BB BF)"));
        assert!(explained.would_choose.ends_with("(bom)"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn explain_detection_agrees_with_open_utf16le_bom() {
        let (bytes, _) = crate::encoding::encode("hi", "UTF-16LE", true).unwrap();
        assert_explain_matches_open(&bytes, "plume-explain-utf16le-bom");
    }

    #[test]
    fn explain_detection_agrees_with_open_plain_ascii() {
        let bytes = b"hello world, this is plain ascii text with no accents";
        assert_explain_matches_open(bytes, "plume-explain-ascii");

        let dir = std::env::temp_dir().join("plume-explain-ascii-evidence");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, bytes).unwrap();
        let explained = explain_detection(file.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(explained.bom, None);
        assert!(explained.would_choose.ends_with("(detector)"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn explain_detection_agrees_with_open_big5_sample() {
        let text =
            "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";
        let (bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        assert_explain_matches_open(&bytes, "plume-explain-big5");
    }

    #[test]
    fn explain_detection_agrees_with_open_empty_file() {
        assert_explain_matches_open(&[], "plume-explain-empty");

        let dir = std::env::temp_dir().join("plume-explain-empty-evidence");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, []).unwrap();
        let explained = explain_detection(file.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(explained.bom, None);
        assert!(explained.would_choose.ends_with("(fallback)"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn explain_detection_reports_missing_file_as_error() {
        let path = std::env::temp_dir()
            .join("plume-explain-does-not-exist.txt")
            .to_string_lossy()
            .into_owned();
        assert!(explain_detection(path, None).is_err());
    }

    /// With a per-extension hint, the diagnostics command and the open
    /// command must still agree — both when the hint is honored (Big5
    /// bytes, Big5 hint) and when it is rejected (UTF-8 bytes, Big5 hint).
    #[test]
    fn explain_detection_agrees_with_open_under_extension_hint() {
        let text =
            "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";
        let (big5_bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        assert_explain_matches_open_with_ext(&big5_bytes, "plume-explain-ext-big5", Some("Big5"));
        assert_explain_matches_open_with_ext(
            text.as_bytes(),
            "plume-explain-ext-utf8-mismatch",
            Some("Big5"),
        );
        // Short valid UTF-8 that is byte-valid as Big5 (the UTF-8 gate
        // case): both commands must agree it stays UTF-8.
        assert_explain_matches_open_with_ext(
            "測試".as_bytes(),
            "plume-explain-ext-short-utf8",
            Some("Big5"),
        );
        // BOM still wins over the hint at the command level too.
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        assert_explain_matches_open_with_ext(&bytes, "plume-explain-ext-bom", Some("Big5"));
    }

    /// End-to-end round trip through the real commands and the disk, with a
    /// per-extension preference in play: a Big5 .txt file opened with a
    /// Big5 extension hint, saved, and reopened must keep both its content
    /// and its Big5 encoding byte-for-byte.
    #[test]
    fn open_save_reopen_round_trips_big5_via_extension_hint() {
        let text = "中文編碼偵測測試，這是繁體中文範例文字。\n第二行內容。\n";
        let (original_bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);

        let dir = std::env::temp_dir().join("plume-ext-roundtrip-big5");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, &original_bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), None, Some("Big5".into())).unwrap();
        assert_eq!(opened.encoding, "Big5");
        assert_eq!(opened.content, text);
        assert!(!opened.malformed);
        assert_eq!(opened.line_ending, "LF");

        let saved = save_document(
            path.clone(),
            opened.content.clone(),
            opened.encoding.clone(),
            opened.had_bom,
            opened.line_ending.clone(),
            false,
        )
        .unwrap();
        assert!(!saved.unmappable);
        assert!(saved.written);
        assert_eq!(std::fs::read(&file).unwrap(), original_bytes);

        let reopened = open_document(path, None, Some("Big5".into())).unwrap();
        assert_eq!(reopened.encoding, "Big5");
        assert_eq!(reopened.content, text);
        assert!(!reopened.malformed);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The mirror-image safety case on disk: a legitimate multi-byte UTF-8
    /// .txt file must not be opened as Big5 mojibake just because the
    /// user's extension table says .txt = Big5. It opens clean as UTF-8 and
    /// survives a save/reopen cycle unchanged.
    #[test]
    fn open_save_reopen_keeps_utf8_despite_wrong_extension_hint() {
        let text = "中文編碼偵測測試，這是繁體中文範例文字。\n";
        let original_bytes = text.as_bytes().to_vec();

        let dir = std::env::temp_dir().join("plume-ext-roundtrip-utf8-mismatch");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, &original_bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), None, Some("Big5".into())).unwrap();
        assert_eq!(opened.encoding, "UTF-8");
        assert_eq!(opened.content, text);
        assert!(!opened.malformed);

        let saved = save_document(
            path.clone(),
            opened.content.clone(),
            opened.encoding.clone(),
            opened.had_bom,
            opened.line_ending.clone(),
            false,
        )
        .unwrap();
        assert!(!saved.unmappable);
        assert!(saved.written);
        assert_eq!(std::fs::read(&file).unwrap(), original_bytes);

        let reopened = open_document(path, None, Some("Big5".into())).unwrap();
        assert_eq!(reopened.encoding, "UTF-8");
        assert_eq!(reopened.content, text);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #64: saving content with characters unmappable in the target
    /// encoding must never touch disk until the caller opts in via
    /// `allow_lossy`. This is the core data-integrity assertion — comparing
    /// the bytes on disk to the pre-save original, not just checking the
    /// return value.
    #[test]
    fn save_document_refuses_lossy_write_without_consent() {
        let dir = std::env::temp_dir().join("plume-save-lossy-refuse");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");

        let original = "hello 🚀 世界".as_bytes().to_vec();
        std::fs::write(&target, &original).unwrap();
        let path = target.to_string_lossy().into_owned();

        let result = save_document(
            path,
            "hello 🚀 世界".to_string(),
            "Big5".to_string(),
            false,
            "LF".to_string(),
            false,
        )
        .unwrap();

        assert!(result.unmappable);
        assert!(!result.written);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            original,
            "refused save must leave the original bytes on disk untouched"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The consenting counterpart: once the caller re-invokes with
    /// `allow_lossy: true`, the write proceeds and the bytes on disk become
    /// the lossy Big5 encoding of the content.
    #[test]
    fn save_document_writes_lossy_with_consent() {
        let dir = std::env::temp_dir().join("plume-save-lossy-consent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");

        let original = "hello 🚀 世界".as_bytes().to_vec();
        std::fs::write(&target, &original).unwrap();
        let path = target.to_string_lossy().into_owned();

        let result = save_document(
            path,
            "hello 🚀 世界".to_string(),
            "Big5".to_string(),
            false,
            "LF".to_string(),
            true,
        )
        .unwrap();

        assert!(result.unmappable);
        assert!(result.written);
        let on_disk = std::fs::read(&target).unwrap();
        assert_ne!(on_disk, original);
        let (expected_bytes, unmappable) =
            crate::encoding::encode("hello 🚀 世界", "Big5", false).unwrap();
        assert!(unmappable);
        assert_eq!(on_disk, expected_bytes);

        std::fs::remove_dir_all(&dir).ok();
    }
}

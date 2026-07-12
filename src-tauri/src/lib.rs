mod backup;
mod batch;
mod chunk;
mod comparepreview;
mod encoding;
mod hexdump;
mod menu;
mod mojibake;
mod prefs;
mod recent;
mod search;
mod session;
mod startup_probe;
mod store;
mod watcher;

use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
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
///
/// `utf16` names the byte order when `bytes` is UTF-16 (see
/// `encoding::utf16_variant`), decided by the caller from the same signal
/// the real decode will use (explicit label, else BOM) *before* decoding
/// happens — this function only ever sees raw bytes. UTF-16's LF is the
/// two-byte code unit `0A 00` (LE) or `00 0A` (BE); the plain `None` path
/// below searches for a lone `0x0A` byte, which is correct for UTF-8 and
/// other byte-oriented encodings but — for UTF-16 — lands on only half of
/// that code unit, handing the decoder an odd-length slice that reports
/// `malformed` even though nothing in the file is actually corrupt (issue
/// #61). When `utf16` is `Some`, the cut point is instead the last
/// code-unit-aligned newline pair (even byte offset) within the window, or
/// the window rounded down to even length if none is found — the returned
/// slice is always even-length and never splits a code unit; the fallback
/// additionally drops a trailing high surrogate so a 4-byte character is
/// never split either, even at the cost of losing line alignment in that
/// rare no-newline-in-window case.
fn preview_slice(bytes: &[u8], max: usize, utf16: Option<encoding::Utf16Variant>) -> &[u8] {
    if bytes.len() <= max {
        return bytes;
    }
    let Some(variant) = utf16 else {
        let slice = &bytes[..max];
        return match slice.iter().rposition(|&b| b == b'\n') {
            Some(pos) => &slice[..=pos],
            None => slice,
        };
    };
    // Even-length window: never leave a dangling half code unit at the
    // tail, regardless of whether `max` itself is even.
    let even = max & !1;
    let window = &bytes[..even];
    let (b0, b1) = match variant {
        encoding::Utf16Variant::Le => (b'\n', 0u8),
        encoding::Utf16Variant::Be => (0u8, b'\n'),
    };
    let cut = window
        .chunks_exact(2)
        .rposition(|pair| pair[0] == b0 && pair[1] == b1)
        .map(|i| (i + 1) * 2);
    let mut end = cut.unwrap_or(even);
    // The no-newline fallback is code-unit aligned but could still split a
    // surrogate pair (a 4-byte character): a trailing high surrogate
    // decodes as U+FFFD and flags the preview malformed — the exact false
    // warning this function exists to avoid. Drop a dangling high
    // surrogate; a newline cut never needs this (newlines are complete
    // characters).
    if cut.is_none() && end >= 2 {
        let unit = match variant {
            encoding::Utf16Variant::Le => u16::from_le_bytes([window[end - 2], window[end - 1]]),
            encoding::Utf16Variant::Be => u16::from_be_bytes([window[end - 2], window[end - 1]]),
        };
        if (0xD800..=0xDBFF).contains(&unit) {
            end -= 2;
        }
    }
    &window[..end]
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
///
/// Files over `LARGE_FILE_THRESHOLD` are read as a bounded prefix instead
/// of the whole file — at most `PREVIEW_BYTES` end up in `content` — so
/// opening a multi-GB file costs `O(PREVIEW_BYTES)` I/O and memory, not
/// `O(file size)` (issue #59). `total_size` and the `truncated` decision
/// come from the `std::fs::metadata` snapshot taken at the top of this
/// function, before the file is reopened for the bounded read; if the file
/// is replaced, grown, or shrunk in that window, `total_size` can end up
/// stale, but the read itself stays bounded by `take` regardless of what
/// the file has become by the time it runs — an accepted race, not a
/// correctness guarantee for a file mutated mid-open.
#[tauri::command]
fn open_document(
    path: String,
    encoding: Option<String>,
    extension_encoding: Option<String>,
) -> Result<OpenedDocument, String> {
    let total_size = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    let truncated = total_size > LARGE_FILE_THRESHOLD;
    let raw = if truncated {
        // Bounded read: at most PREVIEW_BYTES + 1 bytes are ever read from
        // disk, never the whole file. The extra sentinel byte is only
        // present in `raw` when the file has more data past the window; it
        // is what lets the unmodified `preview_slice` below tell "the file
        // continues past here" from "the window is the whole file" and cut
        // at the last line boundary exactly as it would if handed the full
        // file, without this call ever materializing more than
        // ~PREVIEW_BYTES in memory.
        let file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
        // Capacity matches the take limit: one byte short would force a
        // 2 MB doubling realloc when the sentinel byte lands.
        let mut buf = Vec::with_capacity(PREVIEW_BYTES + 1);
        file.take(PREVIEW_BYTES as u64 + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        buf
    } else {
        // Small files: one full read is the right tradeoff here (a single
        // syscall, no window bookkeeping).
        std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?
    };
    let (bytes, next_offset) = if truncated {
        let utf16 = encoding::utf16_variant(&raw, encoding.as_deref());
        let slice = preview_slice(&raw, PREVIEW_BYTES, utf16);
        (slice, Some(slice.len() as u64))
    } else {
        (&raw[..], None)
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
///
/// The bound is enforced on the disk read itself via `Read::take`, not by
/// reading the whole file and slicing the sample out in memory afterward
/// — so explaining a detection on a multi-GB file costs
/// `O(EXPLAIN_SAMPLE_BYTES)` I/O, matching what this comment already
/// promised (issue #59).
#[tauri::command]
fn explain_detection(
    path: String,
    extension_encoding: Option<String>,
) -> Result<DetectionExplanation, String> {
    let total_size = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let mut sample = Vec::with_capacity(EXPLAIN_SAMPLE_BYTES);
    file.take(EXPLAIN_SAMPLE_BYTES as u64)
        .read_to_end(&mut sample)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    let sample_len = sample.len();

    let detection = encoding::detect_with_extension(&sample, extension_encoding.as_deref());
    Ok(DetectionExplanation {
        bom: encoding::describe_bom(&sample),
        detector_verdict: detection.detector_guess.name().to_string(),
        sampled_bytes: sample_len,
        total_size,
        would_choose: format!("{} ({})", detection.chosen.name(), detection.reason),
    })
}

/// Process-local counter mixed into temporary-file names (alongside a
/// timestamp) so that two [`create_tmp_exclusive`] calls in the same
/// process can never produce the same candidate, even within the same
/// nanosecond.
static TMP_NAME_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Build one same-directory temporary-file candidate path for `file_name`.
/// The name mixes the process id, the current time's subsecond
/// nanoseconds, and [`TMP_NAME_COUNTER`], so it cannot be guessed from
/// public information alone the way a bare `.{file_name}.plume-tmp-{pid}`
/// name could (issue #60). Unpredictability is defense in depth, not the
/// actual safety guarantee — [`open_exclusive`] is what makes a guessed or
/// colliding name safe.
fn tmp_candidate_path(dir: &std::path::Path, file_name: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let counter = TMP_NAME_COUNTER.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(
        ".{file_name}.plume-tmp-{}-{nanos}-{counter}",
        std::process::id()
    ))
}

/// Open `path` for writing only if it does not already exist:
/// `O_CREAT | O_EXCL` on Unix, `CREATE_NEW` on Windows. If `path` already
/// exists — including as a symlink, dangling or not — this fails with
/// `AlreadyExists` instead of following it. That is the actual fix for
/// issue #60: an attacker who pre-plants a symlink at a path we are about
/// to use as a temp file can no longer redirect our write to the
/// symlink's target, because we never open through it in the first place.
fn open_exclusive(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// Create a same-directory temporary file with an unpredictable name,
/// refusing to follow any symlink already occupying a candidate path (see
/// [`open_exclusive`]). Retries up to 16 times on `AlreadyExists` — a
/// genuine name collision and a pre-planted symlink look identical from
/// here, and both are handled the same way: try the next unpredictable
/// candidate. Any other error is returned immediately. On exhausting all
/// attempts, returns the last `AlreadyExists` error. Returns the open file
/// together with the path it was created at, since the caller needs the
/// path for `rename` and for cleanup on a later failure.
fn create_tmp_exclusive(
    dir: &std::path::Path,
    file_name: &str,
) -> std::io::Result<(std::fs::File, std::path::PathBuf)> {
    let mut last_err =
        std::io::Error::new(std::io::ErrorKind::AlreadyExists, "no candidate attempted");
    for _ in 0..16 {
        let candidate = tmp_candidate_path(dir, file_name);
        match open_exclusive(&candidate) {
            Ok(file) => return Ok((file, candidate)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last_err = e,
            Err(e) => return Err(e),
        }
    }
    Err(last_err)
}

/// Write bytes atomically: create a temporary file in the same directory
/// (same filesystem) — with an unpredictable name and exclusive create, so
/// the temp-file step can never be redirected through a pre-planted
/// symlink (see [`create_tmp_exclusive`], [`open_exclusive`]; issue #60) —
/// write it, fsync, then rename over the target. A crash mid-save leaves
/// either the old file or the new one — never a half-written file.
/// Existing file permissions are carried over to the replacement.
pub(crate) fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let (mut tmp, tmp_path) = create_tmp_exclusive(dir, &file_name)?;

    let result = (|| {
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
            backup::list_backups,
            hexdump::read_hex_dump,
            mojibake::detect_mojibake,
            mojibake::apply_mojibake_repair,
            batch::scan_batch_conversion,
            batch::execute_batch_conversion,
            comparepreview::preview_two_encodings,
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
        save_document, tmp_candidate_path, EXPLAIN_SAMPLE_BYTES, LARGE_FILE_THRESHOLD,
        PREVIEW_BYTES,
    };
    // Only the unix-gated symlink test uses this; an unconditional import
    // is an unused-import error under -D warnings on Windows.
    #[cfg(unix)]
    use super::open_exclusive;

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

    /// Issue #60, layer 1 — attack the public `atomic_write` behavior
    /// directly. Before the fix, `atomic_write` built its temp file path
    /// from only the target file name and process id
    /// (`.{file_name}.plume-tmp-{pid}`), then opened it with
    /// `File::create`, which follows symlinks. A local attacker who can
    /// write into the save directory could pre-plant a symlink at that
    /// exact, guessable path pointing at any other file they can write
    /// (`victim.txt` here), and `atomic_write` would write the new
    /// document's bytes straight through the symlink into the victim
    /// file, then `rename` the symlink itself over the real save target —
    /// a successful-looking save that silently clobbered an unrelated
    /// file. This test pre-plants that exact symlink and asserts the
    /// victim's content survives the save untouched. Against the
    /// unfixed implementation this assertion fails (the victim is
    /// overwritten with the new document's bytes) — that is the
    /// failing-test-first red. After the fix this passes because
    /// `atomic_write` never reuses that predictable name; the
    /// exclusive-create guarantee that also protects a name collision is
    /// locked separately by `tmp_file_creation_refuses_preexisting_symlink`.
    #[cfg(unix)]
    #[test]
    fn atomic_write_refuses_preplanted_symlink_at_predictable_tmp_path() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("plume-atomic-symlink-attack");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let victim = dir.join("victim.txt");
        std::fs::write(&victim, b"victim data").unwrap();

        let target = dir.join("doc.txt");
        // The predictable temp path the pre-fix implementation used:
        // `.{file_name}.plume-tmp-{pid}`, no randomness at all.
        let legacy_tmp_path = dir.join(format!(".doc.txt.plume-tmp-{}", std::process::id()));
        symlink(&victim, &legacy_tmp_path).unwrap();

        let save_result = atomic_write(&target, b"attacker-controlled new content");

        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"victim data",
            "atomic_write must never write through a pre-planted symlink at a \
             predictable temp path onto an unrelated file"
        );
        assert!(
            save_result.is_ok(),
            "the save itself must still succeed, via an unpredictable candidate \
             that the attacker could not have pre-occupied"
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"attacker-controlled new content"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #60, layer 2 — the unit-level guarantee that actually closes
    /// the hole: opening a temp-file candidate must refuse to follow a
    /// symlink already sitting at that path, rather than silently writing
    /// through it. This is the same open call `create_tmp_exclusive` uses
    /// for every candidate.
    #[cfg(unix)]
    #[test]
    fn tmp_file_creation_refuses_preexisting_symlink() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("plume-open-exclusive-symlink");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let victim = dir.join("victim.txt");
        std::fs::write(&victim, b"victim data").unwrap();
        let candidate = dir.join("preplanted-link");
        symlink(&victim, &candidate).unwrap();

        match open_exclusive(&candidate) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            other => panic!(
                "expected Err(AlreadyExists) for a path already occupied by a \
                 symlink, got {other:?}"
            ),
        }
        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"victim data",
            "the symlink must not have been followed — victim content must be untouched"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #60: two candidate names generated back-to-back for the same
    /// (dir, file_name) must differ (the counter component guarantees it).
    /// This locks uniqueness only — safety against a pre-planted path does
    /// not rest on name entropy but on `open_exclusive` refusing to open
    /// anything that already exists.
    #[test]
    fn tmp_candidates_are_unique() {
        let dir = std::env::temp_dir().join("plume-tmp-candidate-uniqueness");
        let first = tmp_candidate_path(&dir, "doc.txt");
        let second = tmp_candidate_path(&dir, "doc.txt");
        assert_ne!(
            first, second,
            "consecutive candidates for the same (dir, file_name) must differ"
        );
    }

    #[test]
    fn preview_slice_cuts_at_line_boundary() {
        let bytes = b"line one\nline two\nline three";
        let slice = preview_slice(bytes, 12, None);
        assert_eq!(slice, b"line one\n");
        // No newline within the budget: keep the raw slice.
        let slice = preview_slice(b"abcdefgh", 4, None);
        assert_eq!(slice, b"abcd");
        // Small files pass through whole.
        let slice = preview_slice(b"tiny\n", 100, None);
        assert_eq!(slice, b"tiny\n");
    }

    /// Issue #61 regression lock: the `None` path (non-UTF-16 preview
    /// cutting) must behave exactly as it did before the UTF-16 fix —
    /// including for multi-byte UTF-8 content, which
    /// `preview_slice_cuts_at_line_boundary` above does not exercise. UTF-8
    /// continuation and lead bytes are always >= 0x80, so a raw `0x0A`
    /// search never lands inside a multi-byte sequence; this pins that
    /// invariant stays true after adding the `utf16` parameter.
    #[test]
    fn preview_slice_plain_utf8_behavior_unchanged() {
        let bytes = "第一行\n第二行\n第三行".as_bytes();
        let cut_after_first_line = "第一行\n".len();
        let slice = preview_slice(bytes, cut_after_first_line + 2, None);
        assert_eq!(slice, "第一行\n".as_bytes());

        let slice = preview_slice(b"abcdefgh", 4, None);
        assert_eq!(slice, b"abcd");

        let slice = preview_slice(b"tiny\n", 100, None);
        assert_eq!(slice, b"tiny\n");
    }

    /// Issue #61. UTF-16LE's LF is the two-byte code unit `0A 00`; a raw
    /// `0x0A` search (the `None` path) finds the low byte but
    /// `slice[..=pos]` then excludes the high byte right after it, always
    /// producing an odd-length cut whenever a newline is found at all —
    /// this is not a rare edge case, it is what happens on essentially
    /// every real UTF-16LE large-file preview. `max=37` here lands exactly
    /// one byte past the third newline's `0x0A` and one byte before its
    /// `0x00` partner. Before the fix this test is red: the unmodified
    /// raw-byte search returns all 37 bytes (odd length, a dangling
    /// `0x0A`). After the fix it must fall back to the last *complete*
    /// pair reachable in the even-rounded window (end of "line2\n" at
    /// offset 24) rather than keep a split code unit.
    #[test]
    fn preview_slice_utf16le_cuts_at_code_unit_newline() {
        let text = "line1\nline2\nline3\nline4\n";
        let (bytes, _) = crate::encoding::encode(text, "UTF-16LE", true).unwrap();
        assert_eq!(
            bytes.len(),
            50,
            "fixture byte layout must match the offsets this test hand-verifies"
        );

        let slice = preview_slice(&bytes, 37, Some(crate::encoding::Utf16Variant::Le));

        assert_eq!(slice, &bytes[..26]);
        assert_eq!(
            slice.len() % 2,
            0,
            "utf16 preview slice must be even-length"
        );
        assert_eq!(
            &slice[slice.len() - 2..],
            &[0x0A, 0x00],
            "must end on a full LE newline code unit, never split"
        );
    }

    /// Issue #61. No newline anywhere in the UTF-16LE window: the fixed
    /// function must still fall back to an even-length slice
    /// (`max & !1`), not the raw `max` byte count. Before the fix, the
    /// unmodified raw-byte search also finds no `0x0A` match and returns
    /// the odd-length raw slice unchanged (`max` itself is chosen odd
    /// here specifically so the two fallbacks disagree).
    #[test]
    fn preview_slice_utf16le_no_newline_falls_back_even() {
        let text = "abcdefghij".repeat(20); // no '\n' anywhere
        let (bytes, _) = crate::encoding::encode(&text, "UTF-16LE", true).unwrap();
        assert!(bytes.len() > 101);

        let slice = preview_slice(&bytes, 101, Some(crate::encoding::Utf16Variant::Le));

        assert_eq!(
            slice.len(),
            100,
            "an odd max must round down to an even length"
        );
        assert_eq!(slice, &bytes[..100]);
    }

    /// Issue #61, adversarial-review follow-up: the no-newline even-length
    /// fallback is code-unit aligned but could still split a *surrogate
    /// pair* (a 4-byte character), leaving a dangling high surrogate that
    /// decodes as U+FFFD and re-creates the exact false malformed warning
    /// this fix exists to remove. Three emoji (4 bytes each in UTF-16)
    /// after a 2-byte BOM put every pair boundary at `offset % 4 == 2`, so
    /// an even cut at 8 lands mid-emoji — the fallback must retreat to 6.
    #[test]
    fn preview_slice_utf16_no_newline_never_splits_surrogate_pair() {
        let (bytes, _) = crate::encoding::encode("🚀🚀🚀", "UTF-16LE", true).unwrap();
        assert_eq!(bytes.len(), 14, "BOM(2) + 3 × 4-byte emoji");
        let slice = preview_slice(&bytes, 8, Some(crate::encoding::Utf16Variant::Le));
        assert_eq!(
            slice.len(),
            6,
            "must retreat past the dangling high surrogate"
        );
        let decoded = crate::encoding::decode_with(slice, "UTF-16LE").unwrap();
        assert!(!decoded.malformed);

        let (bytes, _) = crate::encoding::encode("🚀🚀🚀", "UTF-16BE", true).unwrap();
        let slice = preview_slice(&bytes, 8, Some(crate::encoding::Utf16Variant::Be));
        assert_eq!(slice.len(), 6, "BE mirror must retreat identically");
        let decoded = crate::encoding::decode_with(slice, "UTF-16BE").unwrap();
        assert!(!decoded.malformed);
    }

    /// Issue #61, BE counterpart of
    /// `preview_slice_utf16le_cuts_at_code_unit_newline`: UTF-16BE's LF is
    /// `00 0A`, and the fix must cut on the same code-unit-aligned pair
    /// search mirrored for the opposite byte order.
    #[test]
    fn preview_slice_utf16be_cuts_at_code_unit_newline() {
        let text = "line1\nline2\nline3\nline4\n";
        let (bytes, _) = crate::encoding::encode(text, "UTF-16BE", true).unwrap();
        assert_eq!(
            bytes.len(),
            50,
            "fixture byte layout must match the offsets this test hand-verifies"
        );

        let slice = preview_slice(&bytes, 37, Some(crate::encoding::Utf16Variant::Be));

        assert_eq!(slice, &bytes[..26]);
        assert_eq!(
            slice.len() % 2,
            0,
            "utf16 preview slice must be even-length"
        );
        assert_eq!(
            &slice[slice.len() - 2..],
            &[0x00, 0x0A],
            "must end on a full BE newline code unit, never split"
        );
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

    /// Issue #47: an even-length, pure-ASCII sample with a UTF-16
    /// extension hint must be rejected by both commands identically.
    /// `explain_detection` and `open_document` share `detect_with_extension`
    /// so they are consistent by construction, but this locks the new
    /// branch the same way `explain_detection_agrees_with_open_under_extension_hint`
    /// locks the existing ones — a regression that made the two commands
    /// call the guard differently would show up here even though the
    /// hijack itself is covered directly in `encoding.rs`.
    #[test]
    fn explain_detection_agrees_with_open_under_utf16_extension_hint() {
        assert_explain_matches_open_with_ext(
            b"ab\ncd\n",
            "plume-explain-ext-utf16-ascii",
            Some("UTF-16LE"),
        );
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

    /// Build a large-file fixture: `n` lines of `"line {i}\n"`, generated
    /// in one pass and written to disk in a single `std::fs::write` call
    /// (not line-by-line), so fixture setup itself stays fast. Returns the
    /// file path and the exact bytes written, so a test can compute an
    /// expected value from the same content without a second disk read.
    fn write_line_fixture(dir_name: &str, n: u32) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(dir_name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.txt");
        let data: String = (0..n).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&file, data.as_bytes()).unwrap();
        (file, data)
    }

    /// Issue #59. Memory usage cannot be observed from a unit test, so this
    /// pins the *behavior* the bounded read must produce instead of the
    /// bound itself: for a file over `LARGE_FILE_THRESHOLD`, `open_document`
    /// reports `truncated`, the returned content never exceeds
    /// `PREVIEW_BYTES` on the wire, `next_offset` is a *byte* offset that
    /// matches the content's own UTF-8 byte length exactly (large-file
    /// offsets are bytes, never chars — see judgment-overlay.md), and
    /// `total_size` reports the real file size. The sharper regression
    /// lock against the pre-fix full-read code path — the one that would
    /// actually catch an off-by-one in the bounded read — is
    /// `open_document_large_file_agrees_with_full_read_prefix` below; this
    /// test's content assertion is a lighter, independent check computed
    /// straight from the in-memory fixture rather than a second file read.
    #[test]
    fn open_document_large_file_is_bounded_preview() {
        let (file, data) = write_line_fixture("plume-large-file-bounded-preview", 1_000_000);
        assert!(
            data.len() as u64 > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, None).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert_eq!(opened.total_size, data.len() as u64);
        let content_bytes = opened.content.as_bytes();
        assert!(
            content_bytes.len() <= PREVIEW_BYTES,
            "preview content must never exceed PREVIEW_BYTES"
        );
        assert_eq!(
            opened.next_offset,
            Some(content_bytes.len() as u64),
            "next_offset must be the byte offset right after the previewed content"
        );

        // Independent check: the preview must equal decoding the first
        // PREVIEW_BYTES of the fixture's own in-memory bytes, cut at the
        // last line boundary by the same (unmodified) `preview_slice`.
        let expected_slice = preview_slice(data.as_bytes(), PREVIEW_BYTES, None);
        assert_eq!(opened.content, std::str::from_utf8(expected_slice).unwrap());

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #59, regression lock. Builds one large fixture and compares
    /// `open_document`'s bounded-read content against content computed the
    /// pre-fix way for the identical bytes: read the whole file, then apply
    /// the same `preview_slice` + `decode_auto_with_extension` the command
    /// itself uses. A bounded implementation that reads the wrong window,
    /// or fails to cut at the same line boundary as the full-read path
    /// (the off-by-one this test exists to catch), produces different
    /// content or a different `next_offset` here.
    #[test]
    fn open_document_large_file_agrees_with_full_read_prefix() {
        let (file, _) = write_line_fixture("plume-large-file-prefix-agreement", 1_000_000);
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, None).unwrap();

        let full = std::fs::read(&file).unwrap();
        assert!(full.len() as u64 > LARGE_FILE_THRESHOLD);
        let reference_slice = preview_slice(&full, PREVIEW_BYTES, None);
        let reference_decoded = crate::encoding::decode_auto_with_extension(reference_slice, None);
        let reference_content = crate::encoding::normalize_to_lf(&reference_decoded.content);

        assert_eq!(opened.content, reference_content);
        assert_eq!(opened.encoding, reference_decoded.encoding);
        assert_eq!(opened.next_offset, Some(reference_slice.len() as u64));

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Build a large UTF-16LE fixture: `n` lines of `"line {i}\n"`,
    /// generated as a single `String` in one pass (mirrors
    /// `write_line_fixture`'s "build the string once, one disk write"
    /// shape, so fixture setup stays fast even though UTF-16 roughly
    /// doubles the byte count per character) and encoded to UTF-16LE with
    /// one `encoding::encode` call. `with_bom` toggles the UTF-16LE BOM,
    /// so callers can exercise the BOM-sniff and explicit-label branches
    /// of `encoding::utf16_variant` separately (issue #61). Returns the
    /// file path.
    fn write_utf16le_line_fixture(dir_name: &str, n: u32, with_bom: bool) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(dir_name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big16.txt");
        let data: String = (0..n).map(|i| format!("line {i}\n")).collect();
        let (bytes, unmappable) = crate::encoding::encode(&data, "UTF-16LE", with_bom).unwrap();
        assert!(
            !unmappable,
            "UTF-16 encoding never reports unmappable characters"
        );
        std::fs::write(&file, &bytes).unwrap();
        file
    }

    /// Issue #61. A UTF-16LE file with a BOM, well over
    /// `LARGE_FILE_THRESHOLD`, must open its bounded preview without ever
    /// reporting `malformed`: the preview cut point must land on a real
    /// code-unit boundary, never mid `0A 00` newline pair. Before the fix
    /// this test is red — the raw-byte `preview_slice` this replaced
    /// corrupts essentially every such file (an odd-length slice handed to
    /// the UTF-16 decoder reports at least one replacement character) even
    /// though nothing on disk is actually damaged.
    #[test]
    fn open_document_large_utf16le_preview_not_malformed() {
        let file = write_utf16le_line_fixture("plume-large-utf16le-bom-preview", 600_000, true);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, None).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert_eq!(opened.encoding, "UTF-16LE");
        assert!(opened.had_bom);
        assert!(
            !opened.malformed,
            "a structurally valid UTF-16LE file must never report malformed"
        );
        assert!(
            opened.content.ends_with('\n'),
            "the preview must end on a full line, not mid line"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "no replacement characters may appear when nothing is actually corrupt"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #61, explicit-encoding variant: no BOM, reopened via the
    /// explicit `encoding` parameter (as the frontend does when the user
    /// picks an encoding from the menu) instead of auto-detection — this
    /// exercises the explicit-label branch of `encoding::utf16_variant`
    /// rather than the BOM-sniff branch.
    #[test]
    fn open_document_large_utf16le_explicit_reopen_not_malformed() {
        let file =
            write_utf16le_line_fixture("plume-large-utf16le-explicit-reopen", 600_000, false);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, Some("UTF-16LE".to_string()), None).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert_eq!(opened.encoding, "UTF-16LE");
        assert!(!opened.had_bom, "fixture has no BOM");
        assert!(
            !opened.malformed,
            "a structurally valid UTF-16LE file must never report malformed"
        );
        assert!(
            opened.content.ends_with('\n'),
            "the preview must end on a full line, not mid line"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "no replacement characters may appear when nothing is actually corrupt"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #59. `explain_detection` must sample a bounded prefix from
    /// disk (not the whole file) for files above `EXPLAIN_SAMPLE_BYTES`;
    /// its doc comment already promised "a bounded prefix" — this locks
    /// the implementation to that promise. `sampled_bytes` must be exactly
    /// the sample cap, and the detection evidence must match calling
    /// `encoding::detect_with_extension` directly on the same first
    /// `EXPLAIN_SAMPLE_BYTES` bytes.
    #[test]
    fn explain_detection_large_file_samples_bounded() {
        let (file, data) = write_line_fixture("plume-explain-large-sample", 14_000);
        assert!(
            data.len() > EXPLAIN_SAMPLE_BYTES,
            "fixture must exceed the diagnostics sample size"
        );
        let path = file.to_string_lossy().into_owned();

        let explained = explain_detection(path, None).unwrap();

        assert_eq!(explained.sampled_bytes, EXPLAIN_SAMPLE_BYTES);
        assert_eq!(explained.total_size, data.len() as u64);

        let expected =
            crate::encoding::detect_with_extension(&data.as_bytes()[..EXPLAIN_SAMPLE_BYTES], None);
        assert_eq!(explained.detector_verdict, expected.detector_guess.name());
        assert_eq!(
            explained.would_choose,
            format!("{} ({})", expected.chosen.name(), expected.reason)
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }
}

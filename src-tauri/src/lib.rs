mod backup;
mod batch;
mod charinspect;
mod chunk;
mod comparepreview;
mod encoding;
mod fsguard;
// Fuzz-only content (PRNG, representable-text generators, and the fuzz
// tests themselves) -- nothing in this module is used outside `cargo
// test`, so the whole file is gated here rather than per-item.
#[cfg(test)]
mod fuzz_roundtrip;
mod hexdump;
mod linebreak;
mod lineindex;
mod menu;
mod mojibake;
mod normalize;
mod prefs;
mod recent;
mod search;
mod session;
mod startup_probe;
mod store;
mod streamreplace;
mod watcher;

use fsguard::Fingerprint;
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
    /// Metadata snapshot of the file as it was at open time, opaque to the
    /// frontend (see `fsguard.rs`). `None` only when the snapshot itself
    /// couldn't be captured (e.g. a filesystem that doesn't report mtime) —
    /// the frontend stores whatever comes back and passes it right back as
    /// `save_document`'s `expected_fingerprint`, where `None` means "no
    /// verified baseline, skip the staleness check" (issue #113).
    fingerprint: Option<Fingerprint>,
}

/// Cut a preview slice at the last line boundary so the tail is not a
/// half-loaded line (or a split multi-byte sequence) where avoidable.
///
/// `utf16` names the byte order when `bytes` is UTF-16 (see
/// `encoding::utf16_variant` / `encoding::preview_utf16_variant`), decided
/// by the caller from the same signal the real decode will use (explicit
/// label; else BOM; else, during auto-detection, a per-extension hint
/// resolved the same way the real decode resolves it — issue #71) *before*
/// decoding happens — this function only ever sees raw bytes. UTF-16's LF is the
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
    /// True when `expected_fingerprint` was given and no longer matches the
    /// file's current on-disk state — something else wrote to `path` since
    /// the fingerprint was captured. Nothing was written; the caller must
    /// re-invoke with `force: true` (after explicit user confirmation to
    /// overwrite) or reload the file's fresh content first (issue #113).
    stale: bool,
    /// The file's fingerprint immediately after a successful write, opaque
    /// to the frontend (see `fsguard.rs`) — store it and pass it back as
    /// the next save's `expected_fingerprint`. `None` unless `written` is
    /// true.
    fingerprint: Option<Fingerprint>,
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
    let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = meta.len();
    // Captured from the same metadata snapshot `total_size`/`truncated`
    // already rest on, so this introduces no new race beyond the one this
    // function's own doc comment already accepts. `.ok()`: a filesystem
    // that can't report mtime shouldn't fail the whole open, just leave
    // this document without a verified save-time baseline (see
    // `OpenedDocument::fingerprint`).
    let fingerprint = Fingerprint::from_metadata(&meta).ok();
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
        // Issue #71: alignment must match what the real decode below will
        // actually choose. During auto-detection that choice can come
        // from `extension_encoding`, not just the BOM — plain
        // `encoding::utf16_variant` cannot see that hint.
        // `preview_utf16_variant` runs the same guarded
        // `detect_with_extension` the decode itself calls, so the two
        // can never disagree.
        let utf16 = encoding::preview_utf16_variant(
            &raw,
            encoding.as_deref(),
            extension_encoding.as_deref(),
        );
        let slice = preview_slice(&raw, PREVIEW_BYTES, utf16);
        // Issue #71 (single-line P3): for a non-UTF-16 auto-detected
        // preview, `preview_slice` cuts at the last newline — a clean
        // UTF-8 boundary the real decode's confident-UTF-8 gate relies
        // on. A single very long line with no newline in the window has
        // no such cut, so the slice can still end mid-character; left
        // as-is the decode below would miss that gate and an extension
        // hint would hijack the whole window into mojibake. Trimming the
        // truncated trailing UTF-8 sequence realigns it. Scoped to
        // auto-detect (an explicit reopen decodes exactly as asked) and
        // to non-UTF-16 (a UTF-16-aligned slice must stay whole; real
        // UTF-16 has no truncated-UTF-8 tail to trim). A no-op unless the
        // tail really is a split multibyte sequence, so the multi-line
        // and clean-cut cases are unaffected.
        let slice = if encoding.is_none() && utf16.is_none() {
            encoding::trim_truncated_utf8_tail(slice)
        } else {
            slice
        };
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
        fingerprint,
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
/// This is a multi-phase save. `unmappable` is true when characters could
/// not be represented in the target encoding. When that happens and
/// `allow_lossy` is `false`, nothing is written — the file on disk is left
/// exactly as it was, and the caller must re-invoke with `allow_lossy: true`
/// (after explicit user confirmation) to actually write the lossy bytes.
/// This guarantees a save can never silently overwrite the user's original
/// text with lossy replacement bytes before they've agreed to that trade.
///
/// That guarantee is about *unmappable* characters specifically, not
/// byte-for-byte fidelity in general: every save re-encodes the entire
/// document from scratch (there is no per-region diffing), so for the
/// legacy encodings `encoding::encode`'s round-trip contract note
/// documents, saving can silently canonicalize bytes the user never
/// touched even when nothing is unmappable and `allow_lossy` never comes
/// into play. See `encoding.rs`'s module doc.
///
/// Issue #113: after encoding but before the commit (`atomic_write`), this
/// also fail-closes against an external change to `path` since it was last
/// read — the ordinary Save path had no guard at all against another
/// process (or a second Plume window) writing to the same file during the
/// encode step, unlike the large-file streaming replace path's existing
/// fingerprint check (issue #94, shared here via `fsguard.rs`). When
/// `expected_fingerprint` is `Some` and `force` is `false`, `path` is
/// re-fingerprinted right before the write and compared; a mismatch aborts
/// with `stale: true, written: false` and touches nothing on disk. `force:
/// true` skips the check entirely — the retry path after the user
/// explicitly chooses to overwrite. `expected_fingerprint: None` also skips
/// the check: there is no prior on-disk baseline to compare against for an
/// untitled document's first save or a Save As to a brand-new path. On a
/// successful write, the fresh post-write fingerprint is returned so the
/// caller can use it as the baseline for the *next* save.
///
/// Like the streaming-replace guard this shares `fsguard.rs` with (#102),
/// the check narrows the race to the tiny stat-to-rename window rather
/// than eliminating it — no portable rename is conditional on file
/// identity — but that is a vast improvement over leaving the whole
/// open-to-save span unguarded.
// Flat parameters (rather than a grouped-struct argument) match every other
// command in this file, whose shape is dictated by the frontend's IPC call
// (src/ipc.ts `saveDocument`), not by ordinary Rust API ergonomics.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn save_document(
    path: String,
    content: String,
    encoding: String,
    with_bom: bool,
    line_ending: String,
    allow_lossy: bool,
    expected_fingerprint: Option<Fingerprint>,
    force: bool,
) -> Result<SaveResult, String> {
    let text = encoding::apply_line_ending(&content, &line_ending);
    let (bytes, unmappable) = encoding::encode(&text, &encoding, with_bom)?;
    if unmappable && !allow_lossy {
        return Ok(SaveResult {
            unmappable: true,
            written: false,
            stale: false,
            fingerprint: None,
        });
    }
    let target = std::path::Path::new(&path);
    if !force {
        if let Some(expected) = &expected_fingerprint {
            if !expected.matches_path(target) {
                return Ok(SaveResult {
                    unmappable,
                    written: false,
                    stale: true,
                    fingerprint: None,
                });
            }
        }
    }
    atomic_write(target, &bytes).map_err(|e| format!("Failed to write {path}: {e}"))?;
    Ok(SaveResult {
        unmappable,
        written: true,
        stale: false,
        fingerprint: Fingerprint::from_path(target).ok(),
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
            menu::sync_read_only_menu,
            menu::retitle_menu,
            take_pending_files,
            print_window,
            chunk::read_document_chunk,
            chunk::read_document_chunk_before,
            lineindex::build_line_index,
            lineindex::locate_line_offset,
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
            streamreplace::stream_replace_in_file,
            charinspect::encode_char,
            normalize::check_representable,
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
            None,
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
            None,
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
            None,
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
            None,
            false,
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

    /// Issue #113 core regression (P1 data loss): the plain Save path had
    /// no guard at all against another process writing to the same path
    /// between when the editor's snapshot was taken (here, the
    /// `open_document` that produced `expected_fingerprint`) and this
    /// command's own commit. This drives the real end-to-end sequence the
    /// issue describes — open, external atomic replace, then Save with the
    /// now-stale fingerprint — and pins both halves of the fix: the call
    /// reports `stale: true, written: false`, *and* the externally-written
    /// content is byte-for-byte untouched on disk afterward. The external
    /// write uses different-length content so the size field alone
    /// guarantees detection, independent of filesystem mtime resolution or
    /// of `std::fs::write`'s reuse of the same inode for a same-path
    /// rewrite (see `fsguard.rs`'s own
    /// `matches_path_false_after_size_change`).
    #[test]
    fn save_document_rejects_stale_fingerprint_and_preserves_external_write() {
        let dir = std::env::temp_dir().join("plume-save-stale-fingerprint-reject");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");
        std::fs::write(&target, b"original content on disk").unwrap();
        let path = target.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), None, None).unwrap();
        let expected_fingerprint = opened.fingerprint;
        assert!(
            expected_fingerprint.is_some(),
            "opening a real file must yield a verifiable fingerprint"
        );

        // Another process (or a second Plume window) replaces the file's
        // content while this editor's tab still holds the old snapshot.
        let external_content = b"externally written, much newer and longer content";
        std::fs::write(&target, external_content).unwrap();

        let result = save_document(
            path,
            "editor's stale in-memory buffer content".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            expected_fingerprint,
            false,
        )
        .unwrap();

        assert!(result.stale, "a changed file must be reported stale");
        assert!(!result.written, "a stale save must not write anything");
        assert!(result.fingerprint.is_none());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            external_content,
            "the externally-written content must survive completely untouched"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The happy-path counterpart: when nothing external touched the file
    /// between open and save, the matching fingerprint must not block the
    /// write, and the response carries a fresh fingerprint the caller can
    /// use as the next save's baseline.
    #[test]
    fn save_document_succeeds_when_fingerprint_matches() {
        let dir = std::env::temp_dir().join("plume-save-fingerprint-matches");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");
        std::fs::write(&target, b"original content").unwrap();
        let path = target.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), None, None).unwrap();

        let result = save_document(
            path,
            "freshly edited content".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            opened.fingerprint,
            false,
        )
        .unwrap();

        assert!(!result.stale);
        assert!(result.written);
        assert!(
            result.fingerprint.is_some(),
            "a successful write must return a fresh fingerprint"
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "freshly edited content"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `force: true` is the Overwrite retry path: even against a fingerprint
    /// that no longer matches (the same external-replace scenario as
    /// `save_document_rejects_stale_fingerprint_and_preserves_external_write`),
    /// the caller's explicit choice to overwrite must go through.
    #[test]
    fn save_document_force_overwrites_despite_stale_fingerprint() {
        let dir = std::env::temp_dir().join("plume-save-force-overwrite");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");
        std::fs::write(&target, b"original content on disk").unwrap();
        let path = target.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), None, None).unwrap();
        std::fs::write(
            &target,
            b"externally written, much newer and longer content",
        )
        .unwrap();

        let result = save_document(
            path,
            "user explicitly chose to overwrite".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            opened.fingerprint,
            true,
        )
        .unwrap();

        assert!(!result.stale);
        assert!(result.written);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "user explicitly chose to overwrite"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `expected_fingerprint: None` is the untitled-first-save / Save As
    /// path: there is no prior on-disk baseline to compare against (the
    /// document was never opened from this path), so the check must be
    /// skipped entirely rather than failing closed on a `None` that was
    /// never a real mismatch.
    #[test]
    fn save_document_skips_check_when_no_expected_fingerprint() {
        let dir = std::env::temp_dir().join("plume-save-no-expected-fingerprint");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("new-doc.txt");
        let path = target.to_string_lossy().into_owned();

        let result = save_document(
            path,
            "brand new untitled content".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            None,
            false,
        )
        .unwrap();

        assert!(!result.stale);
        assert!(result.written);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "brand new untitled content"
        );

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

    /// Build a large, BOM-less UTF-16 fixture whose lines are genuinely
    /// non-ASCII (`"第 {i} 行\n"`), unlike `write_utf16le_line_fixture`'s
    /// pure-ASCII lines. This distinction matters for issue #71: every
    /// ASCII byte — including the zero high byte UTF-16 pads Latin text
    /// with — is independently valid UTF-8, so a pure-ASCII UTF-16
    /// fixture's raw bytes pass `str::from_utf8` and the extension hint
    /// is *never* consulted for it (the #47 gate already documents this
    /// exact trade-off). `write_utf16le_line_fixture`'s fixtures are the
    /// right choice for the BOM and explicit-label tests above, which
    /// don't go anywhere near that gate; a fixture meant to exercise the
    /// ext-hint path needs bytes that actually fail it, mirroring why
    /// `encoding.rs`'s `utf16_ext_hint_still_applies_to_real_utf16_without_bom`
    /// uses "中文" instead of ASCII. `label` selects the byte order
    /// ("UTF-16LE" / "UTF-16BE"); always BOM-less since that is this
    /// fixture's entire point.
    fn write_utf16_nonascii_line_fixture(
        dir_name: &str,
        n: u32,
        label: &str,
    ) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(dir_name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big16-nonascii.txt");
        let data: String = (0..n).map(|i| format!("第 {i} 行\n")).collect();
        let (bytes, unmappable) = crate::encoding::encode(&data, label, false).unwrap();
        assert!(
            !unmappable,
            "UTF-16 encoding never reports unmappable characters"
        );
        std::fs::write(&file, &bytes).unwrap();
        file
    }

    /// Issue #71 core regression, LE. A BOM-less UTF-16LE file whose text
    /// is genuinely non-ASCII (so its raw bytes are *not* coincidentally
    /// valid UTF-8 — see `write_utf16_nonascii_line_fixture`), well over
    /// `LARGE_FILE_THRESHOLD`, opened via auto-detection (`encoding:
    /// None`) with a per-extension preference hinting UTF-16LE — exactly
    /// what `open_document` receives once the frontend resolves the
    /// file's extension through `Preferences::extension_encodings`.
    ///
    /// The *real* decode already picks this up correctly:
    /// `decode_auto_with_extension` -> `detect_with_extension` accepts
    /// the hint (rule 4; the #47 UTF-8 gate does not block it because
    /// this content genuinely is not valid UTF-8). Before this fix, the
    /// *preview cut* disagreed with that decision: `encoding::
    /// utf16_variant(&raw, None)` only ever consults the explicit reopen
    /// label and the BOM, saw neither, and returned `None`, so `preview_
    /// slice` fell back to its raw `0x0A` byte search — which on real
    /// UTF-16LE content lands mid code-unit almost every time, leaving a
    /// dangling final byte. That dangling byte then makes the *real*
    /// decode's own `detect_with_extension` call see a malformed UTF-16LE
    /// trial decode and reject the very hint that should have won,
    /// falling back to a statistical guess that is never UTF-16 (see
    /// `detect_with_extension`'s doc comment) — the wrong encoding
    /// entirely, not just a stray warning.
    ///
    /// Red before the fix (`opened.encoding` is not `"UTF-16LE"` and the
    /// content is garbled); green after, because `encoding::preview_
    /// utf16_variant` runs the very same guarded `detect_with_extension`
    /// call the real decode uses, so the two can never disagree.
    #[test]
    fn open_document_large_bomless_utf16le_via_ext_hint_not_malformed() {
        let file = write_utf16_nonascii_line_fixture(
            "plume-large-bomless-utf16le-ext-hint",
            600_000,
            "UTF-16LE",
        );
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, Some("UTF-16LE".to_string())).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert!(!opened.had_bom, "fixture has no BOM");
        assert_eq!(
            opened.encoding, "UTF-16LE",
            "the extension hint must win exactly as the real decode would pick it"
        );
        assert!(
            !opened.malformed,
            "a structurally valid UTF-16LE file must never report malformed, \
             even when picked up only via the extension hint"
        );
        assert!(
            opened.content.starts_with("第 0 行\n"),
            "content must decode correctly, not as whatever encoding a \
             corrupted preview cut would fall back to"
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

    /// Build a large, BOM-less UTF-16BE fixture that is `n` repeats of
    /// U+0A85 — a character chosen purely for its byte layout, not its
    /// meaning: U+0A85's BE encoding is the byte pair `[0x0A, 0x85]`, so
    /// its *high* byte is `0x0A`. Every code unit in the file repeats
    /// this same pair, and a 2-byte period divides any even window
    /// length exactly, so the pre-#71-fix raw `0x0A` byte search always
    /// finds *this* character's high byte as the very last occurrence in
    /// the window — deterministically reproducing a mid-code-unit cut
    /// regardless of exactly where `PREVIEW_BYTES` falls.
    ///
    /// This probe is what BE specifically needs, and ordinary prose
    /// cannot provide it: BE's newline code unit is `00 0A`, so a raw
    /// `0x0A` search lands on that code unit's own *last* byte whenever
    /// it finds a real newline — which, for text with no character in
    /// the U+0A00-U+0AFF block (essentially all real-world text; that
    /// block is Gurmukhi), is *always* what it finds. The bug is just as
    /// real for BE as for LE (neither `utf16_variant` nor the pre-fix
    /// call site know the byte order without a BOM or explicit label),
    /// but a `write_utf16_nonascii_line_fixture`-style "第 {i} 行\n"
    /// fixture cannot exhibit it for BE — the raw search always
    /// (accidentally) lands on a complete code unit already. See
    /// `open_document_large_bomless_utf16be_via_ext_hint_not_malformed`.
    fn write_utf16be_high_byte_0a_fixture(dir_name: &str, n: usize) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(dir_name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big16be-0a-probe.txt");
        let data: String = "\u{0A85}".repeat(n);
        let (bytes, unmappable) = crate::encoding::encode(&data, "UTF-16BE", false).unwrap();
        assert!(
            !unmappable,
            "UTF-16 encoding never reports unmappable characters"
        );
        std::fs::write(&file, &bytes).unwrap();
        file
    }

    /// Issue #71, BE counterpart of
    /// `open_document_large_bomless_utf16le_via_ext_hint_not_malformed`.
    /// Cannot reuse that test's realistic line-oriented fixture — see
    /// `write_utf16be_high_byte_0a_fixture`'s doc comment for why BE
    /// needs a deliberate byte-layout probe instead of ordinary prose to
    /// reproduce the mid-code-unit cut. Same red-before/green-after
    /// shape otherwise: before the fix, the dangling probe byte makes
    /// the real decode's own `detect_with_extension` call see a
    /// malformed UTF-16BE trial decode and reject the extension hint,
    /// falling back to a statistical guess that is never UTF-16.
    #[test]
    fn open_document_large_bomless_utf16be_via_ext_hint_not_malformed() {
        let file =
            write_utf16be_high_byte_0a_fixture("plume-large-bomless-utf16be-ext-hint", 6_000_000);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, Some("UTF-16BE".to_string())).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert!(!opened.had_bom, "fixture has no BOM");
        assert_eq!(
            opened.encoding, "UTF-16BE",
            "the extension hint must win exactly as the real decode would pick it"
        );
        assert!(
            !opened.malformed,
            "a structurally valid UTF-16BE file must never report malformed, \
             even when picked up only via the extension hint"
        );
        assert_eq!(
            opened.content.chars().count(),
            PREVIEW_BYTES / 2,
            "the preview must be exactly the full even window decoded as \
             whole code units — this fixture has no newline to cut at"
        );
        assert!(
            opened.content.chars().all(|c| c == '\u{0A85}'),
            "content must decode as the repeated marker character, not \
             garbage from a wrong encoding"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "no replacement characters may appear when nothing is actually corrupt"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Build a large, genuinely-valid-UTF-8 fixture of pure-`中` content —
    /// either many short lines (`multiline`) or one newline-free line —
    /// sized past `LARGE_FILE_THRESHOLD`. `中` is U+4E2D → UTF-8 `E4 B8
    /// AD`: a 3-byte sequence whose bytes (E0-EF lead, 80-BF continuation)
    /// never fall in the UTF-16 surrogate high-byte range D8-DF. That is
    /// the exact adversarial shape issue #71's P1/P3 need — the 2 MiB
    /// preview bound splits a character (so a naive `from_utf8` on the
    /// window fails), and a UTF-16 *trial* decode of these bytes never
    /// reports a malformed sequence, so nothing but the confident-UTF-8
    /// gate stops an extension hint from silently reinterpreting the whole
    /// preview as mojibake.
    fn write_large_cjk_utf8_fixture(dir_name: &str, multiline: bool) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(dir_name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cjk-utf8.txt");
        let data: String = if multiline {
            // 31-byte lines: 10 × `中` (30 bytes) + `\n`. The 2 MiB bound
            // lands mid-character, but earlier newlines give the preview a
            // clean line boundary to cut at.
            "中中中中中中中中中中\n".repeat(400_000)
        } else {
            // One ~12 MB line, no newline anywhere in the 2 MiB window, so
            // the cut itself cannot land on a clean boundary (P3).
            "中".repeat(4_000_000)
        };
        assert!(
            std::str::from_utf8(data.as_bytes()).is_ok(),
            "fixture must be genuinely valid UTF-8"
        );
        std::fs::write(&file, data.as_bytes()).unwrap();
        file
    }

    /// Issue #71, P1 regression (the hole a naive #71 fix reopened, LE
    /// hint). A large *valid UTF-8* CJK file, no BOM, auto-detected with a
    /// per-extension preference of UTF-16LE. The #47 gate protects small
    /// files; this pins that the large-file preview path does not reopen
    /// the silent-mojibake hole. Before the truncation-tolerance fix the
    /// preview probed the mid-character-truncated 2 MiB window, mis-read
    /// it as UTF-16 (a UTF-16 trial of these surrogate-free bytes never
    /// reports malformed), cut the whole window, and the real decode then
    /// reinterpreted every byte as UTF-16 — `encoding == "UTF-16LE"`,
    /// garbled content, `malformed == false`, no U+FFFD: exactly the
    /// "decode errors surfaced, never silently rendered as fine" hard
    /// constraint, violated. Multi-line, so after the fix the cut lands on
    /// a newline and the real decode sees clean UTF-8.
    #[test]
    fn open_document_large_cjk_utf8_multiline_ext_hint_le_not_corrupted() {
        let file = write_large_cjk_utf8_fixture("plume-large-cjk-utf8-multiline-le", true);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, Some("UTF-16LE".to_string())).unwrap();

        assert!(opened.truncated);
        assert_eq!(
            opened.encoding, "UTF-8",
            "a valid UTF-8 CJK file must not be reinterpreted as UTF-16 via the ext hint (#47/#71)"
        );
        assert!(
            !opened.malformed,
            "valid UTF-8 content must never report malformed"
        );
        assert!(
            opened.content.starts_with("中中中"),
            "content must decode as CJK, not mojibake"
        );
        assert!(
            opened.content.ends_with('\n'),
            "a multi-line preview must cut on a line boundary"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "no replacement characters when nothing is actually corrupt"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #71, P1 regression, BE-hint symmetry of
    /// `open_document_large_cjk_utf8_multiline_ext_hint_le_not_corrupted`.
    /// A UTF-16BE hint over the same valid-UTF-8 CJK file must be rejected
    /// identically (the confident-UTF-8 gate does not care which UTF-16
    /// byte order the hint names).
    #[test]
    fn open_document_large_cjk_utf8_multiline_ext_hint_be_not_corrupted() {
        let file = write_large_cjk_utf8_fixture("plume-large-cjk-utf8-multiline-be", true);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, Some("UTF-16BE".to_string())).unwrap();

        assert!(opened.truncated);
        assert_eq!(
            opened.encoding, "UTF-8",
            "a valid UTF-8 CJK file must not be reinterpreted as UTF-16 via the ext hint (#47/#71)"
        );
        assert!(!opened.malformed);
        assert!(opened.content.starts_with("中中中"));
        assert!(opened.content.ends_with('\n'));
        assert!(!opened.content.contains('\u{FFFD}'));

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #71, P3 (pre-existing, fixed here in passing). One very long
    /// valid-UTF-8 CJK line with *no newline* in the 2 MiB window, plus a
    /// UTF-16LE hint. With no newline the preview cut cannot land on a
    /// clean boundary, so even after the probe correctly rejects UTF-16
    /// the slice still ends mid-character — and the real decode would then
    /// miss the confident-UTF-8 gate and let the hint hijack the whole
    /// window (the same silent mojibake, reached through the decode rather
    /// than the cut). The fix trims the slice's truncated trailing UTF-8
    /// sequence before decoding, so the decode sees clean UTF-8. Content
    /// does not end on a newline here (there is none), so this asserts
    /// correct CJK decode and no U+FFFD instead.
    #[test]
    fn open_document_large_cjk_utf8_singleline_ext_hint_not_corrupted() {
        let file = write_large_cjk_utf8_fixture("plume-large-cjk-utf8-singleline", false);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, Some("UTF-16LE".to_string())).unwrap();

        assert!(opened.truncated);
        assert_eq!(
            opened.encoding, "UTF-8",
            "a single-line valid UTF-8 CJK file with no newline in the window \
             must still not be reinterpreted as UTF-16 (#71 P3)"
        );
        assert!(!opened.malformed);
        assert!(
            opened.content.starts_with("中中中"),
            "content must decode as CJK, not mojibake"
        );
        assert!(
            opened.content.chars().all(|c| c == '中'),
            "every decoded character must be the fixture's CJK character"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "the truncated tail must be trimmed, not surfaced as U+FFFD"
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

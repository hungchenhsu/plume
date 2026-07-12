//! Batch encoding *and* line-ending conversion: scan a folder for a
//! dry-run report, then convert selected files to a target
//! encoding/line-ending, one atomic write per file. Track A of the v0.3
//! roadmap (ROADMAP.md).
//!
//! Two independent axes, each accepting a "keep" sentinel meaning "don't
//! touch this axis":
//!
//! - `target_encoding`: a canonical `encoding_rs` name, or the literal
//!   string `"keep"` — re-encode each file with its own detected encoding
//!   and detected BOM state (ignoring `target_with_bom`) instead of a
//!   caller-chosen target. This is what makes an encoding-preserving,
//!   line-ending-only conversion possible.
//! - `line_ending`: `"LF"`, `"CRLF"`, or `"keep"` — leave every line
//!   ending exactly as found on disk.
//!
//! `"keep"` + `"keep"` classifies every file `alreadyTarget` (nothing on
//! either axis would change), and converting is a no-op everywhere thanks
//! to the byte-identical skip in `convert_one`.
//!
//! Folder walking mirrors `search.rs`'s find-in-files traversal (same
//! `SKIP_DIRS`, same dotdir/symlink skip rules) so batch conversion never
//! descends into VCS metadata or dependency trees either.
//!
//! Data-integrity invariant this module exists to protect (see
//! `convert_one`): a converted file's *line endings* are never touched
//! unless `line_ending` explicitly asks for it. Classification and
//! conversion both work on the raw decode of a file's own bytes — never
//! run through `encoding::normalize_to_lf` the way `lib.rs::open_document`
//! normalizes for the editor buffer — *unless* `line_ending != "keep"`, in
//! which case `convert_one` normalizes to LF and re-applies the requested
//! ending before re-encoding. With `line_ending: "keep"`, a CRLF file
//! stays CRLF and an LF file stays LF; only the byte-level encoding
//! changes (or nothing at all changes, with `target_encoding: "keep"`
//! too).
//!
//! Deviation from the original task sketch: `scan_batch_conversion` takes
//! an explicit `target_with_bom: bool` parameter (mirroring
//! `execute_batch_conversion`'s existing one), even though the initial
//! signature sketch omitted it. The spec's own classification rule —
//! "already target: encoding name *and* BOM state both match" — cannot be
//! implemented without knowing the target's desired BOM state, so this is
//! treated as a required correction rather than a deviation to avoid.
//! `target_with_bom` is meaningless (and ignored) whenever
//! `target_encoding == "keep"`.

use crate::encoding;
use encoding_rs::Encoding;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Directory names never descended into — matches `search.rs::SKIP_DIRS`.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
];

/// Files above this size are reported as `tooLarge` and skipped, matching
/// the editor's own large-file threshold: a batch tool has no business
/// fully reading a file the editor itself refuses to fully load.
const MAX_FILE_SIZE: u64 = crate::LARGE_FILE_THRESHOLD;

/// A scan aborts outright above this many matched files rather than
/// silently truncating the report — guards against pointing the tool at,
/// say, a home directory by mistake.
const MAX_FILES: usize = 2000;

pub const STATUS_CONVERTIBLE: &str = "convertible";
pub const STATUS_ALREADY_TARGET: &str = "alreadyTarget";
pub const STATUS_LOSSY: &str = "lossy";
pub const STATUS_UNDECODABLE: &str = "undecodable";
pub const STATUS_TOO_LARGE: &str = "tooLarge";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchEntry {
    pub path: String,
    /// Detected source encoding name, e.g. "Big5". Empty when the file was
    /// never read (`tooLarge`).
    pub detected: String,
    /// One of the `STATUS_*` constants above.
    pub status: String,
    /// The file's own detected line ending: "LF" | "CRLF" | "Mixed" (see
    /// `encoding::detect_line_ending`). Empty when the file was never read
    /// (`tooLarge`) or its bytes couldn't be read at all (permission
    /// error, vanished mid-scan) — but still populated for `undecodable`
    /// entries, since a malformed multi-byte sequence elsewhere in the
    /// file doesn't prevent detecting `\r`/`\n` bytes.
    pub line_ending: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchScanReport {
    pub entries: Vec<BatchEntry>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchConvertResult {
    pub path: String,
    pub ok: bool,
    pub message: String,
}

/// True when `path`'s extension (lowercased) is in `extensions`; an empty
/// `extensions` matches every file. `extensions` is expected already
/// lowercased (see `scan_with_limit`) — this still lowercases the path's
/// own extension itself, so it is correct even if called with a
/// not-yet-lowercased list.
fn extension_matches(path: &Path, extensions: &[String]) -> bool {
    if extensions.is_empty() {
        return true;
    }
    let Some(ext) = path.extension() else {
        return false;
    };
    let ext = ext.to_string_lossy().to_lowercase();
    extensions.contains(&ext)
}

/// Recursively collect files under `dir` matching `extensions`, skipping
/// dotdirs/`SKIP_DIRS`/symlinks exactly as `search.rs::collect_files`
/// does. Bails with `Err` the moment the running total would exceed
/// `limit` — before descending further — so pointing this at a huge tree
/// fails fast instead of enumerating it all first.
fn collect_files(
    dir: &Path,
    extensions: &[String],
    limit: usize,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if path.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            collect_files(&path, extensions, limit, files)?;
        } else if meta.is_file() && extension_matches(&path, extensions) {
            files.push(path);
            if files.len() > limit {
                return Err(format!(
                    "Too many files to scan (more than {limit}); choose a smaller or \
                     more specific folder."
                ));
            }
        }
    }
    Ok(())
}

/// Resolve a `target_encoding` argument to `None` (`"keep"`: use each
/// file's own detected encoding) or `Some` real encoding. `"keep"` is a
/// sentinel, not a real label — it deliberately isn't routed through
/// `Encoding::for_label` (which wouldn't resolve it anyway).
fn resolve_target_encoding(target_encoding: &str) -> Result<Option<&'static Encoding>, String> {
    if target_encoding == "keep" {
        return Ok(None);
    }
    Encoding::for_label(target_encoding.as_bytes())
        .map(Some)
        .ok_or_else(|| format!("Unknown target encoding: {target_encoding}"))
}

/// Validate a `line_ending` argument is one of the three values this
/// module understands. Checked up front so an unknown value fails the
/// whole scan/execute call rather than silently doing nothing per-file.
fn validate_line_ending(line_ending: &str) -> Result<(), String> {
    match line_ending {
        "keep" | "LF" | "CRLF" => Ok(()),
        other => Err(format!("Unknown line ending: {other}")),
    }
}

/// Classify one file against the encoding axis (`target`/`target_with_bom`,
/// `target: None` meaning "keep this file's own encoding") and the
/// line-ending axis (`target_line_ending`, `"keep"` meaning "don't touch
/// it"). Never fails: an unreadable file (permission error, vanished
/// mid-scan) is reported as `undecodable` rather than aborting the whole
/// scan.
fn classify_file(
    path: &Path,
    target: Option<&'static Encoding>,
    target_with_bom: bool,
    target_line_ending: &str,
) -> BatchEntry {
    let path_str = path.to_string_lossy().into_owned();

    let too_large = std::fs::metadata(path)
        .map(|m| m.len() > MAX_FILE_SIZE)
        .unwrap_or(false);
    if too_large {
        return BatchEntry {
            path: path_str,
            detected: String::new(),
            status: STATUS_TOO_LARGE.to_string(),
            line_ending: String::new(),
        };
    }

    let Ok(bytes) = std::fs::read(path) else {
        return BatchEntry {
            path: path_str,
            detected: String::new(),
            status: STATUS_UNDECODABLE.to_string(),
            line_ending: String::new(),
        };
    };

    // No per-extension hint: matches the task's "encoding::detect, no
    // hint" instruction and keeps scan/execute using the identical
    // detection path (`convert_one` also calls plain `decode_auto`).
    let decoded = encoding::decode_auto(&bytes);
    // Computed even when malformed: a malformed multi-byte sequence
    // elsewhere in the file doesn't affect the plain ASCII `\r`/`\n` bytes
    // that decide the line ending, so the report can still show a source
    // line ending for `undecodable` entries.
    let detected_line_ending = encoding::detect_line_ending(&decoded.content).to_string();
    if decoded.malformed {
        return BatchEntry {
            path: path_str,
            detected: decoded.encoding,
            status: STATUS_UNDECODABLE.to_string(),
            line_ending: detected_line_ending,
        };
    }

    let source = Encoding::for_label(decoded.encoding.as_bytes());
    let encoding_axis_unchanged = match target {
        None => true,
        Some(t) => source == Some(t) && decoded.had_bom == target_with_bom,
    };
    // "keep" never counts as changed; otherwise the axis is unchanged only
    // when the file's own line ending already matches the target exactly
    // — a "Mixed" file never equals a concrete "LF"/"CRLF" target, so it
    // always counts as changed (convertible) against either, with no
    // special-case code needed for that rule.
    let line_ending_axis_unchanged =
        target_line_ending == "keep" || detected_line_ending == target_line_ending;

    if encoding_axis_unchanged && line_ending_axis_unchanged {
        return BatchEntry {
            path: path_str,
            detected: decoded.encoding,
            status: STATUS_ALREADY_TARGET.to_string(),
            line_ending: detected_line_ending,
        };
    }

    // Only the encoding axis can lose data; re-encoding to "keep" (the
    // same encoding the content was just decoded from) can never be
    // lossy, so a pure line-ending-only change is always `convertible`.
    let status = match target {
        None => STATUS_CONVERTIBLE,
        Some(t) => {
            // `target` was already validated as a real encoding by the
            // caller (`scan_with_limit`), and `t.name()` always
            // round-trips through `Encoding::for_label`, so this can
            // never hit the Err arm.
            let (_, unmappable) = encoding::encode(&decoded.content, t.name(), target_with_bom)
                .expect("target encoding validated by the caller");
            if unmappable {
                STATUS_LOSSY
            } else {
                STATUS_CONVERTIBLE
            }
        }
    };
    BatchEntry {
        path: path_str,
        detected: decoded.encoding,
        status: status.to_string(),
        line_ending: detected_line_ending,
    }
}

/// Core of `scan_batch_conversion`, parameterized by the file-count cap so
/// tests can exercise the cap cheaply (see `scan_aborts_over_the_limit`)
/// instead of creating thousands of fixture files.
fn scan_with_limit(
    dir: &str,
    extensions: &[String],
    target_encoding: &str,
    target_with_bom: bool,
    line_ending: &str,
    limit: usize,
) -> Result<BatchScanReport, String> {
    let target = resolve_target_encoding(target_encoding)?;
    validate_line_ending(line_ending)?;
    let lower_extensions: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();

    let mut files = Vec::new();
    collect_files(Path::new(dir), &lower_extensions, limit, &mut files)?;

    let entries = files
        .iter()
        .map(|path| classify_file(path, target, target_with_bom, line_ending))
        .collect();
    Ok(BatchScanReport { entries })
}

/// Dry-run scan: classify every matching file under `dir` against the
/// encoding axis (`target_encoding`/`target_with_bom`) and the
/// line-ending axis (`line_ending`) without changing anything on disk.
/// `target_encoding` is a canonical encoding name or the sentinel
/// `"keep"` (leave each file's own encoding alone — `target_with_bom` is
/// then ignored). `line_ending` is one of `"keep"` | `"LF"` | `"CRLF"`.
/// `extensions` is a list of lowercase, dot-less extensions ("txt", not
/// ".txt" or "TXT" — matching is case-insensitive regardless); an empty
/// list matches every file. See `classify_file` for the per-file
/// decision: `tooLarge` (> 10 MiB) short-circuits before any read;
/// otherwise the file is auto-detected (no per-extension hint, matching
/// `encoding::decode_auto`) and classified `undecodable` / `alreadyTarget`
/// (both axes unchanged) / `lossy` / `convertible`.
#[tauri::command]
pub fn scan_batch_conversion(
    dir: String,
    extensions: Vec<String>,
    target_encoding: String,
    target_with_bom: bool,
    line_ending: String,
) -> Result<BatchScanReport, String> {
    scan_with_limit(
        &dir,
        &extensions,
        &target_encoding,
        target_with_bom,
        &line_ending,
        MAX_FILES,
    )
}

/// Convert one file: re-detect and re-decode fresh from disk (never trust
/// the scan's snapshot — the file may have changed since the dry run),
/// re-encode to `target`/`with_bom` (`target: None` keeps the file's own
/// detected encoding and BOM state), optionally unifying line endings to
/// `line_ending` first (`"keep"` leaves them exactly as decoded), then
/// atomically writes the result. Never partially writes: a decode or
/// encode failure returns `ok: false` with the original file left
/// untouched.
fn convert_one(
    path: &str,
    target: Option<&'static Encoding>,
    with_bom: bool,
    line_ending: &str,
) -> BatchConvertResult {
    // Same guard as the scan side: a file that grew past the size cap
    // between scan and execute must not be slurped into memory.
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > MAX_FILE_SIZE => {
            return BatchConvertResult {
                path: path.to_string(),
                ok: false,
                message: "File is now too large; skipped.".to_string(),
            }
        }
        Err(e) => {
            return BatchConvertResult {
                path: path.to_string(),
                ok: false,
                message: format!("Failed to read: {e}"),
            }
        }
        Ok(_) => {}
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            return BatchConvertResult {
                path: path.to_string(),
                ok: false,
                message: format!("Failed to read: {e}"),
            }
        }
    };

    // `decoded.content` here is the *raw* decode of the file's own bytes
    // (CR/CRLF/LF exactly as they are on disk) — deliberately not passed
    // through `encoding::normalize_to_lf` the way `lib.rs::open_document`
    // does for the editor buffer, *unless* `line_ending` asks for a
    // line-ending change below. With `line_ending: "keep"`, re-encoding it
    // straight back changes only the byte-level encoding; every line
    // ending is preserved.
    let decoded = encoding::decode_auto(&bytes);
    if decoded.malformed {
        return BatchConvertResult {
            path: path.to_string(),
            ok: false,
            message: "File no longer decodes cleanly; skipped.".to_string(),
        };
    }

    let content = if line_ending == "keep" {
        decoded.content
    } else {
        encoding::apply_line_ending(&encoding::normalize_to_lf(&decoded.content), line_ending)
    };

    let (target_encoding, target_with_bom) = match target {
        Some(t) => (t, with_bom),
        None => (
            // `decoded.encoding` is the name of the encoding that just
            // successfully decoded these bytes, which always round-trips
            // through `Encoding::for_label` (same guarantee
            // `classify_file` relies on for its own target).
            Encoding::for_label(decoded.encoding.as_bytes())
                .expect("decode_auto's reported encoding always round-trips"),
            decoded.had_bom,
        ),
    };

    let (out_bytes, unmappable) =
        match encoding::encode(&content, target_encoding.name(), target_with_bom) {
            Ok(result) => result,
            Err(e) => {
                return BatchConvertResult {
                    path: path.to_string(),
                    ok: false,
                    message: e,
                }
            }
        };
    if unmappable {
        return BatchConvertResult {
            path: path.to_string(),
            ok: false,
            message: "Some characters can't be represented in the target encoding; skipped."
                .to_string(),
        };
    }

    // Byte-identical output means there is nothing to convert (a pure
    // ASCII file "converting" to UTF-8, say, or any file under
    // "keep"+"keep"): skip the write entirely so the file's mtime is
    // untouched and no watcher reload fires for a no-op (adversarial-review
    // finding).
    if out_bytes == bytes {
        return BatchConvertResult {
            path: path.to_string(),
            ok: true,
            message: "Already byte-identical; not rewritten.".to_string(),
        };
    }

    match crate::atomic_write(Path::new(path), &out_bytes) {
        Ok(()) => BatchConvertResult {
            path: path.to_string(),
            ok: true,
            message: String::new(),
        },
        Err(e) => BatchConvertResult {
            path: path.to_string(),
            ok: false,
            message: format!("Failed to write: {e}"),
        },
    }
}

/// Convert every path in `paths` to `target_encoding`/`with_bom` (or leave
/// each file's own encoding alone with `target_encoding: "keep"`),
/// unifying line endings per `line_ending` (`"keep"` | `"LF"` | `"CRLF"`).
/// One file's failure never stops the batch — every path gets its own
/// `BatchConvertResult`. `paths` is normally the `convertible` subset of a
/// prior `scan_batch_conversion` report, but this never trusts that: each
/// file is independently re-detected and re-encoded (see `convert_one`).
#[tauri::command]
pub fn execute_batch_conversion(
    paths: Vec<String>,
    target_encoding: String,
    with_bom: bool,
    line_ending: String,
) -> Result<Vec<BatchConvertResult>, String> {
    let target = resolve_target_encoding(&target_encoding)?;
    validate_line_ending(&line_ending)?;
    Ok(paths
        .iter()
        .map(|path| convert_one(path, target, with_bom, &line_ending))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("plume-batch-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Find the entry (or converted-result) whose path's file name matches
    /// `file_name`, comparing by `Path::file_name` (not a raw string
    /// suffix) so this works regardless of the platform's path separator.
    fn entry_for<'a>(entries: &'a [BatchEntry], file_name: &str) -> &'a BatchEntry {
        entries
            .iter()
            .find(|e| {
                Path::new(&e.path)
                    .file_name()
                    .is_some_and(|n| n == file_name)
            })
            .unwrap_or_else(|| panic!("missing entry for {file_name} in {entries:?}"))
    }

    // Proven-reliable fixtures for statistical (non-BOM) detection — long
    // enough for chardetng to reach a confident verdict; short CJK samples
    // are genuinely ambiguous across legacy encodings (see encoding.rs's
    // own `detects_big5_from_realistic_sample` comment).
    const BIG5_TEXT_A: &str =
        "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。\nFile A.\n";
    const BIG5_TEXT_B: &str = "今天天氣非常晴朗，適合出門散步與閱讀書籍，心情也跟著愉快起來，\
         這是另一份用來測試批次轉換的繁體中文文件。\nFile B.\n";
    const SHIFT_JIS_TEXT: &str = "日本語文字エンコーディングの検出テストです。これは自動検出機能を検証するための文章であり、句読点や一般的な語彙も含まれています。\n";
    /// Same content as `BIG5_TEXT_A`, split across CRLF line endings, to
    /// lock that conversion never touches line endings.
    const BIG5_CRLF_TEXT: &str = "中文編碼偵測測試。\r\n這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。\r\n";

    #[test]
    fn round_trip_classifies_and_converts_a_mixed_tree() {
        let dir = fixture_dir("roundtrip");

        let (big5_a, u) = encoding::encode(BIG5_TEXT_A, "Big5", false).unwrap();
        assert!(!u);
        std::fs::write(dir.join("a.txt"), &big5_a).unwrap();

        let (big5_b, u) = encoding::encode(BIG5_TEXT_B, "Big5", false).unwrap();
        assert!(!u);
        std::fs::write(dir.join("b.txt"), &big5_b).unwrap();

        let utf8_text = "已經是 UTF-8 內容，測試 alreadyTarget 分類。";
        std::fs::write(dir.join("c.txt"), utf8_text.as_bytes()).unwrap();

        let emoji_text = "emoji 測試 🚀 已經是 UTF-8。";
        std::fs::write(dir.join("emoji.txt"), emoji_text.as_bytes()).unwrap();

        let (crlf_bytes, u) = encoding::encode(BIG5_CRLF_TEXT, "Big5", false).unwrap();
        assert!(!u);
        std::fs::write(dir.join("crlf.txt"), &crlf_bytes).unwrap();

        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let (sjis_bytes, u) = encoding::encode(SHIFT_JIS_TEXT, "Shift_JIS", false).unwrap();
        assert!(!u);
        std::fs::write(sub.join("d.txt"), &sjis_bytes).unwrap();

        // Fake binary with a mismatched extension on purpose: the
        // extension filter below (["txt"]) is what keeps it out of scope,
        // not `malformed` detection (arbitrary bytes very often decode
        // "cleanly" under some single-byte fallback encoding — see the
        // module doc comment).
        std::fs::write(
            dir.join("e.png"),
            [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 1, 2, 3],
        )
        .unwrap();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec!["txt".to_string()],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();

        assert_eq!(
            report.entries.len(),
            6,
            "6 .txt files (a, b, c, emoji, crlf, sub/d) — the .png must be excluded \
             by the extension filter: {:?}",
            report.entries
        );
        assert_eq!(
            entry_for(&report.entries, "a.txt").status,
            STATUS_CONVERTIBLE
        );
        assert_eq!(entry_for(&report.entries, "a.txt").detected, "Big5");
        assert_eq!(
            entry_for(&report.entries, "b.txt").status,
            STATUS_CONVERTIBLE
        );
        assert_eq!(entry_for(&report.entries, "b.txt").detected, "Big5");
        assert_eq!(
            entry_for(&report.entries, "c.txt").status,
            STATUS_ALREADY_TARGET
        );
        assert_eq!(entry_for(&report.entries, "c.txt").detected, "UTF-8");
        assert_eq!(
            entry_for(&report.entries, "emoji.txt").status,
            STATUS_ALREADY_TARGET
        );
        assert_eq!(
            entry_for(&report.entries, "d.txt").status,
            STATUS_CONVERTIBLE
        );
        assert_eq!(entry_for(&report.entries, "d.txt").detected, "Shift_JIS");
        assert_eq!(
            entry_for(&report.entries, "crlf.txt").status,
            STATUS_CONVERTIBLE
        );
        assert_eq!(entry_for(&report.entries, "crlf.txt").detected, "Big5");

        // Every entry's detected source line ending is reported (all these
        // fixtures are single-style: LF-only or CRLF-only).
        assert_eq!(entry_for(&report.entries, "a.txt").line_ending, "LF");
        assert_eq!(entry_for(&report.entries, "b.txt").line_ending, "LF");
        assert_eq!(entry_for(&report.entries, "c.txt").line_ending, "LF");
        assert_eq!(entry_for(&report.entries, "emoji.txt").line_ending, "LF");
        assert_eq!(entry_for(&report.entries, "d.txt").line_ending, "LF");
        assert_eq!(entry_for(&report.entries, "crlf.txt").line_ending, "CRLF");

        // Convert the convertible subset (alreadyTarget files excluded).
        let paths = vec![
            dir.join("a.txt").to_string_lossy().into_owned(),
            dir.join("b.txt").to_string_lossy().into_owned(),
            sub.join("d.txt").to_string_lossy().into_owned(),
            dir.join("crlf.txt").to_string_lossy().into_owned(),
        ];
        let results = execute_batch_conversion(
            paths.clone(),
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 4);
        for result in &results {
            assert!(result.ok, "{result:?}");
        }

        // Re-read every converted file: content matches the original
        // decoded text exactly, encoding is now UTF-8 with no BOM.
        for (path, expected) in [
            (dir.join("a.txt"), BIG5_TEXT_A),
            (dir.join("b.txt"), BIG5_TEXT_B),
            (sub.join("d.txt"), SHIFT_JIS_TEXT),
            (dir.join("crlf.txt"), BIG5_CRLF_TEXT),
        ] {
            let bytes = std::fs::read(&path).unwrap();
            assert_ne!(
                &bytes[..bytes.len().min(3)],
                [0xEF, 0xBB, 0xBF],
                "no BOM was requested"
            );
            let decoded = encoding::decode_auto(&bytes);
            assert_eq!(decoded.encoding, "UTF-8");
            assert!(!decoded.malformed);
            assert_eq!(decoded.content, expected, "content mismatch for {path:?}");
        }

        // The CRLF fixture specifically: line endings must survive
        // byte-for-byte, never collapsed to LF.
        let crlf_bytes = std::fs::read(dir.join("crlf.txt")).unwrap();
        let crlf_text = String::from_utf8(crlf_bytes).unwrap();
        assert_eq!(
            crlf_text.matches("\r\n").count(),
            BIG5_CRLF_TEXT.matches("\r\n").count(),
            "every CRLF must survive the conversion"
        );
        assert_eq!(crlf_text, BIG5_CRLF_TEXT);

        // Untouched files: alreadyTarget and the extension-filtered .png.
        assert_eq!(
            std::fs::read(dir.join("c.txt")).unwrap(),
            utf8_text.as_bytes()
        );
        assert_eq!(
            std::fs::read(dir.join("emoji.txt")).unwrap(),
            emoji_text.as_bytes()
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn execute_refuses_lossy_conversion_and_leaves_bytes_untouched() {
        let dir = fixture_dir("lossy");
        let original = "rocket emoji not representable in Big5: 🚀"
            .as_bytes()
            .to_vec();
        let file = dir.join("emoji.txt");
        std::fs::write(&file, &original).unwrap();
        let path = file.to_string_lossy().into_owned();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "Big5".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].status, STATUS_LOSSY);

        // Force execute on the flagged path anyway: the real safety net
        // must be here, not merely in the UI's respect for the scan's
        // advice.
        let results = execute_batch_conversion(
            vec![path.clone()],
            "Big5".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(!results[0].ok);
        assert_eq!(
            std::fs::read(&file).unwrap(),
            original,
            "a refused conversion must never touch the file's bytes"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_aborts_over_the_limit() {
        let dir = fixture_dir("limit");
        for i in 0..5 {
            std::fs::write(dir.join(format!("f{i}.txt")), "hello").unwrap();
        }

        let err = scan_with_limit(
            dir.to_string_lossy().as_ref(),
            &[],
            "UTF-8",
            false,
            "keep",
            3,
        )
        .unwrap_err();
        assert!(
            err.contains('3'),
            "error message should mention the limit: {err}"
        );

        let ok = scan_with_limit(
            dir.to_string_lossy().as_ref(),
            &[],
            "UTF-8",
            false,
            "keep",
            10,
        )
        .unwrap();
        assert_eq!(ok.entries.len(), 5);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn too_large_files_are_skipped_without_reading() {
        let dir = fixture_dir("toolarge");
        let file = dir.join("big.bin");
        let data = vec![b'a'; (MAX_FILE_SIZE + 1) as usize];
        std::fs::write(&file, &data).unwrap();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].status, STATUS_TOO_LARGE);
        assert_eq!(report.entries[0].detected, "");
        assert_eq!(report.entries[0].line_ending, "");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn already_target_requires_matching_bom_state_not_just_encoding_name() {
        let dir = fixture_dir("bom-mismatch");
        let (bytes, _) = encoding::encode("hello world", "UTF-8", true).unwrap();
        std::fs::write(dir.join("bom.txt"), &bytes).unwrap();

        // Same encoding name, but the target wants no BOM: must not be
        // treated as already-converted.
        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries[0].status, STATUS_CONVERTIBLE);

        // Target matching the BOM too: genuinely already-target.
        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "UTF-8".to_string(),
            true,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries[0].status, STATUS_ALREADY_TARGET);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn extension_filter_is_case_insensitive_and_dot_less() {
        let lower = vec!["txt".to_string(), "md".to_string()];
        assert!(extension_matches(Path::new("/a/b/file.TXT"), &lower));
        assert!(extension_matches(Path::new("/a/b/file.md"), &lower));
        assert!(!extension_matches(Path::new("/a/b/file.rs"), &lower));
        assert!(!extension_matches(Path::new("/a/b/file"), &lower));
        assert!(extension_matches(Path::new("/a/b/anything"), &[]));
    }

    /// Adversarial-review follow-up: a pure ASCII file detects as
    /// windows-1252, classifies as convertible toward UTF-8, and would be
    /// rewritten byte-for-byte identical — pointlessly churning mtime and
    /// firing watcher reloads. Byte-identical output must skip the write.
    #[test]
    fn byte_identical_conversion_skips_the_write() {
        let dir = fixture_dir("noop");
        let file = dir.join("ascii.txt");
        std::fs::write(&file, b"plain ascii, nothing to convert\n").unwrap();
        let before = std::fs::metadata(&file).unwrap().modified().unwrap();

        let results = execute_batch_conversion(
            vec![file.to_string_lossy().into_owned()],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok);
        assert!(
            results[0].message.contains("byte-identical"),
            "no-op must be reported as such, got: {}",
            results[0].message
        );
        let after = std::fs::metadata(&file).unwrap().modified().unwrap();
        assert_eq!(before, after, "file must not be rewritten");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Core red-to-green case for this PR: line endings unify while the
    /// encoding axis is left alone (`target_encoding: "keep"`).
    #[test]
    fn converts_crlf_to_lf_keeping_encoding() {
        let dir = fixture_dir("crlf-to-lf-keep-encoding");
        let (bytes, unmappable) = encoding::encode(BIG5_CRLF_TEXT, "Big5", false).unwrap();
        assert!(!unmappable);
        let file = dir.join("a.txt");
        std::fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let results = execute_batch_conversion(
            vec![path.clone()],
            "keep".to_string(),
            false,
            "LF".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "{:?}", results[0]);

        let out_bytes = std::fs::read(&file).unwrap();
        let decoded = encoding::decode_auto(&out_bytes);
        assert_eq!(decoded.encoding, "Big5", "encoding axis was kept");
        assert_eq!(encoding::detect_line_ending(&decoded.content), "LF");
        assert_eq!(decoded.content, encoding::normalize_to_lf(BIG5_CRLF_TEXT));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Both axes change together: encoding and line ending in one pass.
    #[test]
    fn converts_lf_to_crlf_with_encoding_change() {
        let dir = fixture_dir("lf-to-crlf-with-encoding-change");
        let file = dir.join("a.txt");
        std::fs::write(&file, BIG5_TEXT_A.as_bytes()).unwrap();
        let path = file.to_string_lossy().into_owned();

        let results = execute_batch_conversion(
            vec![path.clone()],
            "Big5".to_string(),
            false,
            "CRLF".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "{:?}", results[0]);

        let out_bytes = std::fs::read(&file).unwrap();
        let decoded = encoding::decode_auto(&out_bytes);
        assert_eq!(decoded.encoding, "Big5");
        assert_eq!(encoding::detect_line_ending(&decoded.content), "CRLF");
        assert_eq!(decoded.content, BIG5_TEXT_A.replace('\n', "\r\n"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A Mixed-line-ending source file collapses entirely to the requested
    /// target, not just its majority style.
    #[test]
    fn mixed_line_endings_unify() {
        let dir = fixture_dir("mixed-unify");
        let text = "第一行結尾是 CRLF。\r\n第二行結尾是 LF。\n第三行結尾是 CRLF。\r\n";
        assert_eq!(
            encoding::detect_line_ending(text),
            "Mixed",
            "fixture must actually mix CRLF and LF"
        );
        let file = dir.join("a.txt");
        std::fs::write(&file, text.as_bytes()).unwrap();
        let path = file.to_string_lossy().into_owned();

        let results = execute_batch_conversion(
            vec![path.clone()],
            "keep".to_string(),
            false,
            "LF".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "{:?}", results[0]);

        let out_bytes = std::fs::read(&file).unwrap();
        let decoded = encoding::decode_auto(&out_bytes);
        assert_eq!(encoding::detect_line_ending(&decoded.content), "LF");
        assert_eq!(decoded.content, encoding::normalize_to_lf(text));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `keep` + `keep`: neither axis changes, so every file — regardless
    /// of its own encoding or line ending — classifies `alreadyTarget`.
    #[test]
    fn keep_keep_classifies_already_target() {
        let dir = fixture_dir("keep-keep");
        std::fs::write(
            dir.join("utf8-mixed.txt"),
            "已經是 UTF-8。\r\n混合行尾。\n第三行。\r\n".as_bytes(),
        )
        .unwrap();
        let (big5_bytes, unmappable) = encoding::encode(BIG5_CRLF_TEXT, "Big5", false).unwrap();
        assert!(!unmappable);
        std::fs::write(dir.join("big5-crlf.txt"), &big5_bytes).unwrap();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "keep".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries.len(), 2);
        for entry in &report.entries {
            assert_eq!(entry.status, STATUS_ALREADY_TARGET, "{entry:?}");
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The line-ending axis alone decides `alreadyTarget` vs `convertible`
    /// when the encoding axis is `keep` throughout.
    #[test]
    fn line_ending_axis_affects_classification() {
        let dir = fixture_dir("line-ending-axis");
        std::fs::write(dir.join("lf.txt"), "已經是 LF。\n第二行。\n".as_bytes()).unwrap();
        std::fs::write(
            dir.join("crlf.txt"),
            "目前是 CRLF。\r\n第二行。\r\n".as_bytes(),
        )
        .unwrap();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "keep".to_string(),
            false,
            "LF".to_string(),
        )
        .unwrap();
        assert_eq!(
            entry_for(&report.entries, "lf.txt").status,
            STATUS_ALREADY_TARGET
        );
        assert_eq!(
            entry_for(&report.entries, "crlf.txt").status,
            STATUS_CONVERTIBLE
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}

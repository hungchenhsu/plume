//! Batch encoding conversion: scan a folder for a dry-run report, then
//! convert selected files to a target encoding, one atomic write per file.
//! Track A of the v0.3 roadmap (ROADMAP.md) — the next PR adds batch
//! line-ending conversion on the same dialog; `BatchEntry::line_ending` is
//! reserved for that PR now so the report shape does not change again when
//! it lands, but this module itself never inspects or rewrites a line
//! ending.
//!
//! Folder walking mirrors `search.rs`'s find-in-files traversal (same
//! `SKIP_DIRS`, same dotdir/symlink skip rules) so batch conversion never
//! descends into VCS metadata or dependency trees either.
//!
//! Data-integrity invariant this module exists to protect (see
//! `convert_one`): a converted file's *line endings* are never touched.
//! Both classification and conversion work on the raw decode of a file's
//! own bytes — never run through `encoding::normalize_to_lf` the way
//! `lib.rs::open_document` normalizes for the editor buffer — so a CRLF
//! file stays CRLF and an LF file stays LF; only the byte-level encoding
//! changes.
//!
//! Deviation from the original task sketch: `scan_batch_conversion` takes
//! an explicit `target_with_bom: bool` parameter (mirroring
//! `execute_batch_conversion`'s existing one), even though the initial
//! signature sketch omitted it. The spec's own classification rule —
//! "already target: encoding name *and* BOM state both match" — cannot be
//! implemented without knowing the target's desired BOM state, so this is
//! treated as a required correction rather than a deviation to avoid.

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
    /// Reserved for the batch line-ending-conversion PR (the entry's
    /// detected source line ending). Always `None` in this PR.
    pub line_ending: Option<String>,
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

/// Classify one file against `target`/`target_with_bom`. Never fails: an
/// unreadable file (permission error, vanished mid-scan) is reported as
/// `undecodable` rather than aborting the whole scan.
fn classify_file(path: &Path, target: &'static Encoding, target_with_bom: bool) -> BatchEntry {
    let path_str = path.to_string_lossy().into_owned();

    let too_large = std::fs::metadata(path)
        .map(|m| m.len() > MAX_FILE_SIZE)
        .unwrap_or(false);
    if too_large {
        return BatchEntry {
            path: path_str,
            detected: String::new(),
            status: STATUS_TOO_LARGE.to_string(),
            line_ending: None,
        };
    }

    let Ok(bytes) = std::fs::read(path) else {
        return BatchEntry {
            path: path_str,
            detected: String::new(),
            status: STATUS_UNDECODABLE.to_string(),
            line_ending: None,
        };
    };

    // No per-extension hint: matches the task's "encoding::detect, no
    // hint" instruction and keeps scan/execute using the identical
    // detection path (`convert_one` also calls plain `decode_auto`).
    let decoded = encoding::decode_auto(&bytes);
    if decoded.malformed {
        return BatchEntry {
            path: path_str,
            detected: decoded.encoding,
            status: STATUS_UNDECODABLE.to_string(),
            line_ending: None,
        };
    }

    let source = Encoding::for_label(decoded.encoding.as_bytes());
    if source == Some(target) && decoded.had_bom == target_with_bom {
        return BatchEntry {
            path: path_str,
            detected: decoded.encoding,
            status: STATUS_ALREADY_TARGET.to_string(),
            line_ending: None,
        };
    }

    // `target` was already validated as a real encoding by the caller
    // (`scan_with_limit`), and `target.name()` always round-trips through
    // `Encoding::for_label`, so this can never hit the Err arm.
    let (_, unmappable) = encoding::encode(&decoded.content, target.name(), target_with_bom)
        .expect("target encoding validated by the caller");
    BatchEntry {
        path: path_str,
        detected: decoded.encoding,
        status: if unmappable {
            STATUS_LOSSY
        } else {
            STATUS_CONVERTIBLE
        }
        .to_string(),
        line_ending: None,
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
    limit: usize,
) -> Result<BatchScanReport, String> {
    let target = Encoding::for_label(target_encoding.as_bytes())
        .ok_or_else(|| format!("Unknown target encoding: {target_encoding}"))?;
    let lower_extensions: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();

    let mut files = Vec::new();
    collect_files(Path::new(dir), &lower_extensions, limit, &mut files)?;

    let entries = files
        .iter()
        .map(|path| classify_file(path, target, target_with_bom))
        .collect();
    Ok(BatchScanReport { entries })
}

/// Dry-run scan: classify every matching file under `dir` against
/// `target_encoding`/`target_with_bom` without changing anything on disk.
/// `extensions` is a list of lowercase, dot-less extensions ("txt", not
/// ".txt" or "TXT" — matching is case-insensitive regardless); an empty
/// list matches every file. See `classify_file` for the per-file decision:
/// `tooLarge` (> 10 MiB) short-circuits before any read; otherwise the
/// file is auto-detected (no per-extension hint, matching
/// `encoding::decode_auto`) and classified `undecodable` / `alreadyTarget`
/// / `lossy` / `convertible`.
#[tauri::command]
pub fn scan_batch_conversion(
    dir: String,
    extensions: Vec<String>,
    target_encoding: String,
    target_with_bom: bool,
) -> Result<BatchScanReport, String> {
    scan_with_limit(
        &dir,
        &extensions,
        &target_encoding,
        target_with_bom,
        MAX_FILES,
    )
}

/// Convert one file: re-detect and re-decode fresh from disk (never trust
/// the scan's snapshot — the file may have changed since the dry run),
/// re-encode the *raw decoded text* to the target (never run through
/// `encoding::normalize_to_lf`, so line endings survive exactly as they
/// are on disk), then atomically write the result. Never partially
/// writes: a decode or encode failure returns `ok: false` with the
/// original file left untouched.
fn convert_one(path: &str, target: &'static Encoding, with_bom: bool) -> BatchConvertResult {
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
    // does for the editor buffer. Re-encoding it straight back changes
    // only the byte-level encoding; every line ending is preserved.
    let decoded = encoding::decode_auto(&bytes);
    if decoded.malformed {
        return BatchConvertResult {
            path: path.to_string(),
            ok: false,
            message: "File no longer decodes cleanly; skipped.".to_string(),
        };
    }

    let (out_bytes, unmappable) = match encoding::encode(&decoded.content, target.name(), with_bom)
    {
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
    // ASCII file "converting" to UTF-8, say): skip the write entirely so
    // the file's mtime is untouched and no watcher reload fires for a
    // no-op (adversarial-review finding).
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

/// Convert every path in `paths` to `target_encoding`/`with_bom`. One
/// file's failure never stops the batch — every path gets its own
/// `BatchConvertResult`. `paths` is normally the `convertible` subset of a
/// prior `scan_batch_conversion` report, but this never trusts that: each
/// file is independently re-detected and re-encoded (see `convert_one`).
#[tauri::command]
pub fn execute_batch_conversion(
    paths: Vec<String>,
    target_encoding: String,
    with_bom: bool,
) -> Result<Vec<BatchConvertResult>, String> {
    let target = Encoding::for_label(target_encoding.as_bytes())
        .ok_or_else(|| format!("Unknown target encoding: {target_encoding}"))?;
    Ok(paths
        .iter()
        .map(|path| convert_one(path, target, with_bom))
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

        // Every entry's line_ending is reserved (None) in this PR.
        for e in &report.entries {
            assert_eq!(e.line_ending, None);
        }

        // Convert the convertible subset (alreadyTarget files excluded).
        let paths = vec![
            dir.join("a.txt").to_string_lossy().into_owned(),
            dir.join("b.txt").to_string_lossy().into_owned(),
            sub.join("d.txt").to_string_lossy().into_owned(),
            dir.join("crlf.txt").to_string_lossy().into_owned(),
        ];
        let results = execute_batch_conversion(paths.clone(), "UTF-8".to_string(), false).unwrap();
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
        )
        .unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].status, STATUS_LOSSY);

        // Force execute on the flagged path anyway: the real safety net
        // must be here, not merely in the UI's respect for the scan's
        // advice.
        let results =
            execute_batch_conversion(vec![path.clone()], "Big5".to_string(), false).unwrap();
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

        let err =
            scan_with_limit(dir.to_string_lossy().as_ref(), &[], "UTF-8", false, 3).unwrap_err();
        assert!(
            err.contains('3'),
            "error message should mention the limit: {err}"
        );

        let ok = scan_with_limit(dir.to_string_lossy().as_ref(), &[], "UTF-8", false, 10).unwrap();
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
        )
        .unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].status, STATUS_TOO_LARGE);
        assert_eq!(report.entries[0].detected, "");

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
        )
        .unwrap();
        assert_eq!(report.entries[0].status, STATUS_CONVERTIBLE);

        // Target matching the BOM too: genuinely already-target.
        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "UTF-8".to_string(),
            true,
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
}

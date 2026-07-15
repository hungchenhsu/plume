//! Find-in-files backend. Files are decoded through the same detection
//! pipeline as the editor, so matches are found in legacy-encoded files
//! (Big5, Shift_JIS, …) that byte-oriented search would miss.

use crate::encoding;
use crate::linebreak;
use serde::Serialize;
use std::path::{Path, PathBuf};

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
];
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;
const MAX_RESULTS: usize = 500;
const MAX_PREVIEW_CHARS: usize = 200;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub preview: String,
}

/// A directory or entry the walk could not read at all — recorded instead
/// of silently skipped (issue #130, the same fix issue #116 applied to
/// `batch.rs::collect_files`; the two walks are twin implementations, see
/// that module's doc comment). `path` is the containing directory when the
/// directory listing itself failed (`read_dir`), or the specific entry's
/// own path when only its metadata lookup failed; `message` is the OS error
/// text (e.g. "Permission denied (os error 13)").
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub files_scanned: usize,
    /// Directories or entries the walk could not read — each one means
    /// `matches` above may be missing whatever matches that path contained.
    /// Empty means the walk completed exhaustively; a non-empty list must
    /// never be read as "no matches under that path" (issue #130). The root
    /// folder itself failing to open is a harder failure than this —
    /// `search_in_folder` returns `Err` outright instead of an
    /// empty-looking result.
    pub scan_errors: Vec<ScanError>,
}

fn collect_files(dir: &Path, files: &mut Vec<PathBuf>, scan_errors: &mut Vec<ScanError>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            scan_errors.push(ScanError {
                path: dir.to_string_lossy().into_owned(),
                message: e.to_string(),
            });
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                // The OS returned an entry-less error mid-iteration (rare
                // transient I/O failure) — no path to report beyond the
                // directory being walked.
                scan_errors.push(ScanError {
                    path: dir.to_string_lossy().into_owned(),
                    message: e.to_string(),
                });
                continue;
            }
        };
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(e) => {
                scan_errors.push(ScanError {
                    path: path.to_string_lossy().into_owned(),
                    message: e.to_string(),
                });
                continue;
            }
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
            collect_files(&path, files, scan_errors);
        } else if meta.is_file() && meta.len() <= MAX_FILE_SIZE {
            files.push(path);
        }
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(1024).any(|&b| b == 0)
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// How a line is tested against the query.
enum Matcher {
    Literal {
        needle: String,
        case_sensitive: bool,
    },
    Regex(regex::Regex),
}

impl Matcher {
    fn new(query: &str, case_sensitive: bool, use_regex: bool) -> Result<Self, String> {
        if use_regex {
            let re = regex::RegexBuilder::new(query)
                .case_insensitive(!case_sensitive)
                .build()
                .map_err(|e| format!("Invalid regex: {e}"))?;
            Ok(Matcher::Regex(re))
        } else {
            Ok(Matcher::Literal {
                needle: if case_sensitive {
                    query.to_string()
                } else {
                    query.to_lowercase()
                },
                case_sensitive,
            })
        }
    }

    fn matches(&self, line: &str) -> bool {
        match self {
            Matcher::Literal {
                needle,
                case_sensitive,
            } => {
                if *case_sensitive {
                    line.contains(needle.as_str())
                } else {
                    line.to_lowercase().contains(needle.as_str())
                }
            }
            Matcher::Regex(re) => re.is_match(line),
        }
    }
}

/// Search decoded lines of one file, appending matches. Lines are split
/// with `linebreak::split_str_lines` — the shared LF/CRLF/lone-CR
/// definition `replaceinfiles.rs` and the large-file index already use —
/// rather than `str::lines()`, which does not recognize a lone CR
/// (Classic Mac line endings) as a terminator at all and so would treat a
/// whole CR-only file as a single line (issue #162).
fn search_text(text: &str, matcher: &Matcher, path: &str, out: &mut Vec<SearchMatch>) {
    for (index, line) in linebreak::split_str_lines(text).into_iter().enumerate() {
        if matcher.matches(line) {
            out.push(SearchMatch {
                path: path.to_string(),
                line: index + 1,
                preview: truncate_chars(line.trim_end(), MAX_PREVIEW_CHARS),
            });
            if out.len() >= MAX_RESULTS {
                return;
            }
        }
    }
}

#[tauri::command(async)]
pub fn search_in_folder(
    folder: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
) -> Result<SearchResults, String> {
    if query.is_empty() {
        return Ok(SearchResults {
            matches: Vec::new(),
            truncated: false,
            files_scanned: 0,
            scan_errors: Vec::new(),
        });
    }
    let matcher = Matcher::new(&query, case_sensitive, use_regex)?;

    // Fail closed if the root folder itself can't even be listed (doesn't
    // exist, permissions revoked, vanished) — issue #130, mirroring
    // batch.rs's identical `scan_batch_conversion` guard for issue #116. An
    // empty result would look indistinguishable from "genuinely no
    // matches" and hand the user false confidence that a search term is
    // absent from the whole project when really the search never ran at
    // all. This is deliberately a harder failure than a nested
    // subdirectory hitting the same error inside `collect_files` below,
    // which instead records the error and keeps searching whatever the
    // rest of the tree can still offer.
    std::fs::read_dir(&folder).map_err(|e| format!("Cannot read folder {folder}: {e}"))?;

    let mut files = Vec::new();
    let mut scan_errors = Vec::new();
    collect_files(Path::new(&folder), &mut files, &mut scan_errors);

    let mut matches = Vec::new();
    let mut files_scanned = 0usize;
    for file in &files {
        let Ok(bytes) = std::fs::read(file) else {
            continue;
        };
        if looks_binary(&bytes) {
            continue;
        }
        files_scanned += 1;
        let decoded = encoding::decode_auto(&bytes);
        search_text(
            &decoded.content,
            &matcher,
            &file.to_string_lossy(),
            &mut matches,
        );
        if matches.len() >= MAX_RESULTS {
            break;
        }
    }
    Ok(SearchResults {
        truncated: matches.len() >= MAX_RESULTS,
        matches,
        files_scanned,
        scan_errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("plume-search-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_matches_in_utf8_and_big5_files() {
        let dir = fixture_dir("mixed");
        std::fs::write(dir.join("a.txt"), "hello world\nsecond line\n").unwrap();
        let (big5_bytes, _) = encoding::encode("第一行\n搜尋目標在這\n", "Big5", false).unwrap();
        std::fs::write(dir.join("b.txt"), big5_bytes).unwrap();

        let results = search_in_folder(
            dir.to_string_lossy().into_owned(),
            "目標".into(),
            true,
            false,
        )
        .unwrap();
        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.matches[0].line, 2);
        assert!(results.matches[0].preview.contains("搜尋目標"));

        let results = search_in_folder(
            dir.to_string_lossy().into_owned(),
            "HELLO".into(),
            false,
            false,
        )
        .unwrap();
        assert_eq!(results.matches.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn regex_mode_matches_across_encodings() {
        let dir = fixture_dir("regex");
        std::fs::write(dir.join("a.log"), "ERROR 2026-06-13 boom\ninfo ok\n").unwrap();
        let (big5_bytes, _) = encoding::encode("錯誤代碼:E42\n正常\n", "Big5", false).unwrap();
        std::fs::write(dir.join("b.txt"), big5_bytes).unwrap();

        let results = search_in_folder(
            dir.to_string_lossy().into_owned(),
            r"^error \d{4}".into(),
            false,
            true,
        )
        .unwrap();
        assert_eq!(results.matches.len(), 1);
        assert!(results.matches[0].preview.starts_with("ERROR 2026"));

        let results = search_in_folder(
            dir.to_string_lossy().into_owned(),
            r"代碼:E\d+".into(),
            true,
            true,
        )
        .unwrap();
        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.matches[0].line, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn invalid_regex_returns_friendly_error() {
        let dir = fixture_dir("badregex");
        let result = search_in_folder(
            dir.to_string_lossy().into_owned(),
            "[unclosed".into(),
            true,
            true,
        );
        assert!(result.unwrap_err().starts_with("Invalid regex"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skips_binary_files_and_hidden_dirs() {
        let dir = fixture_dir("skip");
        std::fs::write(dir.join("bin.dat"), [0u8, 159, 1, 2, 0]).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("c.txt"), "needle\n").unwrap();

        let results = search_in_folder(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
        )
        .unwrap();
        assert!(results.matches.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #130 (failing-test-first): unlike `batch.rs`'s destructive
    /// execute step, find-in-files has nothing to gate — but a root the
    /// caller explicitly picked failing to open must still fail closed
    /// rather than come back looking like "genuinely no matches", which is
    /// exactly the misjudgment risk the issue describes (e.g. mistaking
    /// "the folder vanished" for "this string isn't in the project
    /// anywhere").
    #[test]
    fn nonexistent_root_fails_closed() {
        let dir = std::env::temp_dir().join("plume-search-nonexistent-does-not-exist");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!dir.exists(), "fixture precondition: path must not exist");

        let err = search_in_folder(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
        )
        .unwrap_err();
        assert!(
            err.contains(&dir.to_string_lossy().into_owned()) || !err.is_empty(),
            "error should explain the folder could not be read: {err}"
        );
    }

    /// Issue #130 (failing-test-first): a subdirectory that can't be listed
    /// (permission revoked, or vanished mid-walk) used to be silently
    /// dropped by `collect_files`'s `let Ok(entries) = ... else { return }`
    /// — the results looked complete while quietly missing an entire
    /// subtree. It must now show up in `SearchResults.scan_errors`, and —
    /// unlike the whole-root failure above — must not stop the rest of the
    /// tree (an unrelated readable sibling file) from being searched and
    /// reported normally.
    #[cfg(unix)]
    #[test]
    fn unreadable_subdirectory_is_reported_not_silently_dropped() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture_dir("unreadable-subdir");
        std::fs::write(dir.join("readable.txt"), "needle here\n").unwrap();
        let locked = dir.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("hidden.txt"), "needle must never be seen\n").unwrap();
        // No read/execute bit at all: `read_dir(&locked)` itself fails.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let results = search_in_folder(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
        );

        // Restore permissions immediately — before any assertion below can
        // panic and leave a locked directory behind for the next test run
        // on this machine (`remove_dir_all` can't recurse into it either).
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

        let results = results.expect("a locked subdirectory must not fail the whole search closed");
        assert_eq!(
            results.matches.len(),
            1,
            "the readable sibling file must still be searched: {:?}",
            results.matches
        );
        assert_eq!(
            results.scan_errors.len(),
            1,
            "the locked directory must be surfaced, not silently dropped: {:?}",
            results.scan_errors
        );
        assert!(
            Path::new(&results.scan_errors[0].path).ends_with("locked"),
            "scan error should name the locked directory: {:?}",
            results.scan_errors[0]
        );
        assert!(
            !results.scan_errors[0].message.is_empty(),
            "scan error should carry the OS error text"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #130 (failing-test-first), the other silently-dropped path:
    /// `entry.metadata()` failing (as opposed to `read_dir` on the
    /// containing directory failing, covered above). A directory with read
    /// permission but no execute/search bit lets `read_dir` list child
    /// names just fine, but resolving/stat-ing any child through it fails —
    /// reproducing this half of the bug deterministically rather than
    /// racing a real vanish-mid-walk.
    #[cfg(unix)]
    #[test]
    fn entries_with_unreadable_metadata_are_reported_not_silently_skipped() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture_dir("no-execute-bit");
        std::fs::write(dir.join("readable.txt"), "needle here\n").unwrap();
        let no_exec = dir.join("noexec");
        std::fs::create_dir_all(&no_exec).unwrap();
        std::fs::write(no_exec.join("hidden.txt"), "needle unreachable\n").unwrap();
        // Read-only, no execute: `read_dir` can still enumerate
        // "hidden.txt"'s name, but `entry.metadata()` on it fails to
        // resolve/stat the child (needs search permission on `no_exec`).
        std::fs::set_permissions(&no_exec, std::fs::Permissions::from_mode(0o600)).unwrap();

        let results = search_in_folder(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
        );

        // Restore before any assertion can panic — same reasoning as
        // unreadable_subdirectory_is_reported_not_silently_dropped above.
        std::fs::set_permissions(&no_exec, std::fs::Permissions::from_mode(0o755)).unwrap();

        let results = results.expect("an unreadable entry must not fail the whole search closed");
        assert_eq!(
            results.matches.len(),
            1,
            "the readable sibling file must still be searched: {:?}",
            results.matches
        );
        assert_eq!(
            results.scan_errors.len(),
            1,
            "the unreadable child's metadata failure must be surfaced, not silently skipped: {:?}",
            results.scan_errors
        );
        assert!(
            Path::new(&results.scan_errors[0].path).ends_with("hidden.txt"),
            "scan error should name the specific entry whose metadata failed: {:?}",
            results.scan_errors[0]
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- Issue #162: lone-CR line semantics -----------------------------
    //
    // `search_text` used to split lines with `str::lines()`, which only
    // recognizes LF and CRLF -- a lone CR (Classic Mac line endings) was
    // never treated as a terminator at all, so an entire CR-only file
    // collapsed into a single "line" for search purposes. This silently
    // disagreed with `replaceinfiles.rs`, which already splits lines via
    // the shared `linebreak::scan_line_breaks` three-way (LF/CRLF/lone CR)
    // definition -- the same panel's Find and Replace tabs could report
    // different line numbers (and match counts) for the same file.
    // `search_text` now splits through `linebreak::split_str_lines`
    // instead, the `&str`-level counterpart of that same shared
    // definition (see `linebreak.rs`'s own equivalence test locking the
    // two together).

    /// Failing-test-first, issue #162: a lone CR must terminate a line.
    /// Before the fix, `first\rneedle\rthird` was one `str::lines()` line,
    /// so "needle" was reported on line 1 with the whole string as its
    /// preview; it must be line 2 with just "needle" as the preview.
    #[test]
    fn search_text_recognizes_lone_cr_as_a_line_terminator() {
        let matcher = Matcher::new("needle", true, false).unwrap();
        let mut out = Vec::new();
        search_text("first\rneedle\rthird", &matcher, "doc.txt", &mut out);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(
            out[0].line, 2,
            "needle sits on the second lone-CR-delimited line"
        );
        assert_eq!(out[0].preview, "needle");
    }

    /// Regression: CRLF must still count as *one* terminator, not two
    /// lines plus a spurious empty line.
    #[test]
    fn search_text_crlf_terminator_unchanged() {
        let matcher = Matcher::new("needle", true, false).unwrap();
        let mut out = Vec::new();
        search_text("first\r\nneedle\r\nthird", &matcher, "doc.txt", &mut out);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].line, 2);
        assert_eq!(out[0].preview, "needle");
    }

    /// Regression: plain LF files are unaffected by the switch away from
    /// `str::lines()`.
    #[test]
    fn search_text_lf_terminator_unchanged() {
        let matcher = Matcher::new("needle", true, false).unwrap();
        let mut out = Vec::new();
        search_text("first\nneedle\nthird", &matcher, "doc.txt", &mut out);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].line, 2);
        assert_eq!(out[0].preview, "needle");
    }

    /// A file mixing all three terminator styles must still report correct
    /// 1-based line numbers for a match on any of them.
    #[test]
    fn search_text_mixed_terminators_report_correct_line_numbers() {
        let matcher = Matcher::new("needle", true, false).unwrap();
        let mut out = Vec::new();
        // line 1: LF-terminated, line 2: CRLF-terminated, line 3: lone-CR
        // terminated (the match), line 4: LF-terminated, line 5: no
        // terminator at all (EOF).
        search_text(
            "one\ntwo\r\nneedle\rfour\nfive",
            &matcher,
            "doc.txt",
            &mut out,
        );
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].line, 3);
        assert_eq!(out[0].preview, "needle");
    }

    /// End-to-end lock, issue #162's own framing: on a file where every
    /// matching line contains the needle exactly once, Find and
    /// Replace-in-Files must agree on the count for the same lone-CR
    /// (Classic Mac) file. (With several hits on one line the two
    /// legitimately differ by design: Find is line-oriented — one
    /// navigable entry per matching line — while Replace counts the
    /// occurrences it will actually replace.) Before this fix,
    /// `search_in_folder`
    /// collapsed the whole file into a single `str::lines()` "line", so a
    /// literal search reports one match per matching *line*, not one per
    /// matching *file* -- two needles on two separate lone-CR lines were
    /// undercounted as 1 (the single collapsed "line" merely contains the
    /// substring once, as far as `str::contains` is concerned), while
    /// `scan_replace_in_folder` (already using the three-way split)
    /// correctly reported 2. After the fix both report 2.
    #[test]
    fn search_and_replace_scan_agree_on_lone_cr_match_count() {
        let dir = fixture_dir("cross-module-agreement");
        std::fs::write(dir.join("doc.txt"), b"needle one\rneedle two\r").unwrap();

        let search_results = search_in_folder(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
        )
        .unwrap();
        assert_eq!(
            search_results.matches.len(),
            2,
            "one needle per lone-CR line: {:?}",
            search_results.matches
        );
        assert_eq!(search_results.matches[0].line, 1);
        assert_eq!(search_results.matches[1].line, 2);

        let replace_scan = crate::replaceinfiles::scan_replace_in_folder(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
            "X".into(),
        )
        .unwrap();
        assert_eq!(replace_scan.entries.len(), 1, "{:?}", replace_scan.entries);
        assert_eq!(
            replace_scan.entries[0].match_count, 2,
            "search and replace-scan must agree on how many matches this file contains"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}

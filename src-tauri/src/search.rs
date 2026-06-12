//! Find-in-files backend. Files are decoded through the same detection
//! pipeline as the editor, so matches are found in legacy-encoded files
//! (Big5, Shift_JIS, …) that byte-oriented search would miss.

use crate::encoding;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub preview: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub files_scanned: usize,
}

fn collect_files(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if path.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            collect_files(&path, files);
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

/// Search decoded lines of one file, appending matches.
fn search_text(
    text: &str,
    needle: &str,
    case_sensitive: bool,
    path: &str,
    out: &mut Vec<SearchMatch>,
) {
    for (index, line) in text.lines().enumerate() {
        let found = if case_sensitive {
            line.contains(needle)
        } else {
            line.to_lowercase().contains(needle)
        };
        if found {
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
) -> Result<SearchResults, String> {
    if query.is_empty() {
        return Ok(SearchResults {
            matches: Vec::new(),
            truncated: false,
            files_scanned: 0,
        });
    }
    let needle = if case_sensitive {
        query
    } else {
        query.to_lowercase()
    };

    let mut files = Vec::new();
    collect_files(Path::new(&folder), &mut files);

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
            &needle,
            case_sensitive,
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

        let results =
            search_in_folder(dir.to_string_lossy().into_owned(), "目標".into(), true).unwrap();
        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.matches[0].line, 2);
        assert!(results.matches[0].preview.contains("搜尋目標"));

        let results =
            search_in_folder(dir.to_string_lossy().into_owned(), "HELLO".into(), false).unwrap();
        assert_eq!(results.matches.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skips_binary_files_and_hidden_dirs() {
        let dir = fixture_dir("skip");
        std::fs::write(dir.join("bin.dat"), [0u8, 159, 1, 2, 0]).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("c.txt"), "needle\n").unwrap();

        let results =
            search_in_folder(dir.to_string_lossy().into_owned(), "needle".into(), true).unwrap();
        assert!(results.matches.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}

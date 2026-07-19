//! User preferences, stored as JSON in the app config directory. Fields use
//! `serde(default)` so settings added later still load old files cleanly.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Runtime};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    /// Empty string means the platform default monospace stack.
    pub font_family: String,
    pub font_size: u32,
    /// "system" | "light" | "dark"
    pub theme: String,
    /// UI language: "system" | "en" | "zh-TW" | "ja" | "zh-CN". "system"
    /// resolves via the OS locale (see `menu::resolve_lang`, `src/i18n.ts`
    /// on the frontend).
    pub language: String,
    /// Default encoding for new (untitled) documents.
    pub default_encoding: String,
    pub default_bom: bool,
    pub word_wrap: bool,
    /// Render invisible characters: space dots, tab arrows, EOL marks.
    pub show_invisibles: bool,
    /// Indent-guide vertical lines (View menu). Default `true`, unlike
    /// `show_invisibles`'s `false` — see `Default` impl below for why.
    pub indent_guides: bool,
    /// Inline highlighting of the curated invisible/ambiguous character
    /// audit (View menu; ROADMAP.md v0.4 Track A). Default `true` like
    /// `indent_guides`, but for a different reason — see `Default` impl
    /// below. Only gates the CM6 inline highlight; the status-bar
    /// suspicious-character count is independent of this preference (see
    /// `src/main.ts` `computeAndShowSuspiciousChars`).
    pub suspicious_chars: bool,
    /// Fallback indent width (spaces-per-level / tab display width) used
    /// when per-buffer indentation detection can't confidently infer one —
    /// no indentation in the file, or an inconsistent tabs+spaces mix
    /// (ROADMAP.md v0.4 Track C; see `src/indentdetect.ts`
    /// `detectIndentation` and `src/editor.ts`
    /// `EditorHandle.setIndentation`). Also the tab *display* width for a
    /// tabs-indented file: unlike a spaces file's step, a tab's own visual
    /// width can never be inferred from the tab characters themselves, so
    /// detected "tabs" indentation always falls back to this value for
    /// `EditorState.tabSize` even though its `indentUnit` ("\t") is still
    /// confidently detected.
    pub indent_width: u32,
    /// Per-extension default encoding, e.g. `[("txt", "Big5")]`. Extension
    /// is stored without a leading dot, lowercase (the frontend normalizes
    /// before persisting; see `src/extensionEncodings.ts`). Auto-detection
    /// only honors an entry when the file has no BOM, is not valid
    /// non-ASCII UTF-8 (confident UTF-8 always wins), and the entry's
    /// encoding decodes the sample without malformed sequences — see
    /// `encoding::detect_with_extension`.
    pub extension_encodings: Vec<(String, String)>,
    /// Opt-in: strip trailing spaces/tabs from every line as part of the
    /// normal save flow (ROADMAP.md v0.7 Track C, "trim trailing whitespace
    /// on save"). Default `false`, like `show_invisibles` — unlike
    /// `indent_guides`/`suspicious_chars`, this rewrites file content, not
    /// just a display setting. Read only by the frontend (`src/main.ts`'s
    /// `runSaveFlow`, gated through `src/trimonsave.ts`'s
    /// `shouldTrimTrailingWhitespaceOnSave`); the Rust core never inspects
    /// this field itself, the same way it never inspects `word_wrap` or
    /// `theme`.
    pub trim_trailing_whitespace_on_save: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            font_family: String::new(),
            font_size: 13,
            theme: "system".into(),
            language: "system".into(),
            default_encoding: "UTF-8".into(),
            default_bom: false,
            word_wrap: true,
            show_invisibles: false,
            // Industry convention (VS Code, Sublime, JetBrains) defaults
            // indent guides on — they're a subtle alignment aid, unlike
            // show_invisibles' raw whitespace glyphs, which are visually
            // noisier and better opt-in.
            indent_guides: true,
            // Also default on, but for a different reason than
            // indent_guides: this is a trust/security signal (bidi-control/
            // zero-width character highlighting), not a convenience aid, so
            // it should be visible without the user having to know to opt in.
            suspicious_chars: true,
            // Common default across editors (VS Code, Sublime, JetBrains);
            // only used as a fallback when detection can't infer a width —
            // see the field's own doc comment above.
            indent_width: 4,
            extension_encodings: Vec::new(),
            // Opt-in, like show_invisibles: rewrites file content, so it
            // must not surprise a user who never asked for it — see the
            // field's own doc comment above.
            trim_trailing_whitespace_on_save: false,
        }
    }
}

/// Current preferences, shared by the load command and the menu builder
/// (the View menu checkbox needs the persisted state at build time).
pub fn current<R: Runtime>(app: &AppHandle<R>) -> Preferences {
    crate::store::read_json(app, "preferences.json").unwrap_or_default()
}

/// Lowercase extension of `path`'s file name, or `None` when there is none
/// — no dot, a dotfile (leading dot, no other dot, e.g. ".gitignore"), or a
/// trailing dot. The Rust-side mirror of the frontend's `extensionOf`
/// (`src/extensionEncodings.ts`), which the Preferences dialog and
/// `open_document`'s caller already rely on for the same decision.
fn extension_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let dot = name.rfind('.')?;
    if dot == 0 || dot == name.len() - 1 {
        return None;
    }
    Some(name[dot + 1..].to_lowercase())
}

/// The encoding `extension_encodings` maps `path`'s extension to, or `None`
/// when the path has no usable extension or no entry matches. This
/// per-file lookup is the Rust-side counterpart of the frontend's
/// `lookupExtensionEncoding`, used by any command that walks a whole
/// folder (`replaceinfiles.rs`, `search.rs`) and therefore, unlike
/// `open_document`, can't have the frontend resolve a single hint ahead of
/// time — each file under the walk can have a different extension.
/// Case-insensitive on both sides: a table saved by the current frontend
/// is already normalized lowercase (`normalizeTable` in
/// `extensionEncodings.ts`), but this stays defensive against a
/// hand-edited or older-format `preferences.json`.
pub fn extension_encoding_for(
    extension_encodings: &[(String, String)],
    path: &Path,
) -> Option<String> {
    let ext = extension_of(path)?;
    extension_encodings
        .iter()
        .find(|(entry_ext, _)| entry_ext.eq_ignore_ascii_case(&ext))
        .map(|(_, encoding)| encoding.clone())
}

#[tauri::command]
pub fn load_preferences<R: Runtime>(app: AppHandle<R>) -> Preferences {
    current(&app)
}

#[tauri::command]
pub fn save_preferences<R: Runtime>(
    app: AppHandle<R>,
    preferences: Preferences,
) -> Result<(), String> {
    crate::store::write_json(&app, "preferences.json", &preferences)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sensible() {
        let prefs = Preferences::default();
        assert_eq!(prefs.font_size, 13);
        assert_eq!(prefs.theme, "system");
        assert_eq!(prefs.language, "system");
        assert_eq!(prefs.default_encoding, "UTF-8");
        assert!(!prefs.default_bom);
        assert!(prefs.indent_guides, "indent guides default on");
        assert!(
            prefs.suspicious_chars,
            "suspicious character audit default on"
        );
        assert_eq!(prefs.indent_width, 4, "default fallback indent width");
        assert!(
            !prefs.trim_trailing_whitespace_on_save,
            "trim-on-save is opt-in, default off"
        );
    }

    #[test]
    fn partial_json_fills_missing_fields_with_defaults() {
        let prefs: Preferences = serde_json::from_str(r#"{"fontSize": 16}"#).unwrap();
        assert_eq!(prefs.font_size, 16);
        assert_eq!(prefs.theme, "system");
        assert_eq!(prefs.default_encoding, "UTF-8");
        assert!(prefs.word_wrap);
        assert!(!prefs.show_invisibles);
    }

    #[test]
    fn preferences_round_trip_through_json() {
        let prefs = Preferences {
            font_family: "SF Mono".into(),
            font_size: 15,
            theme: "dark".into(),
            language: "zh-TW".into(),
            default_encoding: "Big5".into(),
            default_bom: false,
            word_wrap: false,
            show_invisibles: true,
            indent_guides: false,
            suspicious_chars: false,
            indent_width: 8,
            extension_encodings: vec![("txt".into(), "Big5".into())],
            trim_trailing_whitespace_on_save: true,
        };
        let json = serde_json::to_vec(&prefs).unwrap();
        let back: Preferences = serde_json::from_slice(&json).unwrap();
        assert_eq!(back.font_family, "SF Mono");
        assert_eq!(back.font_size, 15);
        assert_eq!(back.theme, "dark");
        assert_eq!(back.language, "zh-TW");
        assert_eq!(back.default_encoding, "Big5");
        assert!(back.show_invisibles);
        assert!(!back.indent_guides);
        assert!(!back.suspicious_chars);
        assert_eq!(back.indent_width, 8);
        assert_eq!(
            back.extension_encodings,
            vec![("txt".to_string(), "Big5".to_string())]
        );
        assert!(back.trim_trailing_whitespace_on_save);
    }

    /// Pins the exact JSON key name (`trimTrailingWhitespaceOnSave`, the
    /// `#[serde(rename_all = "camelCase")]` conversion of
    /// `trim_trailing_whitespace_on_save`) against the frontend's own
    /// `Preferences` interface (`src/ipc.ts`) — unlike the plain
    /// round-trip above (which reads back through this same struct and so
    /// can't by itself catch a key-name mismatch against the frontend),
    /// this inspects the serialized JSON directly, the same technique
    /// `extension_encodings_serialize_as_array_of_pairs` below uses for
    /// its own field.
    #[test]
    fn trim_trailing_whitespace_on_save_serializes_with_camel_case_key() {
        let prefs = Preferences {
            trim_trailing_whitespace_on_save: true,
            ..Preferences::default()
        };
        let json = serde_json::to_value(&prefs).unwrap();
        assert_eq!(
            json["trimTrailingWhitespaceOnSave"],
            serde_json::json!(true)
        );
    }

    /// `show_invisibles` was added after `word_wrap`; a `preferences.json`
    /// written by an older build has no such key at all. `serde(default)`
    /// on the struct must still deserialize it cleanly, defaulting the new
    /// field to `false` and leaving every pre-existing field intact.
    #[test]
    fn old_preferences_json_without_show_invisibles_loads_with_default_false() {
        let json = r#"{
            "fontFamily": "SF Mono",
            "fontSize": 15,
            "theme": "dark",
            "defaultEncoding": "Big5",
            "defaultBom": false,
            "wordWrap": false
        }"#;
        let prefs: Preferences = serde_json::from_str(json).unwrap();
        assert!(!prefs.show_invisibles);
        assert_eq!(prefs.font_family, "SF Mono");
        assert_eq!(prefs.theme, "dark");
        assert_eq!(prefs.default_encoding, "Big5");
        assert!(!prefs.word_wrap);
    }

    /// `language` was added after `show_invisibles` (UI i18n); an old
    /// `preferences.json` written by a build before it existed has no such
    /// key. `serde(default)` must still deserialize it cleanly, defaulting
    /// `language` to "system" (follow the OS locale) and leaving every
    /// pre-existing field intact.
    #[test]
    fn old_preferences_json_without_language_loads_with_default_system() {
        let json = r#"{
            "fontFamily": "SF Mono",
            "fontSize": 15,
            "theme": "dark",
            "defaultEncoding": "Big5",
            "defaultBom": false,
            "wordWrap": false,
            "showInvisibles": true
        }"#;
        let prefs: Preferences = serde_json::from_str(json).unwrap();
        assert_eq!(prefs.language, "system");
        assert_eq!(prefs.font_family, "SF Mono");
        assert_eq!(prefs.theme, "dark");
        assert!(prefs.show_invisibles);
    }

    /// `indent_guides` was added after `language` (v0.3 Track C); an old
    /// `preferences.json` written before it existed has no such key.
    /// Unlike the other "old JSON" compatibility tests above, this one
    /// pins a default of `true` (indent guides are on by default), not
    /// `false` — `serde(default)` falls back to the whole struct's
    /// `Default::default()` for any missing field, so this only holds
    /// because `Preferences::default()` sets `indent_guides: true`.
    #[test]
    fn old_preferences_json_without_indent_guides_loads_with_default_true() {
        let json = r#"{
            "fontFamily": "SF Mono",
            "fontSize": 15,
            "theme": "dark",
            "language": "zh-TW",
            "defaultEncoding": "Big5",
            "defaultBom": false,
            "wordWrap": false,
            "showInvisibles": true
        }"#;
        let prefs: Preferences = serde_json::from_str(json).unwrap();
        assert!(prefs.indent_guides, "missing key must default to true");
        assert_eq!(prefs.font_family, "SF Mono");
        assert_eq!(prefs.language, "zh-TW");
        assert!(prefs.show_invisibles);
    }

    /// `suspicious_chars` was added after `indent_guides` (v0.4 Track A); an
    /// old `preferences.json` written before it existed has no such key.
    /// Like `indent_guides` above (and unlike `show_invisibles`), this
    /// defaults to `true` — `serde(default)` falls back to the whole
    /// struct's `Default::default()` for any missing field, so this only
    /// holds because `Preferences::default()` sets `suspicious_chars: true`.
    #[test]
    fn old_preferences_json_without_suspicious_chars_loads_with_default_true() {
        let json = r#"{
            "fontFamily": "SF Mono",
            "fontSize": 15,
            "theme": "dark",
            "language": "zh-TW",
            "defaultEncoding": "Big5",
            "defaultBom": false,
            "wordWrap": false,
            "showInvisibles": true,
            "indentGuides": false
        }"#;
        let prefs: Preferences = serde_json::from_str(json).unwrap();
        assert!(prefs.suspicious_chars, "missing key must default to true");
        assert_eq!(prefs.font_family, "SF Mono");
        assert_eq!(prefs.language, "zh-TW");
        assert!(prefs.show_invisibles);
        assert!(!prefs.indent_guides);
    }

    /// `indent_width` was added after `suspicious_chars` (v0.4 Track C
    /// indentation tools); an old `preferences.json` written before it
    /// existed has no such key. Like `indent_guides`/`suspicious_chars`
    /// above, this defaults to a specific value (4), not just "some
    /// number" — `serde(default)` falls back to the whole struct's
    /// `Default::default()` for any missing field, so this only holds
    /// because `Preferences::default()` sets `indent_width: 4`.
    #[test]
    fn old_preferences_json_without_indent_width_loads_with_default_four() {
        let json = r#"{
            "fontFamily": "SF Mono",
            "fontSize": 15,
            "theme": "dark",
            "language": "zh-TW",
            "defaultEncoding": "Big5",
            "defaultBom": false,
            "wordWrap": false,
            "showInvisibles": true,
            "indentGuides": false,
            "suspiciousChars": false
        }"#;
        let prefs: Preferences = serde_json::from_str(json).unwrap();
        assert_eq!(prefs.indent_width, 4, "missing key must default to 4");
        assert_eq!(prefs.font_family, "SF Mono");
        assert_eq!(prefs.language, "zh-TW");
        assert!(prefs.show_invisibles);
        assert!(!prefs.indent_guides);
        assert!(!prefs.suspicious_chars);
    }

    /// `trim_trailing_whitespace_on_save` was added after `extension_encodings`
    /// (ROADMAP.md v0.7 Track C, "trim trailing whitespace on save"); an old
    /// `preferences.json` written before it existed has no such key. Like
    /// `show_invisibles`, this defaults to `false` (opt-in — it rewrites
    /// file content, not just a display setting) — `serde(default)` falls
    /// back to the whole struct's `Default::default()` for any missing
    /// field, so this only holds because `Preferences::default()` sets
    /// `trim_trailing_whitespace_on_save: false`.
    #[test]
    fn old_preferences_json_without_trim_trailing_whitespace_on_save_loads_with_default_false() {
        let json = r#"{
            "fontFamily": "SF Mono",
            "fontSize": 15,
            "theme": "dark",
            "language": "zh-TW",
            "defaultEncoding": "Big5",
            "defaultBom": false,
            "wordWrap": false,
            "showInvisibles": true,
            "indentGuides": false,
            "suspiciousChars": false,
            "indentWidth": 8,
            "extensionEncodings": [["txt", "Big5"]]
        }"#;
        let prefs: Preferences = serde_json::from_str(json).unwrap();
        assert!(
            !prefs.trim_trailing_whitespace_on_save,
            "missing key must default to false"
        );
        assert_eq!(prefs.font_family, "SF Mono");
        assert_eq!(prefs.language, "zh-TW");
        assert!(prefs.show_invisibles);
        assert!(!prefs.indent_guides);
        assert!(!prefs.suspicious_chars);
        assert_eq!(prefs.indent_width, 8);
        assert_eq!(
            prefs.extension_encodings,
            vec![("txt".to_string(), "Big5".to_string())]
        );
    }

    /// `indent_width` round-trips through JSON for a few representative
    /// values — pins the plain-`u32`, no-enum/schema shape (like `theme`'s
    /// own `new_builtin_theme_values_round_trip_through_json` above).
    #[test]
    fn indent_width_values_round_trip_through_json() {
        for width in [2, 4, 8] {
            let prefs = Preferences {
                indent_width: width,
                ..Preferences::default()
            };
            let json = serde_json::to_vec(&prefs).unwrap();
            let back: Preferences = serde_json::from_slice(&json).unwrap();
            assert_eq!(back.indent_width, width);
        }
    }

    /// `language` accepts "en", "zh-TW", "ja", and "zh-CN" and round-trips
    /// through JSON — pins the values the frontend's language select and
    /// menu.rs's `resolve_lang` agree on (see src/i18n.ts `Locale`). "ja"
    /// and "zh-CN" were added in v0.3 Track D.
    #[test]
    fn language_values_round_trip_through_json() {
        for language in ["system", "en", "zh-TW", "ja", "zh-CN"] {
            let prefs = Preferences {
                language: language.into(),
                ..Preferences::default()
            };
            let json = serde_json::to_vec(&prefs).unwrap();
            let back: Preferences = serde_json::from_slice(&json).unwrap();
            assert_eq!(back.language, language);
        }
    }

    /// `extension_encodings` is new: an old `preferences.json` written
    /// before this field existed must still load, defaulting to an empty
    /// table — this is the compatibility case the field's `serde(default)`
    /// exists for.
    #[test]
    fn old_preferences_without_extension_encodings_still_load() {
        let json = r#"{"fontSize": 16, "theme": "dark"}"#;
        let prefs: Preferences = serde_json::from_str(json).unwrap();
        assert_eq!(prefs.font_size, 16);
        assert_eq!(prefs.theme, "dark");
        assert!(prefs.extension_encodings.is_empty());
    }

    /// The stored JSON shape is an array of two-element arrays, e.g.
    /// `[["txt","Big5"],["log","UTF-8"]]` — pin this so the frontend's
    /// `[string, string][]` type stays in sync with the Rust tuple shape.
    #[test]
    fn extension_encodings_serialize_as_array_of_pairs() {
        let prefs = Preferences {
            extension_encodings: vec![
                ("txt".into(), "Big5".into()),
                ("log".into(), "UTF-8".into()),
            ],
            ..Preferences::default()
        };
        let json = serde_json::to_value(&prefs).unwrap();
        assert_eq!(
            json["extensionEncodings"],
            serde_json::json!([["txt", "Big5"], ["log", "UTF-8"]])
        );
    }

    /// `theme` is a plain String (no enum/schema), so the new built-in
    /// theme system (menu.rs THEME_IDS: paper, dusk) needs no Rust schema
    /// change — this pins that serde really does accept the new values,
    /// including round-tripping an old preferences.json written before
    /// they existed.
    #[test]
    fn new_builtin_theme_values_round_trip_through_json() {
        for theme in ["paper", "dusk"] {
            let prefs = Preferences {
                theme: theme.into(),
                ..Preferences::default()
            };
            let json = serde_json::to_vec(&prefs).unwrap();
            let back: Preferences = serde_json::from_slice(&json).unwrap();
            assert_eq!(back.theme, theme);
        }
    }

    // --- issue #178: Rust-side extension -> encoding lookup, mirroring the
    // frontend's `extensionOf`/`lookupExtensionEncoding`
    // (`extensionEncodings.test.ts`) case for case, since
    // `scan_replace_in_folder`/`execute_replace_in_folder`/
    // `search_in_folder` walk many files in one call and so, unlike
    // `open_document`, can't have the frontend resolve a single hint ahead
    // of time.

    #[test]
    fn extension_of_extracts_lowercase_extension() {
        assert_eq!(
            extension_of(Path::new("/tmp/notes.TXT")).as_deref(),
            Some("txt")
        );
        assert_eq!(
            extension_of(Path::new("archive.tar.gz")).as_deref(),
            Some("gz"),
            "only the last dot segment counts"
        );
    }

    #[test]
    fn extension_of_none_for_dotfile_trailing_dot_and_no_dot() {
        assert_eq!(extension_of(Path::new("/tmp/Makefile")), None);
        assert_eq!(
            extension_of(Path::new("/tmp/.gitignore")),
            None,
            "a dotfile's leading dot is not an extension marker"
        );
        assert_eq!(
            extension_of(Path::new("/tmp/trailing.")),
            None,
            "a trailing dot has no extension after it"
        );
    }

    #[test]
    fn extension_encoding_for_finds_case_insensitive_match() {
        let table = vec![
            ("txt".to_string(), "Big5".to_string()),
            ("log".to_string(), "UTF-8".to_string()),
        ];
        assert_eq!(
            extension_encoding_for(&table, Path::new("/tmp/a.txt")).as_deref(),
            Some("Big5")
        );
        assert_eq!(
            extension_encoding_for(&table, Path::new("/tmp/A.TXT")).as_deref(),
            Some("Big5"),
            "extension matching is case-insensitive"
        );
        assert_eq!(
            extension_encoding_for(&table, Path::new("/logs/app.log")).as_deref(),
            Some("UTF-8")
        );
    }

    #[test]
    fn extension_encoding_for_none_when_unmapped_or_extensionless() {
        let table = vec![("txt".to_string(), "Big5".to_string())];
        assert_eq!(
            extension_encoding_for(&table, Path::new("/tmp/a.csv")),
            None
        );
        assert_eq!(
            extension_encoding_for(&table, Path::new("/tmp/Makefile")),
            None
        );
        assert_eq!(extension_encoding_for(&[], Path::new("/tmp/a.txt")), None);
    }

    // --- Per-module corruption regression (ROADMAP.md v0.7 Track V) --------
    //
    // Same rationale as session.rs's block of the same name: `current`
    // takes an `AppHandle<R>` this crate cannot mock (no `tauri::test`
    // feature -- see recent.rs's `clear_then_reload_round_trip_is_empty`
    // doc comment), but its entire body is
    // `crate::store::read_json(app, "preferences.json").unwrap_or_default()`,
    // so `store::read_json_from_path::<Preferences>(&path).unwrap_or_default()`
    // against a file literally named "preferences.json" is the deepest
    // testable stand-in for `current` itself.

    fn corruption_fixture_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("plume-prefs-corrupt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A handful of concrete fields, not a whole-struct comparison
    /// (`Preferences` has no `PartialEq`/`Debug` derive) -- enough to prove
    /// the fallback is really `Preferences::default()` and not some
    /// partially-parsed leftover.
    fn assert_is_default(prefs: &Preferences) {
        let default = Preferences::default();
        assert_eq!(prefs.font_size, default.font_size);
        assert_eq!(prefs.theme, default.theme);
        assert_eq!(prefs.default_encoding, default.default_encoding);
        assert_eq!(prefs.indent_guides, default.indent_guides);
        assert_eq!(prefs.suspicious_chars, default.suspicious_chars);
        assert_eq!(prefs.indent_width, default.indent_width);
        assert!(prefs.extension_encodings.is_empty());
        assert_eq!(
            prefs.trim_trailing_whitespace_on_save,
            default.trim_trailing_whitespace_on_save
        );
    }

    /// Scenario 1: a valid preferences.json truncated mid-write (issue
    /// #62's failure mode, pinned here against the real `Preferences`
    /// struct and filename rather than store.rs's throwaway `Sample`).
    #[test]
    fn truncated_preferences_json_loads_as_default() {
        let dir = corruption_fixture_dir("truncated");
        let path = dir.join("preferences.json");

        let prefs = Preferences {
            font_size: 99,
            theme: "dark".into(),
            indent_width: 8,
            ..Preferences::default()
        };
        crate::store::write_json_to_path(&path, &prefs).unwrap();
        let full = std::fs::read(&path).unwrap();
        let half = &full[..full.len() / 2];
        std::fs::write(&path, half).unwrap();

        let loaded: Preferences = crate::store::read_json_from_path(&path).unwrap_or_default();
        assert_is_default(&loaded);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Scenario 2: syntactically valid JSON, but `fontSize` is a string
    /// where `Preferences` expects a `u32` -- `#[serde(default)]` only
    /// fills in *absent* keys, so a present-but-mistyped key still fails
    /// the whole-document parse rather than silently defaulting just that
    /// field.
    #[test]
    fn wrong_schema_preferences_json_loads_as_default() {
        let dir = corruption_fixture_dir("wrong-schema");
        let path = dir.join("preferences.json");
        std::fs::write(&path, br#"{"fontSize": "sixteen"}"#).unwrap();

        let loaded: Preferences = crate::store::read_json_from_path(&path).unwrap_or_default();
        assert_is_default(&loaded);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Scenario 3: a zero-byte preferences.json.
    #[test]
    fn empty_preferences_json_loads_as_default() {
        let dir = corruption_fixture_dir("empty");
        let path = dir.join("preferences.json");
        std::fs::write(&path, b"").unwrap();

        let loaded: Preferences = crate::store::read_json_from_path(&path).unwrap_or_default();
        assert_is_default(&loaded);

        std::fs::remove_dir_all(&dir).ok();
    }
}

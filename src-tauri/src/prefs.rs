//! User preferences, stored as JSON in the app config directory. Fields use
//! `serde(default)` so settings added later still load old files cleanly.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    /// Empty string means the platform default monospace stack.
    pub font_family: String,
    pub font_size: u32,
    /// "system" | "light" | "dark"
    pub theme: String,
    /// Default encoding for new (untitled) documents.
    pub default_encoding: String,
    pub default_bom: bool,
    pub word_wrap: bool,
    /// Render invisible characters: space dots, tab arrows, EOL marks.
    pub show_invisibles: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            font_family: String::new(),
            font_size: 13,
            theme: "system".into(),
            default_encoding: "UTF-8".into(),
            default_bom: false,
            word_wrap: true,
            show_invisibles: false,
        }
    }
}

/// Current preferences, shared by the load command and the menu builder
/// (the View menu checkbox needs the persisted state at build time).
pub fn current<R: Runtime>(app: &AppHandle<R>) -> Preferences {
    crate::store::read_json(app, "preferences.json").unwrap_or_default()
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
        assert_eq!(prefs.default_encoding, "UTF-8");
        assert!(!prefs.default_bom);
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
            default_encoding: "Big5".into(),
            default_bom: false,
            word_wrap: false,
            show_invisibles: true,
        };
        let json = serde_json::to_vec(&prefs).unwrap();
        let back: Preferences = serde_json::from_slice(&json).unwrap();
        assert_eq!(back.font_family, "SF Mono");
        assert_eq!(back.font_size, 15);
        assert_eq!(back.theme, "dark");
        assert_eq!(back.default_encoding, "Big5");
        assert!(back.show_invisibles);
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
}

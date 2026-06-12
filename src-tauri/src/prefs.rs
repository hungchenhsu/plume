//! User preferences, stored as JSON in the app config directory. Fields use
//! `serde(default)` so settings added later still load old files cleanly.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

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
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            font_family: String::new(),
            font_size: 13,
            theme: "system".into(),
            default_encoding: "UTF-8".into(),
            default_bom: false,
        }
    }
}

fn prefs_path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve config dir: {e}"))?;
    Ok(dir.join("preferences.json"))
}

#[tauri::command]
pub fn load_preferences<R: Runtime>(app: AppHandle<R>) -> Preferences {
    prefs_path(&app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn save_preferences<R: Runtime>(
    app: AppHandle<R>,
    preferences: Preferences,
) -> Result<(), String> {
    let path = prefs_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create config dir: {e}"))?;
    }
    let json =
        serde_json::to_vec_pretty(&preferences).map_err(|e| format!("Cannot serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write preferences: {e}"))?;
    Ok(())
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
    }

    #[test]
    fn preferences_round_trip_through_json() {
        let prefs = Preferences {
            font_family: "SF Mono".into(),
            font_size: 15,
            theme: "dark".into(),
            default_encoding: "Big5".into(),
            default_bom: false,
        };
        let json = serde_json::to_vec(&prefs).unwrap();
        let back: Preferences = serde_json::from_slice(&json).unwrap();
        assert_eq!(back.font_family, "SF Mono");
        assert_eq!(back.font_size, 15);
        assert_eq!(back.theme, "dark");
        assert_eq!(back.default_encoding, "Big5");
    }
}

//! Tiny JSON file store in the app config directory, shared by session,
//! preferences and recent-files persistence.

use serde::{de::DeserializeOwned, Serialize};
use tauri::{AppHandle, Manager, Runtime};

fn config_path<R: Runtime>(app: &AppHandle<R>, file: &str) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve config dir: {e}"))?;
    Ok(dir.join(file))
}

pub fn read_json<T: DeserializeOwned, R: Runtime>(app: &AppHandle<R>, file: &str) -> Option<T> {
    let path = config_path(app, file).ok()?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_json<T: Serialize, R: Runtime>(
    app: &AppHandle<R>,
    file: &str,
    value: &T,
) -> Result<(), String> {
    let path = config_path(app, file)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create config dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(|e| format!("Cannot serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write {file}: {e}"))
}

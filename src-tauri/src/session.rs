//! Session persistence: the list of open files (with their encodings) and
//! the active tab, stored as JSON in the app config directory.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    pub path: String,
    pub encoding: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub files: Vec<SessionFile>,
    pub active: usize,
}

fn session_path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve config dir: {e}"))?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
pub fn load_session<R: Runtime>(app: AppHandle<R>) -> Option<Session> {
    let path = session_path(&app).ok()?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[tauri::command]
pub fn save_session<R: Runtime>(app: AppHandle<R>, session: Session) -> Result<(), String> {
    let path = session_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create config dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(&session).map_err(|e| format!("Cannot serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write session: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_round_trips_through_json() {
        let session = Session {
            files: vec![SessionFile {
                path: "/tmp/中文檔名.txt".into(),
                encoding: "Big5".into(),
            }],
            active: 0,
        };
        let json = serde_json::to_vec(&session).unwrap();
        let back: Session = serde_json::from_slice(&json).unwrap();
        assert_eq!(back.files.len(), 1);
        assert_eq!(back.files[0].path, "/tmp/中文檔名.txt");
        assert_eq!(back.files[0].encoding, "Big5");
        assert_eq!(back.active, 0);
    }
}

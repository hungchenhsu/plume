//! Session persistence: the list of open files (with their encodings) and
//! the active tab, stored as JSON in the app config directory.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

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

#[tauri::command]
pub fn load_session<R: Runtime>(app: AppHandle<R>) -> Option<Session> {
    crate::store::read_json(&app, "session.json")
}

#[tauri::command]
pub fn save_session<R: Runtime>(app: AppHandle<R>, session: Session) -> Result<(), String> {
    crate::store::write_json(&app, "session.json", &session)
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

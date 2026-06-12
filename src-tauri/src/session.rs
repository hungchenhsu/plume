//! Session persistence: the list of open files (with their encodings) and
//! the active tab, stored as JSON in the app config directory.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    /// None for untitled documents kept alive by a hot-exit backup.
    #[serde(default)]
    pub path: Option<String>,
    pub encoding: String,
    /// Cursor position as a character offset; defaults to 0 for sessions
    /// written before this field existed.
    #[serde(default)]
    pub cursor: usize,
    /// Backup file name (under backups/) holding unsaved content.
    #[serde(default)]
    pub backup: Option<String>,
    /// Tab title, needed to restore untitled documents.
    #[serde(default)]
    pub title: String,
    /// Encoding settings to restore for backup-resurrected documents.
    #[serde(default)]
    pub with_bom: bool,
    #[serde(default)]
    pub line_ending: String,
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
                path: Some("/tmp/中文檔名.txt".into()),
                encoding: "Big5".into(),
                cursor: 42,
                backup: Some("bk-1.txt".into()),
                title: "中文檔名.txt".into(),
                with_bom: true,
                line_ending: "CRLF".into(),
            }],
            active: 0,
        };
        let json = serde_json::to_vec(&session).unwrap();
        let back: Session = serde_json::from_slice(&json).unwrap();
        assert_eq!(back.files.len(), 1);
        assert_eq!(back.files[0].path.as_deref(), Some("/tmp/中文檔名.txt"));
        assert_eq!(back.files[0].encoding, "Big5");
        assert_eq!(back.files[0].cursor, 42);
        assert_eq!(back.files[0].backup.as_deref(), Some("bk-1.txt"));
        assert!(back.files[0].with_bom);
        assert_eq!(back.files[0].line_ending, "CRLF");
        assert_eq!(back.active, 0);
    }

    #[test]
    fn old_sessions_without_new_fields_still_load() {
        let json = r#"{"files":[{"path":"/tmp/a.txt","encoding":"UTF-8"}],"active":0}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        assert_eq!(session.files[0].path.as_deref(), Some("/tmp/a.txt"));
        assert_eq!(session.files[0].cursor, 0);
        assert!(session.files[0].backup.is_none());
    }
}

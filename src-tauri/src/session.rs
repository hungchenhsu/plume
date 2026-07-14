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
    /// User-toggled per-tab read-only lock (ROADMAP.md v0.4 Track C;
    /// src/tabs.ts `Doc.userReadOnly`), independent of the large-file
    /// truncated preview's own (unlifted, unpersisted) read-only state.
    /// Defaults to false for sessions written before this field existed.
    #[serde(default)]
    pub user_read_only: bool,
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
                user_read_only: true,
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
        assert!(back.files[0].user_read_only);
        assert_eq!(back.active, 0);
    }

    #[test]
    fn old_sessions_without_new_fields_still_load() {
        let json = r#"{"files":[{"path":"/tmp/a.txt","encoding":"UTF-8"}],"active":0}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        assert_eq!(session.files[0].path.as_deref(), Some("/tmp/a.txt"));
        assert_eq!(session.files[0].cursor, 0);
        assert!(session.files[0].backup.is_none());
        assert!(!session.files[0].user_read_only);
    }

    // ROADMAP.md v0.4 Track C: a session written by a version that already
    // knew about userReadOnly must still say so explicitly (JSON key order
    // does not affect serde field lookup), and a locked tab's key must
    // round-trip as camelCase to match src/ipc.ts's SessionFile.userReadOnly
    // exactly (the struct-level rename_all handles this automatically, but
    // this pins it against an accidental #[serde(rename)] typo on the field
    // itself).
    #[test]
    fn user_read_only_serializes_as_camel_case_and_defaults_false_when_absent() {
        let session = Session {
            files: vec![SessionFile {
                path: Some("/tmp/locked.txt".into()),
                encoding: "UTF-8".into(),
                cursor: 0,
                backup: None,
                title: "locked.txt".into(),
                with_bom: false,
                line_ending: "LF".into(),
                user_read_only: true,
            }],
            active: 0,
        };
        let json = serde_json::to_string(&session).unwrap();
        assert!(json.contains(r#""userReadOnly":true"#), "got: {json}");

        let json = r#"{"files":[{"path":"/tmp/a.txt","encoding":"UTF-8"}],"active":0}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        assert!(!session.files[0].user_read_only);
    }
}

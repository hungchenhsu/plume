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

    // --- Forward-compat fixtures (ROADMAP.md v0.6 V1) ----------------------
    //
    // SessionFile relies on #[serde(default)] to let session.json files
    // written by earlier Plume versions load under today's struct. That
    // contract has so far only held "by accident" -- nothing pinned it. The
    // fixtures below hard-code the JSON shapes that actually existed on disk
    // at each point in the field's real history, confirmed with
    // `git show <tag>:src-tauri/src/session.rs`, not reconstructed from
    // memory:
    //
    //   - v0.1.0-alpha.1 (commit 35794f8, #7): `path: String` and
    //     `encoding: String` only, both required. No #[serde(default)]
    //     existed yet.
    //   - v0.1.0-alpha.7 through v0.3.0-alpha.1 (byte-identical struct across
    //     all three tags): commit b6a31ed (#30) added `cursor: usize`, then
    //     e527c1a (#32) turned `path` into `Option<String>` and added
    //     `backup`, `title`, `withBom`, `lineEnding`. All seven fields are
    //     present; `userReadOnly` does not exist yet.
    //   - v0.4.0-alpha.1 onward (byte-identical through v0.5.0-alpha.2 and
    //     current HEAD): commit 47ca4fe (#141) added `userReadOnly`. This is
    //     today's shape, already covered by the two tests above.
    //
    // If a future change renames a field, drops a #[serde(default)], or
    // changes a type without a serde-compatible fallback, one of these
    // should fail.

    /// v0.1.0-alpha.1 shape, verbatim: only `path` and `encoding` ever
    /// existed on disk from this era.
    #[test]
    fn fixture_v0_1_0_alpha1_shape_loads_with_current_defaults() {
        let json = r#"{"files":[{"path":"/tmp/a.txt","encoding":"UTF-8"}],"active":0}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        let f = &session.files[0];
        assert_eq!(f.path.as_deref(), Some("/tmp/a.txt"));
        assert_eq!(f.encoding, "UTF-8");
        assert_eq!(f.cursor, 0);
        assert!(f.backup.is_none());
        assert_eq!(f.title, "");
        assert!(!f.with_bom);
        assert_eq!(f.line_ending, "");
        assert!(!f.user_read_only);
    }

    /// Same era, multiple files with a non-ASCII path and a non-zero
    /// `active` index, so array handling and per-element defaults are both
    /// exercised (not just a single lucky element).
    #[test]
    fn fixture_v0_1_0_alpha1_shape_multi_file_loads_with_current_defaults() {
        let json = r#"{"files":[
            {"path":"/tmp/舊檔.txt","encoding":"Big5"},
            {"path":"/tmp/second.log","encoding":"UTF-8"}
        ],"active":1}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        assert_eq!(session.active, 1);
        assert_eq!(session.files.len(), 2);
        assert_eq!(session.files[0].path.as_deref(), Some("/tmp/舊檔.txt"));
        assert_eq!(session.files[0].encoding, "Big5");
        assert_eq!(session.files[1].path.as_deref(), Some("/tmp/second.log"));
        for f in &session.files {
            assert_eq!(f.cursor, 0);
            assert!(f.backup.is_none());
            assert_eq!(f.title, "");
            assert!(!f.with_bom);
            assert_eq!(f.line_ending, "");
            assert!(!f.user_read_only);
        }
    }

    /// v0.1.0-alpha.7..v0.3.0-alpha.1 shape ("minimal" within this era):
    /// every field this era's SessionFile could serialize is present (serde
    /// always writes every field of this struct; nothing here has
    /// skip_serializing_if), but at default-ish values. `userReadOnly` is
    /// still absent -- it doesn't exist until v0.4.0-alpha.1.
    #[test]
    fn fixture_pre_user_read_only_shape_minimal_loads_with_current_defaults() {
        let json = r#"{"files":[{"path":"/tmp/old.txt","encoding":"UTF-8","cursor":0,
            "backup":null,"title":"","withBom":false,"lineEnding":""}],"active":0}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        let f = &session.files[0];
        assert_eq!(f.path.as_deref(), Some("/tmp/old.txt"));
        assert_eq!(f.cursor, 0);
        assert!(f.backup.is_none());
        assert_eq!(f.title, "");
        assert!(!f.with_bom);
        assert_eq!(f.line_ending, "");
        assert!(
            !f.user_read_only,
            "userReadOnly must default to false: the field didn't exist until \
             v0.4.0-alpha.1 (#141)"
        );
    }

    /// Same era, fully populated: an untitled document kept alive by a
    /// hot-exit backup (`path: null`, `backup: Some(..)`), non-zero cursor,
    /// BOM and CRLF settings on -- the richest shape this era could
    /// produce. Must still gain today's `userReadOnly: false`.
    #[test]
    fn fixture_pre_user_read_only_shape_populated_loads_with_current_defaults() {
        let json = r#"{"files":[{"path":null,"encoding":"UTF-8","cursor":128,
            "backup":"bk-42.txt","title":"未命名 3","withBom":true,
            "lineEnding":"CRLF"}],"active":0}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        let f = &session.files[0];
        assert!(f.path.is_none());
        assert_eq!(f.encoding, "UTF-8");
        assert_eq!(f.cursor, 128);
        assert_eq!(f.backup.as_deref(), Some("bk-42.txt"));
        assert_eq!(f.title, "未命名 3");
        assert!(f.with_bom);
        assert_eq!(f.line_ending, "CRLF");
        assert!(!f.user_read_only);
    }

    /// Not a historical shape -- every real version so far has always
    /// serialized all of its own fields, so `path` in particular was never
    /// actually omitted on disk -- but the contract these defaults promise:
    /// with only the one field that has never had a default (`encoding`)
    /// present, every other field, including `path` (the oldest field, easy
    /// to assume is "always there"), must fall back to its current default.
    #[test]
    fn all_defaultable_fields_default_when_json_keys_are_absent() {
        let json = r#"{"files":[{"encoding":"UTF-8"}],"active":0}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        let f = &session.files[0];
        assert!(f.path.is_none(), "path should default to None");
        assert_eq!(f.cursor, 0, "cursor should default to 0");
        assert!(f.backup.is_none(), "backup should default to None");
        assert_eq!(f.title, "", "title should default to empty string");
        assert!(!f.with_bom, "with_bom should default to false");
        assert_eq!(
            f.line_ending, "",
            "line_ending should default to empty string"
        );
        assert!(!f.user_read_only, "user_read_only should default to false");
    }

    /// The flip side of forward-compat: a session.json written by a *newer*
    /// Plume (or hand-edited) with a field this build doesn't know about
    /// must not fail to load. SessionFile has no
    /// #[serde(deny_unknown_fields)], so serde_json silently drops anything
    /// unrecognized -- this pins that current behavior so a future
    /// `deny_unknown_fields` addition doesn't sneak in unnoticed.
    #[test]
    fn unknown_future_fields_are_ignored_not_rejected() {
        let json = r#"{"files":[{"path":"/tmp/a.txt","encoding":"UTF-8","cursor":5,
            "userReadOnly":true,"wordWrapColumn":80,"foldedRanges":[[10,20]],
            "future":{"nested":true}}],"active":0}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        let f = &session.files[0];
        assert_eq!(f.path.as_deref(), Some("/tmp/a.txt"));
        assert_eq!(f.cursor, 5);
        assert!(f.user_read_only);
    }
}

//! Recently opened files, most recent first, persisted as JSON.

use tauri::{AppHandle, Runtime};

const MAX_RECENT: usize = 20;
const FILE: &str = "recent.json";

/// Move (or insert) `path` to the front, dropping duplicates and clamping
/// the list length.
fn push_recent(mut list: Vec<String>, path: String) -> Vec<String> {
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(MAX_RECENT);
    list
}

#[tauri::command]
pub fn load_recent_files<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    crate::store::read_json(&app, FILE).unwrap_or_default()
}

#[tauri::command]
pub fn add_recent_file<R: Runtime>(app: AppHandle<R>, path: String) -> Vec<String> {
    let list: Vec<String> = crate::store::read_json(&app, FILE).unwrap_or_default();
    let list = push_recent(list, path);
    let _ = crate::store::write_json(&app, FILE, &list);
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_existing_entry_to_front() {
        let list = vec!["a".into(), "b".into(), "c".into()];
        let list = push_recent(list, "c".into());
        assert_eq!(list, vec!["c", "a", "b"]);
    }

    #[test]
    fn clamps_to_max_length() {
        let list: Vec<String> = (0..MAX_RECENT).map(|i| i.to_string()).collect();
        let list = push_recent(list, "new".into());
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0], "new");
        assert!(!list.contains(&(MAX_RECENT - 1).to_string()));
    }
}

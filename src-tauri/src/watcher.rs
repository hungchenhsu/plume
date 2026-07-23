//! File watching for auto-reload. Watched paths that change on disk are
//! reported to the frontend via the `mojidori://file-changed` event; deciding
//! whether to reload (and prompting on dirty buffers) is frontend logic.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime, State};

pub struct WatcherState {
    watcher: Mutex<RecommendedWatcher>,
}

pub fn init<R: Runtime>(app: AppHandle<R>) -> notify::Result<WatcherState> {
    let watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let Ok(event) = result else { return };
        if !matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ) {
            return;
        }
        let paths: Vec<String> = event
            .paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        if !paths.is_empty() {
            let _ = app.emit("mojidori://file-changed", paths);
        }
    })?;
    Ok(WatcherState {
        watcher: Mutex::new(watcher),
    })
}

#[tauri::command]
pub fn watch_file(state: State<WatcherState>, path: String) -> Result<(), String> {
    state
        .watcher
        .lock()
        .unwrap()
        .watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Cannot watch {path}: {e}"))
}

#[tauri::command]
pub fn unwatch_file(state: State<WatcherState>, path: String) {
    // Tolerant by design: unwatching a path that is not watched is a no-op.
    let _ = state.watcher.lock().unwrap().unwatch(Path::new(&path));
}

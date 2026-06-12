mod encoding;
mod menu;
mod session;

use serde::Serialize;
use tauri::Emitter;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    path: String,
    content: String,
    encoding: String,
    had_bom: bool,
    malformed: bool,
    line_ending: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    unmappable: bool,
}

/// Read a file from disk, decoding with the given encoding label or with
/// automatic detection when `encoding` is `None`. The returned content is
/// LF-normalized; the original line ending is reported in `line_ending`.
#[tauri::command]
fn open_document(path: String, encoding: Option<String>) -> Result<OpenedDocument, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let decoded = match encoding {
        Some(label) => encoding::decode_with(&bytes, &label)?,
        None => encoding::decode_auto(&bytes),
    };
    let line_ending = encoding::detect_line_ending(&decoded.content).to_string();
    Ok(OpenedDocument {
        path,
        content: encoding::normalize_to_lf(&decoded.content),
        encoding: decoded.encoding,
        had_bom: decoded.had_bom,
        malformed: decoded.malformed,
        line_ending,
    })
}

/// Encode LF-normalized content with the given encoding and line ending,
/// then write it to disk. `unmappable` is true when characters could not be
/// represented in the target encoding.
#[tauri::command]
fn save_document(
    path: String,
    content: String,
    encoding: String,
    with_bom: bool,
    line_ending: String,
) -> Result<SaveResult, String> {
    let text = encoding::apply_line_ending(&content, &line_ending);
    let (bytes, unmappable) = encoding::encode(&text, &encoding, with_bom)?;
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write {path}: {e}"))?;
    Ok(SaveResult { unmappable })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(menu::build)
        .on_menu_event(|app, event| {
            let _ = app.emit("plume://menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            save_document,
            session::load_session,
            session::save_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

//! Native application menu. One cross-platform definition: macOS gets the
//! standard app menu plus File/Edit/Window in the system menu bar; Windows
//! and Linux get File/Edit as a window menu. Menu accelerators own the
//! file shortcuts (CmdOrCtrl+T/O/S/W) — the frontend must not also bind them.

use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let file = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new_tab", "New Tab")
                .accelerator("CmdOrCtrl+T")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open_recent", "Open Recent…")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save_as", "Save As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("close_tab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .separator()
        .item(
            // CmdOrCtrl+P belongs to quick open (modern editor convention).
            &MenuItemBuilder::with_id("print", "Print…")
                .accelerator("CmdOrCtrl+Alt+P")
                .build(app)?,
        );
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().item(
        &MenuItemBuilder::with_id("preferences", "Preferences…")
            .accelerator("CmdOrCtrl+,")
            .build(app)?,
    );
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().quit();
    let file = file.build()?;

    // On macOS an Edit menu is required for clipboard and undo shortcuts to
    // reach the WebView at all; CodeMirror picks the actions up through
    // beforeinput. On other platforms it is a convenience.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(
            &MenuItemBuilder::with_id("find", "Find and Replace…")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("find_in_files", "Find in Files…")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("goto_line", "Go to Line…")
                .accelerator("CmdOrCtrl+L")
                .build(app)?,
        )
        .build()?;

    let menu = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    let menu = menu.item(
        &SubmenuBuilder::new(app, "Plume")
            .about(Some(AboutMetadata::default()))
            .separator()
            .item(
                &MenuItemBuilder::with_id("preferences", "Preferences…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?,
            )
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?,
    );

    // "system" | "light" | "dark" | "paper" | "dusk" — kept in sync with
    // Preferences.THEMES on the frontend and prefs::Preferences::theme.
    let current_theme = crate::prefs::current(app).theme;
    let theme_menu = SubmenuBuilder::with_id(app, "theme", "Theme")
        .item(
            &CheckMenuItemBuilder::with_id("theme_system", "Follow system")
                .checked(current_theme == "system")
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("theme_light", "Light")
                .checked(current_theme == "light")
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("theme_dark", "Dark")
                .checked(current_theme == "dark")
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("theme_paper", "Paper")
                .checked(current_theme == "paper")
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("theme_dusk", "Dusk")
                .checked(current_theme == "dusk")
                .build(app)?,
        )
        .build()?;

    let view = SubmenuBuilder::with_id(app, "view", "View")
        .item(
            &CheckMenuItemBuilder::with_id("word_wrap", "Word Wrap")
                .checked(crate::prefs::current(app).word_wrap)
                .accelerator("Alt+Z")
                .build(app)?,
        )
        .separator()
        .item(&theme_menu)
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .build()?;

    let menu = menu.item(&file).item(&edit).item(&view);

    #[cfg(target_os = "macos")]
    let menu = menu.item(
        &SubmenuBuilder::new(app, "Window")
            .minimize()
            .fullscreen()
            .build()?,
    );

    menu.build()
}

/// Ids of the View > Theme radio group, in menu order. Kept in sync with
/// `theme_menu` above and `preferences.ts` THEMES.
const THEME_IDS: [&str; 5] = [
    "theme_system",
    "theme_light",
    "theme_dark",
    "theme_paper",
    "theme_dusk",
];

/// Re-check the View > Theme entry matching `theme` and uncheck the rest.
/// `CheckMenuItem`s toggle their own native checkmark automatically when
/// clicked (that is enough for the standalone `word_wrap` item), but a
/// radio group of five needs the siblings explicitly unchecked — and the
/// theme can also change from the Preferences dialog, which never touches
/// the menu at all. Both entry points call this after applying a theme so
/// the native menu can never disagree with the frontend's applied theme.
#[tauri::command]
pub fn sync_theme_menu<R: Runtime>(app: AppHandle<R>, theme: String) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let Some(theme_menu) = menu
        .get("view")
        .and_then(|item| item.as_submenu().cloned())
        .and_then(|view| view.get("theme"))
        .and_then(|item| item.as_submenu().cloned())
    else {
        return Ok(());
    };

    let target = format!("theme_{theme}");
    for id in THEME_IDS {
        if let Some(item) = theme_menu
            .get(id)
            .and_then(|item| item.as_check_menuitem().cloned())
        {
            item.set_checked(id == target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::THEME_IDS;

    #[test]
    fn theme_ids_match_the_preferences_theme_values() {
        // Every id is "theme_" + one of prefs::Preferences::theme's valid
        // values, and the set matches preferences.ts THEMES exactly.
        let values: Vec<&str> = THEME_IDS
            .iter()
            .map(|id| id.strip_prefix("theme_").expect("theme_ prefix"))
            .collect();
        assert_eq!(values, ["system", "light", "dark", "paper", "dusk"]);
    }
}

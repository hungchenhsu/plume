//! Native application menu. One cross-platform definition: macOS gets the
//! standard app menu plus File/Edit/Window in the system menu bar; Windows
//! and Linux get File/Edit as a window menu. Menu accelerators own the
//! file shortcuts (CmdOrCtrl+T/O/S/W) — the frontend must not also bind them.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
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

    let menu = menu.item(&file).item(&edit);

    #[cfg(target_os = "macos")]
    let menu = menu.item(
        &SubmenuBuilder::new(app, "Window")
            .minimize()
            .fullscreen()
            .build()?,
    );

    menu.build()
}

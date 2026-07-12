//! Native application menu. One cross-platform definition: macOS gets the
//! standard app menu plus File/Edit/Window in the system menu bar; Windows
//! and Linux get File/Edit as a window menu. Menu accelerators own the
//! file shortcuts (CmdOrCtrl+T/O/S/W) — the frontend must not also bind them.
//!
//! i18n: the menu owns its own tiny en/zh-TW label table (`LABELS` below),
//! separate from the frontend's `src/i18n.ts` dictionary, because the menu
//! is built in `setup()` before the frontend has loaded (see `build`). The
//! two are kept in sync by hand — there is no shared source, but the label
//! text mirrors the frontend's wording where the same concept appears (e.g.
//! "Theme" / "主題" matches `preferences.theme`).

use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;

/// (id, English, Traditional Chinese) for every menu entry this module
/// creates with an explicit id — submenu titles included, so they can be
/// looked up and relabeled by `retitle_menu`. Entries without an id (the
/// macOS "Plume" app-name submenu, and Tauri's OS-predefined items like
/// Undo/Cut/Quit/About) are not listed: the app name is never translated,
/// and predefined items are labeled by the OS itself in its own locale.
const LABELS: &[(&str, &str, &str)] = &[
    ("file", "File", "檔案"),
    ("new_tab", "New Tab", "新增分頁"),
    ("open", "Open…", "開啟…"),
    ("open_recent", "Open Recent…", "最近的檔案…"),
    ("save", "Save", "儲存"),
    ("save_as", "Save As…", "另存新檔…"),
    ("close_tab", "Close Tab", "關閉分頁"),
    ("print", "Print…", "列印…"),
    ("preferences", "Preferences…", "偏好設定…"),
    ("edit", "Edit", "編輯"),
    ("find", "Find and Replace…", "尋找與取代…"),
    ("find_in_files", "Find in Files…", "在檔案中尋找…"),
    ("goto_line", "Go to Line…", "跳至行號…"),
    (
        "batch_convert",
        "Batch Encoding Conversion…",
        "批次轉換編碼…",
    ),
    ("view", "View", "檢視"),
    ("word_wrap", "Word Wrap", "自動換行"),
    ("show_invisibles", "Show Invisibles", "顯示不可見字元"),
    ("theme", "Theme", "主題"),
    ("theme_system", "Follow system", "跟隨系統"),
    ("theme_light", "Light", "亮色"),
    ("theme_dark", "Dark", "暗色"),
    ("theme_paper", "Paper", "紙張"),
    ("theme_dusk", "Dusk", "黃昏"),
    ("zoom_in", "Zoom In", "放大"),
    ("zoom_out", "Zoom Out", "縮小"),
    ("zoom_reset", "Actual Size", "實際大小"),
    ("window", "Window", "視窗"),
];

/// Look up a menu label by id and language ("en" | "zh-TW", anything else
/// falls back to English). Panics on an unknown id — that is a programming
/// error in this module (a build()/retitle_menu() call site referencing an
/// id missing from `LABELS`), not a runtime condition to degrade from.
fn label(id: &str, lang: &str) -> &'static str {
    let (_, en, zh_tw) = LABELS
        .iter()
        .find(|(entry_id, _, _)| *entry_id == id)
        .unwrap_or_else(|| panic!("menu.rs LABELS has no entry for id {id:?}"));
    if lang == "zh-TW" {
        zh_tw
    } else {
        en
    }
}

/// Resolve a language preference ("system" | "en" | "zh-TW") to "en" or
/// "zh-TW". Mirrors `src/i18n.ts` `effectiveLocale`/`resolveSystemLocale`:
/// "system" (or any unrecognized value) follows the OS locale, and only
/// Traditional-Chinese-bearing tags resolve to "zh-TW" — Simplified Chinese
/// ("zh-CN") and every other language fall back to English.
pub fn resolve_lang(pref: &str) -> String {
    match pref {
        "en" => "en".to_string(),
        "zh-TW" => "zh-TW".to_string(),
        _ => resolve_system_lang(),
    }
}

fn resolve_system_lang() -> String {
    let tag = sys_locale::get_locale().unwrap_or_default().to_lowercase();
    if tag.starts_with("zh")
        && (tag == "zh-tw" || tag.contains("hant") || tag == "zh-hk" || tag == "zh-mo")
    {
        "zh-TW".to_string()
    } else {
        "en".to_string()
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Built in setup() (not Builder::menu), so preferences (via app.path())
    // are available to decide the menu's language at startup.
    let lang = resolve_lang(&crate::prefs::current(app).language);
    let l = |id: &str| label(id, &lang);

    let file = SubmenuBuilder::with_id(app, "file", l("file"))
        .item(
            &MenuItemBuilder::with_id("new_tab", l("new_tab"))
                .accelerator("CmdOrCtrl+T")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", l("open"))
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open_recent", l("open_recent"))
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", l("save"))
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save_as", l("save_as"))
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("close_tab", l("close_tab"))
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .separator()
        .item(
            // CmdOrCtrl+P belongs to quick open (modern editor convention).
            &MenuItemBuilder::with_id("print", l("print"))
                .accelerator("CmdOrCtrl+Alt+P")
                .build(app)?,
        );
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().item(
        &MenuItemBuilder::with_id("preferences", l("preferences"))
            .accelerator("CmdOrCtrl+,")
            .build(app)?,
    );
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().quit();
    let file = file.build()?;

    // On macOS an Edit menu is required for clipboard and undo shortcuts to
    // reach the WebView at all; CodeMirror picks the actions up through
    // beforeinput. On other platforms it is a convenience.
    let edit = SubmenuBuilder::with_id(app, "edit", l("edit"))
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(
            &MenuItemBuilder::with_id("find", l("find"))
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("find_in_files", l("find_in_files"))
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("goto_line", l("goto_line"))
                .accelerator("CmdOrCtrl+L")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("batch_convert", l("batch_convert")).build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app);

    // The macOS app submenu's title is always "Plume" — the app name is a
    // brand, never translated — but it still gets an id ("app_menu") so its
    // "Preferences…" item can be found and relabeled by `retitle_menu`.
    #[cfg(target_os = "macos")]
    let menu = menu.item(
        &SubmenuBuilder::with_id(app, "app_menu", "Plume")
            .about(Some(AboutMetadata::default()))
            .separator()
            .item(
                &MenuItemBuilder::with_id("preferences", l("preferences"))
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
    // Preferences.themeChoices() on the frontend and prefs::Preferences::theme.
    let current_theme = crate::prefs::current(app).theme;
    let theme_menu = SubmenuBuilder::with_id(app, "theme", l("theme"))
        .item(
            &CheckMenuItemBuilder::with_id("theme_system", l("theme_system"))
                .checked(current_theme == "system")
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("theme_light", l("theme_light"))
                .checked(current_theme == "light")
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("theme_dark", l("theme_dark"))
                .checked(current_theme == "dark")
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("theme_paper", l("theme_paper"))
                .checked(current_theme == "paper")
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("theme_dusk", l("theme_dusk"))
                .checked(current_theme == "dusk")
                .build(app)?,
        )
        .build()?;

    let current_prefs = crate::prefs::current(app);
    let view = SubmenuBuilder::with_id(app, "view", l("view"))
        .item(
            &CheckMenuItemBuilder::with_id("word_wrap", l("word_wrap"))
                .checked(current_prefs.word_wrap)
                .accelerator("Alt+Z")
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("show_invisibles", l("show_invisibles"))
                .checked(current_prefs.show_invisibles)
                .build(app)?,
        )
        .separator()
        .item(&theme_menu)
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom_in", l("zoom_in"))
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_out", l("zoom_out"))
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_reset", l("zoom_reset"))
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .build()?;

    let menu = menu.item(&file).item(&edit).item(&view);

    #[cfg(target_os = "macos")]
    let menu = menu.item(
        &SubmenuBuilder::with_id(app, "window", l("window"))
            .minimize()
            .fullscreen()
            .build()?,
    );

    menu.build()
}

/// Ids of the View > Theme radio group, in menu order. Kept in sync with
/// `theme_menu` above and `preferences.ts` `themeChoices()`.
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

/// Relabel every custom (`with_id`) menu entry to `locale`'s labels
/// ("en" | "zh-TW", already resolved — never "system"; see `resolve_lang`
/// and the frontend's `src/i18n.ts` `effectiveLocale`). Called from the
/// Preferences dialog when the language preference changes, so the native
/// menu never needs a restart to catch up with the frontend's language.
/// Best-effort like `sync_theme_menu`: a `None` at any lookup step just
/// leaves that part of the menu as it was (e.g. `preferences` only exists
/// under `file` on non-macOS, and under `app_menu` on macOS).
#[tauri::command]
pub fn retitle_menu<R: Runtime>(app: AppHandle<R>, locale: String) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let l = |id: &str| label(id, &locale);

    if let Some(file) = menu.get("file").and_then(|item| item.as_submenu().cloned()) {
        file.set_text(l("file")).map_err(|e| e.to_string())?;
        for id in [
            "new_tab",
            "open",
            "open_recent",
            "save",
            "save_as",
            "close_tab",
            "print",
            "preferences",
        ] {
            if let Some(item) = file.get(id).and_then(|item| item.as_menuitem().cloned()) {
                item.set_text(l(id)).map_err(|e| e.to_string())?;
            }
        }
    }

    if let Some(edit) = menu.get("edit").and_then(|item| item.as_submenu().cloned()) {
        edit.set_text(l("edit")).map_err(|e| e.to_string())?;
        for id in ["find", "find_in_files", "goto_line", "batch_convert"] {
            if let Some(item) = edit.get(id).and_then(|item| item.as_menuitem().cloned()) {
                item.set_text(l(id)).map_err(|e| e.to_string())?;
            }
        }
    }

    if let Some(view) = menu.get("view").and_then(|item| item.as_submenu().cloned()) {
        view.set_text(l("view")).map_err(|e| e.to_string())?;
        for id in ["word_wrap", "show_invisibles"] {
            if let Some(item) = view
                .get(id)
                .and_then(|item| item.as_check_menuitem().cloned())
            {
                item.set_text(l(id)).map_err(|e| e.to_string())?;
            }
        }
        if let Some(theme_menu) = view
            .get("theme")
            .and_then(|item| item.as_submenu().cloned())
        {
            theme_menu.set_text(l("theme")).map_err(|e| e.to_string())?;
            for id in THEME_IDS {
                if let Some(item) = theme_menu
                    .get(id)
                    .and_then(|item| item.as_check_menuitem().cloned())
                {
                    item.set_text(l(id)).map_err(|e| e.to_string())?;
                }
            }
        }
        for id in ["zoom_in", "zoom_out", "zoom_reset"] {
            if let Some(item) = view.get(id).and_then(|item| item.as_menuitem().cloned()) {
                item.set_text(l(id)).map_err(|e| e.to_string())?;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(window) = menu
            .get("window")
            .and_then(|item| item.as_submenu().cloned())
        {
            window.set_text(l("window")).map_err(|e| e.to_string())?;
        }
        // The app submenu's title itself ("Plume") is never translated —
        // only its "Preferences…" item is.
        if let Some(app_menu) = menu
            .get("app_menu")
            .and_then(|item| item.as_submenu().cloned())
        {
            if let Some(item) = app_menu
                .get("preferences")
                .and_then(|item| item.as_menuitem().cloned())
            {
                item.set_text(l("preferences")).map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{label, resolve_lang, LABELS, THEME_IDS};

    #[test]
    fn theme_ids_match_the_preferences_theme_values() {
        // Every id is "theme_" + one of prefs::Preferences::theme's valid
        // values, and the set matches preferences.ts themeChoices() exactly.
        let values: Vec<&str> = THEME_IDS
            .iter()
            .map(|id| id.strip_prefix("theme_").expect("theme_ prefix"))
            .collect();
        assert_eq!(values, ["system", "light", "dark", "paper", "dusk"]);
    }

    #[test]
    fn labels_has_no_duplicate_ids() {
        let mut ids: Vec<&str> = LABELS.iter().map(|(id, _, _)| *id).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "LABELS has a duplicate id");
    }

    #[test]
    fn labels_has_a_non_empty_en_and_zh_tw_string_for_every_id() {
        for (id, en, zh_tw) in LABELS {
            assert!(!en.is_empty(), "empty English label for {id:?}");
            assert!(!zh_tw.is_empty(), "empty zh-TW label for {id:?}");
        }
    }

    #[test]
    fn label_falls_back_to_english_for_an_unrecognized_language() {
        assert_eq!(label("save", "fr-FR"), "Save");
    }

    #[test]
    fn label_returns_the_zh_tw_entry_for_zh_tw() {
        assert_eq!(label("save", "zh-TW"), "儲存");
    }

    #[test]
    fn resolve_lang_uses_the_explicit_preference_when_recognized() {
        assert_eq!(resolve_lang("en"), "en");
        assert_eq!(resolve_lang("zh-TW"), "zh-TW");
    }

    // "system" (and any other value) falls through to the OS locale via
    // `sys_locale::get_locale()`, which is environment-dependent — not
    // pinned here (see src/i18n.test.ts `resolveSystemLocale` for the tag
    // classification logic this function mirrors, tested directly there).
}

//! Native application menu. One cross-platform definition: macOS gets the
//! standard app menu plus File/Edit/Window in the system menu bar; Windows
//! and Linux get File/Edit as a window menu. Menu accelerators own the
//! file shortcuts (CmdOrCtrl+T/O/S/W) — the frontend must not also bind them.
//!
//! i18n: the menu owns its own tiny en/zh-TW/ja/zh-CN label table (`LABELS`
//! below), separate from the frontend's `src/i18n.ts` dictionary, because
//! the menu is built in `setup()` before the frontend has loaded (see
//! `build`). The two are kept in sync by hand — there is no shared source,
//! but the label text mirrors the frontend's wording where the same concept
//! appears (e.g. "Theme" / "主題" matches `preferences.theme`).

use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;

/// (id, English, Traditional Chinese, Japanese, Simplified Chinese) for
/// every menu entry this module creates with an explicit id — submenu
/// titles included, so they can be looked up and relabeled by
/// `retitle_menu`. Entries without an id (the macOS "Plume" app-name
/// submenu, and Tauri's OS-predefined items like Undo/Cut/Quit/About) are
/// not listed: the app name is never translated, and predefined items are
/// labeled by the OS itself in its own locale.
const LABELS: &[(&str, &str, &str, &str, &str)] = &[
    ("file", "File", "檔案", "ファイル", "文件"),
    ("new_tab", "New Tab", "新增分頁", "新規タブ", "新建标签页"),
    ("open", "Open…", "開啟…", "開く…", "打开…"),
    (
        "open_recent",
        "Open Recent…",
        "最近的檔案…",
        "最近使ったファイル…",
        "最近的文件…",
    ),
    ("save", "Save", "儲存", "保存", "保存"),
    (
        "save_as",
        "Save As…",
        "另存新檔…",
        "名前を付けて保存…",
        "另存为…",
    ),
    (
        "close_tab",
        "Close Tab",
        "關閉分頁",
        "タブを閉じる",
        "关闭标签页",
    ),
    (
        "reopen_closed_tab",
        "Reopen Closed Tab",
        "重新開啟已關閉的分頁",
        "閉じたタブを再度開く",
        "重新打开关闭的标签页",
    ),
    ("print", "Print…", "列印…", "印刷…", "打印…"),
    (
        "document_info",
        "Document Info…",
        "文件資訊…",
        "ドキュメント情報…",
        "文档信息…",
    ),
    (
        "preferences",
        "Preferences…",
        "偏好設定…",
        "環境設定…",
        "首选项…",
    ),
    ("edit", "Edit", "編輯", "編集", "编辑"),
    (
        "select_next_occurrence",
        "Select Next Occurrence",
        "選取下一個符合項目",
        "次の一致を選択",
        "选取下一个匹配项",
    ),
    (
        "select_all_occurrences",
        "Select All Occurrences",
        "選取所有符合項目",
        "すべての一致を選択",
        "选取所有匹配项",
    ),
    (
        "find",
        "Find and Replace…",
        "尋找與取代…",
        "検索と置換…",
        "查找和替换…",
    ),
    (
        "find_in_files",
        "Find in Files…",
        "在檔案中尋找…",
        "ファイル内を検索…",
        "在文件中查找…",
    ),
    (
        "goto_line",
        "Go to Line…",
        "跳至行號…",
        "行に移動…",
        "跳转到行…",
    ),
    (
        "toggle_bookmark",
        "Toggle Bookmark",
        "切換書籤",
        "ブックマークを切り替え",
        "切换书签",
    ),
    (
        "next_bookmark",
        "Next Bookmark",
        "下一個書籤",
        "次のブックマーク",
        "下一个书签",
    ),
    (
        "prev_bookmark",
        "Previous Bookmark",
        "上一個書籤",
        "前のブックマーク",
        "上一个书签",
    ),
    (
        "line_ops",
        "Line Operations",
        "行操作",
        "行の操作",
        "行操作",
    ),
    (
        "sort_lines",
        "Sort Lines",
        "排序行",
        "行を並べ替え",
        "排序行",
    ),
    (
        "unique_lines",
        "Remove Duplicate Lines",
        "移除重複行",
        "重複行を削除",
        "删除重复行",
    ),
    (
        "trim_trailing_whitespace",
        "Trim Trailing Whitespace",
        "移除行尾空白",
        "行末の空白を削除",
        "删除行尾空白",
    ),
    (
        "convert_leading_tabs_to_spaces",
        "Convert Leading Tabs to Spaces",
        "轉換前導 Tab 為空格",
        "先頭のタブをスペースに変換",
        "转换前导 Tab 为空格",
    ),
    (
        "convert_leading_spaces_to_tabs",
        "Convert Leading Spaces to Tabs",
        "轉換前導空格為 Tab",
        "先頭のスペースをタブに変換",
        "转换前导空格为 Tab",
    ),
    (
        "move_line_up",
        "Move Line Up",
        "上移一行",
        "行を上に移動",
        "上移一行",
    ),
    (
        "move_line_down",
        "Move Line Down",
        "下移一行",
        "行を下に移動",
        "下移一行",
    ),
    (
        "duplicate_line",
        "Duplicate Line",
        "複製行",
        "行を複製",
        "复制行",
    ),
    ("delete_line", "Delete Line", "刪除行", "行を削除", "删除行"),
    (
        "uppercase",
        "UPPERCASE",
        "轉大寫",
        "大文字に変換",
        "转为大写",
    ),
    (
        "lowercase",
        "lowercase",
        "轉小寫",
        "小文字に変換",
        "转为小写",
    ),
    (
        "to_full_width",
        "Convert to Full-width",
        "轉為全形",
        "全角に変換",
        "转为全角",
    ),
    (
        "to_half_width",
        "Convert to Half-width",
        "轉為半形",
        "半角に変換",
        "转为半角",
    ),
    (
        "normalize_nfc",
        "Normalize to NFC",
        "正規化為 NFC",
        "NFC に正規化",
        "规范化为 NFC",
    ),
    (
        "normalize_nfd",
        "Normalize to NFD",
        "正規化為 NFD",
        "NFD に正規化",
        "规范化为 NFD",
    ),
    (
        "batch_convert",
        "Batch Encoding Conversion…",
        "批次轉換編碼…",
        "エンコーディング一括変換…",
        "批量转换编码…",
    ),
    (
        "stream_replace",
        "Replace in Large File…",
        "在大型檔案中取代…",
        "大きいファイル内で置換…",
        "在大文件中替换…",
    ),
    ("view", "View", "檢視", "表示", "视图"),
    (
        "command_palette",
        "Command Palette…",
        "命令面板…",
        "コマンドパレット…",
        "命令面板…",
    ),
    ("word_wrap", "Word Wrap", "自動換行", "折り返し", "自动换行"),
    (
        "show_invisibles",
        "Show Invisibles",
        "顯示不可見字元",
        "不可視文字を表示",
        "显示不可见字符",
    ),
    (
        "indent_guides",
        "Indent Guides",
        "縮排輔助線",
        "インデントガイド",
        "缩进参考线",
    ),
    (
        "suspicious_chars",
        "Suspicious Characters",
        "可疑字元",
        "疑わしい文字",
        "可疑字符",
    ),
    ("read_only", "Read-Only", "唯讀", "読み取り専用", "只读"),
    (
        "fold_all",
        "Fold All",
        "全部摺疊",
        "すべて折りたたむ",
        "全部折叠",
    ),
    (
        "unfold_all",
        "Unfold All",
        "全部展開",
        "すべて展開",
        "全部展开",
    ),
    ("theme", "Theme", "主題", "テーマ", "主题"),
    (
        "theme_system",
        "Follow system",
        "跟隨系統",
        "システムに従う",
        "跟随系统",
    ),
    ("theme_light", "Light", "亮色", "ライト", "浅色"),
    ("theme_dark", "Dark", "暗色", "ダーク", "深色"),
    ("theme_paper", "Paper", "紙張", "紙", "纸张"),
    ("theme_dusk", "Dusk", "黃昏", "黄昏", "黄昏"),
    ("zoom_in", "Zoom In", "放大", "拡大", "放大"),
    ("zoom_out", "Zoom Out", "縮小", "縮小", "缩小"),
    (
        "zoom_reset",
        "Actual Size",
        "實際大小",
        "実際のサイズ",
        "实际大小",
    ),
    ("window", "Window", "視窗", "ウィンドウ", "窗口"),
];

/// Look up a menu label by id and language ("en" | "zh-TW" | "ja" | "zh-CN",
/// anything else falls back to English). Panics on an unknown id — that is
/// a programming error in this module (a build()/retitle_menu() call site
/// referencing an id missing from `LABELS`), not a runtime condition to
/// degrade from.
fn label(id: &str, lang: &str) -> &'static str {
    let (_, en, zh_tw, ja, zh_cn) = LABELS
        .iter()
        .find(|(entry_id, _, _, _, _)| *entry_id == id)
        .unwrap_or_else(|| panic!("menu.rs LABELS has no entry for id {id:?}"));
    match lang {
        "zh-TW" => zh_tw,
        "ja" => ja,
        "zh-CN" => zh_cn,
        _ => en,
    }
}

/// Resolve a language preference ("system" | "en" | "zh-TW" | "ja" |
/// "zh-CN") to "en" | "zh-TW" | "ja" | "zh-CN". Mirrors `src/i18n.ts`
/// `effectiveLocale`/`resolveSystemLocale`: "system" (or any unrecognized
/// value) follows the OS locale.
pub fn resolve_lang(pref: &str) -> String {
    match pref {
        "en" => "en".to_string(),
        "zh-TW" => "zh-TW".to_string(),
        "ja" => "ja".to_string(),
        "zh-CN" => "zh-CN".to_string(),
        _ => resolve_system_lang(),
    }
}

/// Classify the OS locale tag the same way `src/i18n.ts`
/// `resolveSystemLocale` classifies `navigator.language`: "ja"/"ja-*" tags
/// resolve to "ja"; Traditional-Chinese-bearing tags ("zh-tw", anything
/// containing "hant", "zh-hk", "zh-mo") resolve to "zh-TW";
/// Simplified-Chinese-bearing tags ("zh-cn", anything containing "hans",
/// "zh-sg") resolve to "zh-CN"; a bare "zh" and every other language fall
/// back to "en" rather than guessing a script.
fn resolve_system_lang() -> String {
    let tag = sys_locale::get_locale().unwrap_or_default().to_lowercase();
    if tag == "ja" || tag.starts_with("ja-") {
        return "ja".to_string();
    }
    if !tag.starts_with("zh") {
        return "en".to_string();
    }
    if tag == "zh-tw" || tag.contains("hant") || tag == "zh-hk" || tag == "zh-mo" {
        "zh-TW".to_string()
    } else if tag == "zh-cn" || tag.contains("hans") || tag == "zh-sg" {
        "zh-CN".to_string()
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
        .item(
            // Built disabled: the closed-tabs stack (ROADMAP.md v0.5
            // Track C) is session-local and always empty at launch;
            // sync_reopen_closed_tab_menu enables the item once the
            // frontend records the first closed tab.
            &MenuItemBuilder::with_id("reopen_closed_tab", l("reopen_closed_tab"))
                .accelerator("CmdOrCtrl+Shift+T")
                .enabled(false)
                .build(app)?,
        )
        .separator()
        .item(
            // CmdOrCtrl+P belongs to quick open (modern editor convention).
            &MenuItemBuilder::with_id("print", l("print"))
                .accelerator("CmdOrCtrl+Alt+P")
                .build(app)?,
        )
        .separator()
        .item(
            // Read-only trust surface (ROADMAP.md v0.6 E1): no accelerator,
            // opens an in-DOM dialog (src/docinfo.ts), not a further native
            // flow. Always enabled, including for an untitled tab — the
            // dialog itself shows a reduced, buffer-only view rather than
            // the item being disabled (see docinfo.ts's own doc comment for
            // why that choice was made over a disabled menu item).
            &MenuItemBuilder::with_id("document_info", l("document_info")).build(app)?,
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

    // A plain (non-checkable) submenu, unlike the View > Theme radio group
    // below: no runtime state to keep in sync, so no THEME_IDS-style const
    // array or sync_* command is needed — retitle_menu just walks these ids.
    let line_ops_menu = SubmenuBuilder::with_id(app, "line_ops", l("line_ops"))
        .item(&MenuItemBuilder::with_id("sort_lines", l("sort_lines")).build(app)?)
        .item(&MenuItemBuilder::with_id("unique_lines", l("unique_lines")).build(app)?)
        .item(
            &MenuItemBuilder::with_id("trim_trailing_whitespace", l("trim_trailing_whitespace"))
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(
                "convert_leading_tabs_to_spaces",
                l("convert_leading_tabs_to_spaces"),
            )
            .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(
                "convert_leading_spaces_to_tabs",
                l("convert_leading_spaces_to_tabs"),
            )
            .build(app)?,
        )
        .separator()
        // No accelerators: CM6's own `defaultKeymap` (bundled into
        // editor.ts's `basicSetup`) already binds Alt-ArrowUp/Down,
        // Shift-Alt-ArrowUp/Down, and Shift-Mod-k inside the editor. A
        // native menu accelerator on the same keys would give the
        // shortcut two owners — the same double-fire pitfall the View
        // menu's Fold All/Unfold All items avoid below.
        .item(&MenuItemBuilder::with_id("move_line_up", l("move_line_up")).build(app)?)
        .item(&MenuItemBuilder::with_id("move_line_down", l("move_line_down")).build(app)?)
        .item(&MenuItemBuilder::with_id("duplicate_line", l("duplicate_line")).build(app)?)
        .item(&MenuItemBuilder::with_id("delete_line", l("delete_line")).build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("uppercase", l("uppercase")).build(app)?)
        .item(&MenuItemBuilder::with_id("lowercase", l("lowercase")).build(app)?)
        .item(&MenuItemBuilder::with_id("to_full_width", l("to_full_width")).build(app)?)
        .item(&MenuItemBuilder::with_id("to_half_width", l("to_half_width")).build(app)?)
        .separator()
        // ROADMAP.md v0.4 Track A [danger]. Whole-document transforms, like
        // sort/unique/trim above (not a selection-verbatim transform like
        // upper/lowercase or full/half-width) — see main.ts's
        // `runNormalizeFlow`, which always normalizes the entire buffer via
        // `editor.content()`/`editor.replaceContent`, never a selection.
        // No accelerator: an uncommon-enough, confirm-gated action that no
        // other editor convention already binds a key to.
        .item(&MenuItemBuilder::with_id("normalize_nfc", l("normalize_nfc")).build(app)?)
        .item(&MenuItemBuilder::with_id("normalize_nfd", l("normalize_nfd")).build(app)?)
        .build()?;

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
        // No accelerators: @codemirror/search's `searchKeymap` (bundled into
        // editor.ts's `basicSetup`) already binds Mod-d and Mod-Shift-l
        // inside the editor. A native menu accelerator on the same keys
        // would give the shortcut two owners — the same double-fire
        // pitfall the Line Operations move/duplicate/delete items and the
        // View menu's Fold All/Unfold All avoid.
        .item(
            &MenuItemBuilder::with_id("select_next_occurrence", l("select_next_occurrence"))
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("select_all_occurrences", l("select_all_occurrences"))
                .build(app)?,
        )
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
        .item(&MenuItemBuilder::with_id("toggle_bookmark", l("toggle_bookmark")).build(app)?)
        .item(&MenuItemBuilder::with_id("next_bookmark", l("next_bookmark")).build(app)?)
        .item(&MenuItemBuilder::with_id("prev_bookmark", l("prev_bookmark")).build(app)?)
        .separator()
        .item(&line_ops_menu)
        .separator()
        .item(&MenuItemBuilder::with_id("batch_convert", l("batch_convert")).build(app)?)
        .item(&MenuItemBuilder::with_id("stream_replace", l("stream_replace")).build(app)?)
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
            // Command Palette (ROADMAP.md v0.6 C1): Mod+Shift+P opens a
            // fuzzy-searchable overlay (src/palette.ts) over every
            // dispatchable command in this menu -- a discoverability
            // wrapper, not a new capability. Placed first in View, the same
            // convention several other editors use for their own command
            // palette entry. A plain MenuItem, not a CheckMenuItem: there is
            // no runtime state to keep in sync (unlike read_only/theme
            // below), only a fixed label, so no dedicated sync_*_menu
            // command is needed -- same reasoning as line_ops's own header
            // comment.
            &MenuItemBuilder::with_id("command_palette", l("command_palette"))
                .accelerator("CmdOrCtrl+Shift+P")
                .build(app)?,
        )
        .separator()
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
        .item(
            &CheckMenuItemBuilder::with_id("indent_guides", l("indent_guides"))
                .checked(current_prefs.indent_guides)
                .build(app)?,
        )
        .item(
            // ROADMAP.md v0.4 Track A. A standalone CheckMenuItem exactly
            // like word_wrap/show_invisibles/indent_guides above: a global
            // preference, native auto-toggle checkmark on click is enough,
            // no dedicated sync_* command needed (contrast read_only below,
            // which is per-tab and needs one).
            &CheckMenuItemBuilder::with_id("suspicious_chars", l("suspicious_chars"))
                .checked(current_prefs.suspicious_chars)
                .build(app)?,
        )
        .item(
            // Unlike word_wrap/show_invisibles/indent_guides above, this is
            // per-tab, not a global preference — there is no prefs.rs value
            // to read at build time (session restore happens later, in the
            // frontend), so this starts unchecked/enabled and gets
            // corrected once the initial active tab is known: main.ts's
            // showActive (via syncReadOnlyState) calls sync_read_only_menu
            // right after restoreSession, and again on every subsequent
            // tab switch or toggle (ROADMAP.md v0.4 Track C).
            &CheckMenuItemBuilder::with_id("read_only", l("read_only")).build(app)?,
        )
        .separator()
        // No accelerator: CM6's own `foldKeymap` (bundled into editor.ts's
        // `basicSetup`) already binds Mod-Alt-[ / Mod-Alt-] inside the
        // editor. A native menu accelerator on the same keys would give the
        // shortcut two owners, same pitfall this module's header comment
        // warns about for the file shortcuts.
        .item(&MenuItemBuilder::with_id("fold_all", l("fold_all")).build(app)?)
        .item(&MenuItemBuilder::with_id("unfold_all", l("unfold_all")).build(app)?)
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

/// Re-check (or uncheck) the View > Read-Only item and set whether it can be
/// clicked at all (ROADMAP.md v0.4 Track C). Unlike `sync_theme_menu`'s radio
/// group, this is a single standalone `CheckMenuItem` whose native checkmark
/// would normally flip itself automatically on click (same as `word_wrap`) —
/// but that alone isn't enough here: the checked state must also track
/// *switching* to a different tab (a plain click never fires), so the
/// frontend always passes both values explicitly rather than relying on the
/// native auto-toggle. `enabled` is `false` for a truncated large-file
/// preview — its read-only state can never be lifted, so the item is shown
/// checked but disabled rather than left clickable with nothing a click
/// could legitimately do. Called from main.ts's `syncReadOnlyState`, itself
/// invoked on every tab switch (`showActive`) and on the toggle action
/// itself (`toggleReadOnly`).
#[tauri::command]
pub fn sync_read_only_menu<R: Runtime>(
    app: AppHandle<R>,
    checked: bool,
    enabled: bool,
) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let Some(item) = menu
        .get("view")
        .and_then(|item| item.as_submenu().cloned())
        .and_then(|view| view.get("read_only"))
        .and_then(|item| item.as_check_menuitem().cloned())
    else {
        return Ok(());
    };
    item.set_checked(checked).map_err(|e| e.to_string())?;
    item.set_enabled(enabled).map_err(|e| e.to_string())?;
    Ok(())
}

/// Enable or disable the File > Reopen Closed Tab item (ROADMAP.md v0.5
/// Track C). The item is built disabled — the closed-tabs stack is
/// session-local, never persisted, and therefore always empty at launch —
/// and this flips it as the frontend's stack becomes non-empty/empty
/// (main.ts's `syncReopenClosedTabState`, called after every push/pop).
/// Unlike `sync_read_only_menu`'s CheckMenuItem this is a plain MenuItem,
/// so the lookup goes through `as_menuitem` (the `retitle_menu` pattern)
/// and there is no checked state to sync.
#[tauri::command]
pub fn sync_reopen_closed_tab_menu<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let Some(item) = menu
        .get("file")
        .and_then(|item| item.as_submenu().cloned())
        .and_then(|file| file.get("reopen_closed_tab"))
        .and_then(|item| item.as_menuitem().cloned())
    else {
        return Ok(());
    };
    item.set_enabled(enabled).map_err(|e| e.to_string())?;
    Ok(())
}

/// Relabel every custom (`with_id`) menu entry to `locale`'s labels
/// ("en" | "zh-TW" | "ja" | "zh-CN", already resolved — never "system"; see
/// `resolve_lang` and the frontend's `src/i18n.ts` `effectiveLocale`).
/// Called from the Preferences dialog when the language preference changes,
/// so the native menu never needs a restart to catch up with the frontend's
/// language.
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
            "reopen_closed_tab",
            "print",
            "document_info",
            "preferences",
        ] {
            if let Some(item) = file.get(id).and_then(|item| item.as_menuitem().cloned()) {
                item.set_text(l(id)).map_err(|e| e.to_string())?;
            }
        }
    }

    if let Some(edit) = menu.get("edit").and_then(|item| item.as_submenu().cloned()) {
        edit.set_text(l("edit")).map_err(|e| e.to_string())?;
        for id in [
            "select_next_occurrence",
            "select_all_occurrences",
            "find",
            "find_in_files",
            "goto_line",
            "toggle_bookmark",
            "next_bookmark",
            "prev_bookmark",
            "batch_convert",
            "stream_replace",
        ] {
            if let Some(item) = edit.get(id).and_then(|item| item.as_menuitem().cloned()) {
                item.set_text(l(id)).map_err(|e| e.to_string())?;
            }
        }
        if let Some(line_ops) = edit
            .get("line_ops")
            .and_then(|item| item.as_submenu().cloned())
        {
            line_ops
                .set_text(l("line_ops"))
                .map_err(|e| e.to_string())?;
            for id in [
                "sort_lines",
                "unique_lines",
                "trim_trailing_whitespace",
                "convert_leading_tabs_to_spaces",
                "convert_leading_spaces_to_tabs",
                "move_line_up",
                "move_line_down",
                "duplicate_line",
                "delete_line",
                "uppercase",
                "lowercase",
                "to_full_width",
                "to_half_width",
                "normalize_nfc",
                "normalize_nfd",
            ] {
                if let Some(item) = line_ops
                    .get(id)
                    .and_then(|item| item.as_menuitem().cloned())
                {
                    item.set_text(l(id)).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    if let Some(view) = menu.get("view").and_then(|item| item.as_submenu().cloned()) {
        view.set_text(l("view")).map_err(|e| e.to_string())?;
        if let Some(item) = view
            .get("command_palette")
            .and_then(|item| item.as_menuitem().cloned())
        {
            item.set_text(l("command_palette"))
                .map_err(|e| e.to_string())?;
        }
        for id in [
            "word_wrap",
            "show_invisibles",
            "indent_guides",
            "suspicious_chars",
            "read_only",
        ] {
            if let Some(item) = view
                .get(id)
                .and_then(|item| item.as_check_menuitem().cloned())
            {
                item.set_text(l(id)).map_err(|e| e.to_string())?;
            }
        }
        for id in ["fold_all", "unfold_all"] {
            if let Some(item) = view.get(id).and_then(|item| item.as_menuitem().cloned()) {
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

/// Ids present in `LABELS` that must never appear as a Command Palette
/// entry (ROADMAP.md v0.6 C1): pure submenu containers with no dispatchable
/// action of their own — clicking one only opens/closes a submenu, there is
/// no `plume://menu` case for any of these in main.ts's `dispatchMenuCommand`
/// switch — plus the palette's own entry (opening the palette from inside
/// itself is not a useful action). Checked by
/// `palette_excluded_ids_are_all_real_labels_entries` below so a typo'd id
/// here can't silently no-op the exclusion.
const PALETTE_EXCLUDED_IDS: &[&str] = &[
    "file",
    "edit",
    "view",
    "line_ops",
    "theme",
    "window",
    "command_palette",
];

/// One entry in the Command Palette's command list (ROADMAP.md v0.6 C1):
/// `id` is the same string `main.ts`'s `dispatchMenuCommand` switches on;
/// `label` is `id`'s `LABELS` text already resolved to the caller's locale.
/// Field names are camelCase on the frontend by Tauri's default JS-binding
/// convention (mirrors every other `#[derive(Serialize)]` command-return
/// struct in this codebase, e.g. `OpenedDocument` in lib.rs).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteCommand {
    id: String,
    label: String,
}

/// List every dispatchable menu command as `(id, label)` pairs in `locale`,
/// for the Command Palette (ROADMAP.md v0.6 C1). `locale` is
/// already-resolved ("en" | "zh-TW" | "ja" | "zh-CN"), the same contract as
/// `retitle_menu` — the frontend passes `i18n.ts`'s `getLocale()` directly,
/// so the palette can never show a different label than what's currently in
/// the native menu. Pure and infallible: no `AppHandle` needed, since this
/// is just a filtered, relabeled read of the static `LABELS` table, not a
/// live menu query. v1 lists every remaining command with no per-command
/// enabled/disabled filtering — a documented trade-off (src/palette.ts's
/// module doc comment covers why a command reached in an invalid state from
/// the palette is still safe).
#[tauri::command]
pub fn palette_commands(locale: String) -> Vec<PaletteCommand> {
    LABELS
        .iter()
        .filter(|entry| !PALETTE_EXCLUDED_IDS.contains(&entry.0))
        .map(|entry| PaletteCommand {
            id: entry.0.to_string(),
            label: label(entry.0, &locale).to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{label, palette_commands, resolve_lang, LABELS, PALETTE_EXCLUDED_IDS, THEME_IDS};

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
        let mut ids: Vec<&str> = LABELS.iter().map(|(id, _, _, _, _)| *id).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "LABELS has a duplicate id");
    }

    #[test]
    fn labels_has_a_non_empty_string_for_every_language_and_id() {
        for (id, en, zh_tw, ja, zh_cn) in LABELS {
            assert!(!en.is_empty(), "empty English label for {id:?}");
            assert!(!zh_tw.is_empty(), "empty zh-TW label for {id:?}");
            assert!(!ja.is_empty(), "empty Japanese label for {id:?}");
            assert!(!zh_cn.is_empty(), "empty zh-CN label for {id:?}");
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
    fn label_returns_the_ja_entry_for_ja() {
        assert_eq!(label("open", "ja"), "開く…");
    }

    #[test]
    fn label_returns_the_zh_cn_entry_for_zh_cn() {
        assert_eq!(label("open", "zh-CN"), "打开…");
    }

    // ROADMAP.md v0.5 Track C reopen closed tab: the File menu's new
    // "reopen_closed_tab" item id, pinned across all four languages — same
    // rationale as read_only's dedicated test below.
    // ROADMAP.md v0.6 E1 Document Info dialog: the File menu's new
    // "document_info" item id, pinned across all four languages — same
    // rationale as read_only's dedicated test below.
    #[test]
    fn label_returns_the_correct_document_info_text_for_every_language() {
        assert_eq!(label("document_info", "en"), "Document Info…");
        assert_eq!(label("document_info", "zh-TW"), "文件資訊…");
        assert_eq!(label("document_info", "ja"), "ドキュメント情報…");
        assert_eq!(label("document_info", "zh-CN"), "文档信息…");
    }

    #[test]
    fn label_returns_the_correct_reopen_closed_tab_text_for_every_language() {
        assert_eq!(label("reopen_closed_tab", "en"), "Reopen Closed Tab");
        assert_eq!(label("reopen_closed_tab", "zh-TW"), "重新開啟已關閉的分頁");
        assert_eq!(label("reopen_closed_tab", "ja"), "閉じたタブを再度開く");
        assert_eq!(label("reopen_closed_tab", "zh-CN"), "重新打开关闭的标签页");
    }

    // ROADMAP.md v0.4 Track C per-tab read-only mode: the View menu's new
    // "read_only" CheckMenuItem id, pinned across all four languages —
    // labels_has_a_non_empty_string_for_every_language_and_id above only
    // checks non-emptiness, not the actual text, so this catches a typo'd
    // translation the generic sweep wouldn't.
    #[test]
    fn label_returns_the_correct_read_only_text_for_every_language() {
        assert_eq!(label("read_only", "en"), "Read-Only");
        assert_eq!(label("read_only", "zh-TW"), "唯讀");
        assert_eq!(label("read_only", "ja"), "読み取り専用");
        assert_eq!(label("read_only", "zh-CN"), "只读");
    }

    // ROADMAP.md v0.4 Track A invisible/ambiguous character audit: the View
    // menu's new "suspicious_chars" CheckMenuItem id, pinned across all four
    // languages — same rationale as read_only's dedicated test above.
    #[test]
    fn label_returns_the_correct_suspicious_chars_text_for_every_language() {
        assert_eq!(label("suspicious_chars", "en"), "Suspicious Characters");
        assert_eq!(label("suspicious_chars", "zh-TW"), "可疑字元");
        assert_eq!(label("suspicious_chars", "ja"), "疑わしい文字");
        assert_eq!(label("suspicious_chars", "zh-CN"), "可疑字符");
    }

    // ROADMAP.md v0.4 Track C indentation tools: the Edit > Line Operations
    // submenu's two new leading-indentation conversion items, pinned across
    // all four languages — same rationale as read_only/suspicious_chars's
    // dedicated tests above.
    #[test]
    fn label_returns_the_correct_convert_leading_tabs_to_spaces_text_for_every_language() {
        assert_eq!(
            label("convert_leading_tabs_to_spaces", "en"),
            "Convert Leading Tabs to Spaces"
        );
        assert_eq!(
            label("convert_leading_tabs_to_spaces", "zh-TW"),
            "轉換前導 Tab 為空格"
        );
        assert_eq!(
            label("convert_leading_tabs_to_spaces", "ja"),
            "先頭のタブをスペースに変換"
        );
        assert_eq!(
            label("convert_leading_tabs_to_spaces", "zh-CN"),
            "转换前导 Tab 为空格"
        );
    }

    #[test]
    fn label_returns_the_correct_convert_leading_spaces_to_tabs_text_for_every_language() {
        assert_eq!(
            label("convert_leading_spaces_to_tabs", "en"),
            "Convert Leading Spaces to Tabs"
        );
        assert_eq!(
            label("convert_leading_spaces_to_tabs", "zh-TW"),
            "轉換前導空格為 Tab"
        );
        assert_eq!(
            label("convert_leading_spaces_to_tabs", "ja"),
            "先頭のスペースをタブに変換"
        );
        assert_eq!(
            label("convert_leading_spaces_to_tabs", "zh-CN"),
            "转换前导空格为 Tab"
        );
    }

    // ROADMAP.md v0.4 Track A full-width/half-width conversion: the Edit >
    // Line Operations submenu's two new ids, pinned across all four
    // languages -- same rationale as convert_leading_tabs_to_spaces/
    // convert_leading_spaces_to_tabs's dedicated tests above.
    #[test]
    fn label_returns_the_correct_to_full_width_text_for_every_language() {
        assert_eq!(label("to_full_width", "en"), "Convert to Full-width");
        assert_eq!(label("to_full_width", "zh-TW"), "轉為全形");
        assert_eq!(label("to_full_width", "ja"), "全角に変換");
        assert_eq!(label("to_full_width", "zh-CN"), "转为全角");
    }

    #[test]
    fn label_returns_the_correct_to_half_width_text_for_every_language() {
        assert_eq!(label("to_half_width", "en"), "Convert to Half-width");
        assert_eq!(label("to_half_width", "zh-TW"), "轉為半形");
        assert_eq!(label("to_half_width", "ja"), "半角に変換");
        assert_eq!(label("to_half_width", "zh-CN"), "转为半角");
    }

    // ROADMAP.md v0.4 Track A Unicode normalization [danger]: the Edit >
    // Line Operations submenu's two new ids, pinned across all four
    // languages -- same rationale as to_full_width/to_half_width's own
    // dedicated tests above.
    #[test]
    fn label_returns_the_correct_normalize_nfc_text_for_every_language() {
        assert_eq!(label("normalize_nfc", "en"), "Normalize to NFC");
        assert_eq!(label("normalize_nfc", "zh-TW"), "正規化為 NFC");
        assert_eq!(label("normalize_nfc", "ja"), "NFC に正規化");
        assert_eq!(label("normalize_nfc", "zh-CN"), "规范化为 NFC");
    }

    #[test]
    fn label_returns_the_correct_normalize_nfd_text_for_every_language() {
        assert_eq!(label("normalize_nfd", "en"), "Normalize to NFD");
        assert_eq!(label("normalize_nfd", "zh-TW"), "正規化為 NFD");
        assert_eq!(label("normalize_nfd", "ja"), "NFD に正規化");
        assert_eq!(label("normalize_nfd", "zh-CN"), "规范化为 NFD");
    }

    #[test]
    fn resolve_lang_uses_the_explicit_preference_when_recognized() {
        assert_eq!(resolve_lang("en"), "en");
        assert_eq!(resolve_lang("zh-TW"), "zh-TW");
        assert_eq!(resolve_lang("ja"), "ja");
        assert_eq!(resolve_lang("zh-CN"), "zh-CN");
    }

    // "system" (and any other value) falls through to the OS locale via
    // `sys_locale::get_locale()`, which is environment-dependent — not
    // pinned here (see src/i18n.test.ts `resolveSystemLocale` for the tag
    // classification logic this function mirrors, tested directly there).

    // ROADMAP.md v0.6 C1 Command Palette: the View menu's new
    // "command_palette" item id, pinned across all four languages — same
    // rationale as read_only/document_info's dedicated tests above.
    #[test]
    fn label_returns_the_correct_command_palette_text_for_every_language() {
        assert_eq!(label("command_palette", "en"), "Command Palette…");
        assert_eq!(label("command_palette", "zh-TW"), "命令面板…");
        assert_eq!(label("command_palette", "ja"), "コマンドパレット…");
        assert_eq!(label("command_palette", "zh-CN"), "命令面板…");
    }

    #[test]
    fn palette_excluded_ids_are_all_real_labels_entries() {
        // Guards PALETTE_EXCLUDED_IDS itself against a typo'd/stale id,
        // which would silently no-op that exclusion and inflate
        // palette_commands_includes_every_non_excluded_label's count into a
        // false pass below.
        for excluded in PALETTE_EXCLUDED_IDS {
            assert!(
                LABELS.iter().any(|(id, _, _, _, _)| id == excluded),
                "PALETTE_EXCLUDED_IDS references {excluded:?}, which isn't in LABELS"
            );
        }
    }

    #[test]
    fn palette_commands_excludes_every_container_and_self_id() {
        let commands = palette_commands("en".to_string());
        let ids: Vec<&str> = commands.iter().map(|c| c.id.as_str()).collect();
        for excluded in PALETTE_EXCLUDED_IDS {
            assert!(
                !ids.contains(excluded),
                "palette should not list {excluded:?}"
            );
        }
    }

    #[test]
    fn palette_commands_includes_every_non_excluded_label() {
        let commands = palette_commands("en".to_string());
        assert_eq!(commands.len(), LABELS.len() - PALETTE_EXCLUDED_IDS.len());
    }

    #[test]
    fn palette_commands_has_no_duplicate_ids() {
        let commands = palette_commands("en".to_string());
        let mut ids: Vec<&str> = commands.iter().map(|c| c.id.as_str()).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "palette_commands has a duplicate id");
    }

    #[test]
    fn palette_commands_labels_match_the_requested_locale() {
        let en = palette_commands("en".to_string());
        assert_eq!(en.iter().find(|c| c.id == "save").unwrap().label, "Save");

        let zh_tw = palette_commands("zh-TW".to_string());
        assert_eq!(zh_tw.iter().find(|c| c.id == "save").unwrap().label, "儲存");

        let ja = palette_commands("ja".to_string());
        assert_eq!(ja.iter().find(|c| c.id == "open").unwrap().label, "開く…");

        let zh_cn = palette_commands("zh-CN".to_string());
        assert_eq!(
            zh_cn.iter().find(|c| c.id == "open").unwrap().label,
            "打开…"
        );
    }

    #[test]
    fn palette_commands_falls_back_to_english_for_an_unrecognized_locale() {
        let commands = palette_commands("fr-FR".to_string());
        assert_eq!(
            commands.iter().find(|c| c.id == "save").unwrap().label,
            "Save"
        );
    }
}

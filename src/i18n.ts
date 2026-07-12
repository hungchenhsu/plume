// Typed UI dictionary. English is the source-of-truth key set: the `zhTW`
// dictionary is typed against the exact same `Messages` interface, so a
// missing (or extra) key in either dictionary is a compile error — there is
// no runtime "key not found" fallback path to test for.
//
// Values are either a plain string or a template function (for strings that
// interpolate a filename, a number, etc.). Traditional Chinese has a
// different word order than English, so every interpolated string is a full
// sentence template here, never string concatenation at the call site.
//
// Scope: this module owns all *frontend* UI strings. The native menu
// (src-tauri/src/menu.rs) maintains its own small en/zh-TW label table in
// Rust, since it is built before the frontend loads — see menu.rs.

export type Locale = "en" | "zh-TW";

export interface Messages {
  "app.untitled": string;
  "app.untitledNumbered": (n: number) => string;

  "tabs.closeAria": (title: string) => string;
  "tabs.newTabAria": string;

  "statusbar.noFile": string;
  "statusbar.cursor": (line: number, column: number) => string;
  "statusbar.encodingWithBom": (encoding: string) => string;
  "statusbar.readonlyPreview": (size: string) => string;
  "statusbar.decodeWarning": string;

  "confirm.unsavedChanges": (title: string) => string;
  "confirm.dontSave": string;
  "confirm.cancel": string;
  "confirm.save": string;

  "detectcard.reasonBom": string;
  "detectcard.reasonExtension": string;
  "detectcard.reasonDetector": string;
  "detectcard.reasonFallback": string;
  "detectcard.noBom": string;
  "detectcard.title": (encoding: string) => string;
  "detectcard.labelFile": string;
  "detectcard.labelBom": string;
  "detectcard.labelVerdict": string;
  "detectcard.labelSampled": string;
  "detectcard.labelWouldChoose": string;
  "detectcard.labelCurrentlyUsing": string;
  "detectcard.sampledAll": (size: string) => string;
  "detectcard.sampledPartial": (shown: string, total: string) => string;
  "detectcard.wouldChooseValue": (encoding: string, reason: string) => string;
  "detectcard.manualNote": (current: string, detected: string) => string;

  "hexview.showingAll": (size: string) => string;
  "hexview.showingPartial": (shown: string, total: string) => string;

  "findInFiles.chooseFolder": string;
  "findInFiles.searchPlaceholder": string;
  "findInFiles.matchCase": string;
  "findInFiles.regex": string;
  "findInFiles.searching": string;
  "findInFiles.status": (
    count: number,
    truncated: boolean,
    filesScanned: number,
  ) => string;

  "goto.placeholder": string;

  "quickOpen.searchPlaceholder": string;
  "quickOpen.noRecent": string;
  "quickOpen.noMatches": string;

  "preferences.title": string;
  "preferences.editorFont": string;
  "preferences.editorFontPlaceholder": string;
  "preferences.fontSize": string;
  "preferences.theme": string;
  "preferences.language": string;
  "preferences.encodingForNewFiles": string;
  "preferences.extHeading": string;
  "preferences.extHint": string;
  "preferences.extPlaceholder": string;
  "preferences.extRemoveTitle": string;
  "preferences.extAdd": string;
  "preferences.cancel": string;
  "preferences.save": string;
  "preferences.themeSystem": string;
  "preferences.themeLight": string;
  "preferences.themeDark": string;
  "preferences.themePaper": string;
  "preferences.themeDusk": string;
  "preferences.langSystemOption": string;

  "menu.whyEncoding": (encoding: string) => string;
  "menu.reopenWithEncoding": string;
  "menu.saveWithEncoding": string;
  "menu.viewRawBytes": string;
  "menu.repairMojibake": string;
  "menu.lineEndingLf": string;
  "menu.lineEndingCrlf": string;

  "mojibake.title": string;
  "mojibake.noCandidates": string;
  "mojibake.pickCandidate": string;
  "mojibake.candidateDescription": (original: string, intermediate: string) => string;
  "mojibake.replacementCount": (count: number) => string;
  "mojibake.before": string;
  "mojibake.after": string;
  "mojibake.appliedTitle": string;
  "mojibake.appliedMessage": string;

  "dialog.pagingTitle": string;
  "dialog.fileChangedTitle": string;
  "dialog.fileChangedMessage": (title: string) => string;
  "dialog.reload": string;
  "dialog.openFailedTitle": string;
  "dialog.readonlyPreviewTitle": string;
  "dialog.readonlyPreviewMessage": (title: string) => string;
  "dialog.saveFailedTitle": string;
  "dialog.lossyEncodingTitle": string;
  "dialog.lossyEncodingMessage": (encoding: string) => string;
  "dialog.lossyEncodingConfirm": string;
  "dialog.backupFailedTitle": string;
  "dialog.backupFailedMessage": (titles: string[]) => string;
  "dialog.backupFailedDiscard": string;
  "dialog.unsavedChangesTitle": string;
  "dialog.reopenMessage": (title: string) => string;
  "dialog.reopen": string;
  "dialog.reopenFailedTitle": string;
  "dialog.printTitle": string;

  "encoding.utf8": string;
  "encoding.utf8Bom": string;
  "encoding.utf16le": string;
  "encoding.utf16be": string;
  "encoding.big5": string;
  "encoding.gb18030": string;
  "encoding.gbk": string;
  "encoding.shiftJis": string;
  "encoding.eucJp": string;
  "encoding.eucKr": string;
  "encoding.windows1252": string;

  "common.loading": string;
}

const en: Messages = {
  "app.untitled": "Untitled",
  "app.untitledNumbered": (n) => `Untitled-${n}`,

  "tabs.closeAria": (title) => `Close ${title}`,
  "tabs.newTabAria": "New tab",

  "statusbar.noFile": "No file",
  "statusbar.cursor": (line, column) => `Ln ${line}, Col ${column}`,
  "statusbar.encodingWithBom": (encoding) => `${encoding} BOM`,
  "statusbar.readonlyPreview": (size) => `Read-only preview of ${size} file`,
  "statusbar.decodeWarning": "⚠ decoded with errors",

  "confirm.unsavedChanges": (title) => `"${title}" has unsaved changes.`,
  "confirm.dontSave": "Don't Save",
  "confirm.cancel": "Cancel",
  "confirm.save": "Save",

  "detectcard.reasonBom": "a BOM was found",
  "detectcard.reasonExtension": "per-extension preference, decoded cleanly",
  "detectcard.reasonDetector": "chardetng statistical detection",
  "detectcard.reasonFallback": "no evidence to analyze (empty file), defaulted",
  "detectcard.noBom": "No BOM found",
  "detectcard.title": (encoding) => `Why ${encoding}?`,
  "detectcard.labelFile": "File",
  "detectcard.labelBom": "BOM",
  "detectcard.labelVerdict": "chardetng verdict",
  "detectcard.labelSampled": "Sampled",
  "detectcard.labelWouldChoose": "Auto-detect would choose",
  "detectcard.labelCurrentlyUsing": "Currently using",
  "detectcard.sampledAll": (size) => `all ${size}`,
  "detectcard.sampledPartial": (shown, total) => `first ${shown} of ${total}`,
  "detectcard.wouldChooseValue": (encoding, reason) => `${encoding} (${reason})`,
  "detectcard.manualNote": (current, detected) =>
    `Currently using ${current} manually — auto-detect would choose ${detected}.`,

  "hexview.showingAll": (size) => `showing all ${size}`,
  "hexview.showingPartial": (shown, total) => `showing first ${shown} of ${total}`,

  "findInFiles.chooseFolder": "Choose folder…",
  "findInFiles.searchPlaceholder": "Search in files…",
  "findInFiles.matchCase": "Match case",
  "findInFiles.regex": "Regular expression",
  "findInFiles.searching": "Searching…",
  "findInFiles.status": (count, truncated, filesScanned) =>
    `${count}${truncated ? "+" : ""} match${count === 1 ? "" : "es"} in ${filesScanned} files`,

  "goto.placeholder": "Go to line…",

  "quickOpen.searchPlaceholder": "Search recent files…",
  "quickOpen.noRecent": "No recent files",
  "quickOpen.noMatches": "No matches",

  "preferences.title": "Preferences",
  "preferences.editorFont": "Editor font",
  "preferences.editorFontPlaceholder": "System default",
  "preferences.fontSize": "Font size",
  "preferences.theme": "Theme",
  "preferences.language": "Language",
  "preferences.encodingForNewFiles": "Encoding for new files",
  "preferences.extHeading": "Per-extension encodings",
  "preferences.extHint":
    "Files with these extensions open with the given encoding; a BOM, " +
    "valid UTF-8 text, or a byte mismatch still wins.",
  "preferences.extPlaceholder": "txt",
  "preferences.extRemoveTitle": "Remove",
  "preferences.extAdd": "Add",
  "preferences.cancel": "Cancel",
  "preferences.save": "Save",
  "preferences.themeSystem": "Follow system",
  "preferences.themeLight": "Light",
  "preferences.themeDark": "Dark",
  "preferences.themePaper": "Paper",
  "preferences.themeDusk": "Dusk",
  "preferences.langSystemOption": "System",

  "menu.whyEncoding": (encoding) => `Why ${encoding}?`,
  "menu.reopenWithEncoding": "Reopen with Encoding",
  "menu.saveWithEncoding": "Save with Encoding",
  "menu.viewRawBytes": "View raw bytes…",
  "menu.repairMojibake": "Repair mojibake…",
  "menu.lineEndingLf": "LF (Unix / macOS)",
  "menu.lineEndingCrlf": "CRLF (Windows)",

  "mojibake.title": "Repair mojibake",
  "mojibake.noCandidates":
    "No mis-decode pattern found — this doesn't look like mojibake.",
  "mojibake.pickCandidate": "Pick a repair to apply:",
  "mojibake.candidateDescription": (original, intermediate) =>
    `Looks like ${original} content that was decoded as ${intermediate} by mistake.`,
  "mojibake.replacementCount": (count) => `changes about ${count} character${count === 1 ? "" : "s"}`,
  "mojibake.before": "Before",
  "mojibake.after": "After repair",
  "mojibake.appliedTitle": "Mojibake repaired",
  "mojibake.appliedMessage":
    "The content was repaired in the editor. Use Undo to revert if this wasn't right.",

  "dialog.pagingTitle": "Paging",
  "dialog.fileChangedTitle": "File changed on disk",
  "dialog.fileChangedMessage": (title) =>
    `"${title}" changed on disk. Reload it and discard your unsaved changes?`,
  "dialog.reload": "Reload",
  "dialog.openFailedTitle": "Open failed",
  "dialog.readonlyPreviewTitle": "Read-only preview",
  "dialog.readonlyPreviewMessage": (title) =>
    `"${title}" is a read-only preview of a large file; saving is disabled.`,
  "dialog.saveFailedTitle": "Save failed",
  "dialog.lossyEncodingTitle": "Encoding warning",
  "dialog.lossyEncodingMessage": (encoding) =>
    `Some characters can't be represented in ${encoding}. Continuing to save ` +
    `will write replacement characters in their place, and this can't be undone.`,
  "dialog.lossyEncodingConfirm": "Save Anyway",
  "dialog.backupFailedTitle": "Backup failed",
  "dialog.backupFailedMessage": (titles) =>
    `Unsaved changes in ${titles.join(", ")} could not be written to their ` +
    `backup (disk full or folder not writable?). Closing now cannot keep ` +
    `these changes. Close anyway?`,
  "dialog.backupFailedDiscard": "Discard and Close",
  "dialog.unsavedChangesTitle": "Unsaved changes",
  "dialog.reopenMessage": (title) =>
    `Reopening will discard unsaved changes in "${title}". Continue?`,
  "dialog.reopen": "Reopen",
  "dialog.reopenFailedTitle": "Reopen failed",
  "dialog.printTitle": "Print",

  "encoding.utf8": "UTF-8",
  "encoding.utf8Bom": "UTF-8 with BOM",
  "encoding.utf16le": "UTF-16 LE",
  "encoding.utf16be": "UTF-16 BE",
  "encoding.big5": "Big5 (Traditional Chinese)",
  "encoding.gb18030": "GB18030 (Simplified Chinese)",
  "encoding.gbk": "GBK (Simplified Chinese)",
  "encoding.shiftJis": "Shift_JIS (Japanese)",
  "encoding.eucJp": "EUC-JP (Japanese)",
  "encoding.eucKr": "EUC-KR (Korean)",
  "encoding.windows1252": "Windows-1252 (Western)",

  "common.loading": "Loading…",
};

const zhTW: Messages = {
  "app.untitled": "未命名",
  "app.untitledNumbered": (n) => `未命名-${n}`,

  "tabs.closeAria": (title) => `關閉 ${title}`,
  "tabs.newTabAria": "新增分頁",

  "statusbar.noFile": "無檔案",
  "statusbar.cursor": (line, column) => `第 ${line} 行，第 ${column} 欄`,
  "statusbar.encodingWithBom": (encoding) => `${encoding} BOM`,
  "statusbar.readonlyPreview": (size) => `唯讀預覽（檔案大小 ${size}）`,
  "statusbar.decodeWarning": "⚠ 解碼時發生錯誤",

  "confirm.unsavedChanges": (title) => `「${title}」有未儲存的變更。`,
  "confirm.dontSave": "不要儲存",
  "confirm.cancel": "取消",
  "confirm.save": "儲存",

  "detectcard.reasonBom": "偵測到 BOM",
  "detectcard.reasonExtension": "依副檔名偏好設定，解碼成功",
  "detectcard.reasonDetector": "chardetng 統計偵測",
  "detectcard.reasonFallback": "無可分析的證據（空檔案），使用預設值",
  "detectcard.noBom": "未偵測到 BOM",
  "detectcard.title": (encoding) => `為何是 ${encoding}？`,
  "detectcard.labelFile": "檔案",
  "detectcard.labelBom": "BOM",
  "detectcard.labelVerdict": "chardetng 判定結果",
  "detectcard.labelSampled": "取樣範圍",
  "detectcard.labelWouldChoose": "自動偵測會選擇",
  "detectcard.labelCurrentlyUsing": "目前使用",
  "detectcard.sampledAll": (size) => `全部 ${size}`,
  "detectcard.sampledPartial": (shown, total) => `前 ${shown}（共 ${total}）`,
  "detectcard.wouldChooseValue": (encoding, reason) => `${encoding}（${reason}）`,
  "detectcard.manualNote": (current, detected) =>
    `目前手動使用 ${current}——自動偵測會選擇 ${detected}。`,

  "hexview.showingAll": (size) => `顯示全部 ${size}`,
  "hexview.showingPartial": (shown, total) => `顯示前 ${shown}（共 ${total}）`,

  "findInFiles.chooseFolder": "選擇資料夾…",
  "findInFiles.searchPlaceholder": "在檔案中搜尋…",
  "findInFiles.matchCase": "區分大小寫",
  "findInFiles.regex": "正規表示式",
  "findInFiles.searching": "搜尋中…",
  "findInFiles.status": (count, truncated, filesScanned) =>
    `在 ${filesScanned} 個檔案中找到 ${count}${truncated ? "+" : ""} 筆符合`,

  "goto.placeholder": "跳至行號…",

  "quickOpen.searchPlaceholder": "搜尋最近的檔案…",
  "quickOpen.noRecent": "沒有最近的檔案",
  "quickOpen.noMatches": "沒有符合的項目",

  "preferences.title": "偏好設定",
  "preferences.editorFont": "編輯器字型",
  "preferences.editorFontPlaceholder": "系統預設",
  "preferences.fontSize": "字型大小",
  "preferences.theme": "主題",
  "preferences.language": "語言",
  "preferences.encodingForNewFiles": "新檔案的編碼",
  "preferences.extHeading": "副檔名編碼對應",
  "preferences.extHint":
    "符合這些副檔名的檔案會以指定編碼開啟；BOM、有效的 UTF-8 文字，" +
    "或位元組不符時仍會優先採用。",
  "preferences.extPlaceholder": "txt",
  "preferences.extRemoveTitle": "移除",
  "preferences.extAdd": "新增",
  "preferences.cancel": "取消",
  "preferences.save": "儲存",
  "preferences.themeSystem": "跟隨系統",
  "preferences.themeLight": "亮色",
  "preferences.themeDark": "暗色",
  "preferences.themePaper": "紙張",
  "preferences.themeDusk": "黃昏",
  "preferences.langSystemOption": "系統預設",

  "menu.whyEncoding": (encoding) => `為何是 ${encoding}？`,
  "menu.reopenWithEncoding": "以指定編碼重新開啟",
  "menu.saveWithEncoding": "以指定編碼儲存",
  "menu.viewRawBytes": "檢視原始位元組…",
  "menu.repairMojibake": "修復亂碼…",
  "menu.lineEndingLf": "LF（Unix / macOS）",
  "menu.lineEndingCrlf": "CRLF（Windows）",

  "mojibake.title": "修復亂碼",
  "mojibake.noCandidates": "找不到可修復的 mis-decode pattern。",
  "mojibake.pickCandidate": "選擇一個修復方式套用：",
  "mojibake.candidateDescription": (original, intermediate) =>
    `看起來是 ${original} 的內容曾被當 ${intermediate} 解碼。`,
  "mojibake.replacementCount": (count) => `約變更 ${count} 個字元`,
  "mojibake.before": "修復前",
  "mojibake.after": "修復後",
  "mojibake.appliedTitle": "亂碼已修復",
  "mojibake.appliedMessage": "編輯器內容已修復，可用 Undo 復原。",

  "dialog.pagingTitle": "翻頁",
  "dialog.fileChangedTitle": "檔案已在磁碟上異動",
  "dialog.fileChangedMessage": (title) =>
    `「${title}」已在磁碟上異動，要重新載入並捨棄未儲存的變更嗎？`,
  "dialog.reload": "重新載入",
  "dialog.openFailedTitle": "開啟失敗",
  "dialog.readonlyPreviewTitle": "唯讀預覽",
  "dialog.readonlyPreviewMessage": (title) =>
    `「${title}」是大型檔案的唯讀預覽，無法儲存。`,
  "dialog.saveFailedTitle": "儲存失敗",
  "dialog.lossyEncodingTitle": "編碼警告",
  "dialog.lossyEncodingMessage": (encoding) =>
    `有字元無法以 ${encoding} 表示，繼續儲存將以替代字元寫入且無法復原。`,
  "dialog.lossyEncodingConfirm": "仍要儲存",
  "dialog.backupFailedTitle": "備份寫入失敗",
  "dialog.backupFailedMessage": (titles) =>
    `${titles.join("、")} 的未儲存變更無法寫入備份（磁碟已滿或資料夾` +
    `無法寫入？），現在關閉的話，這些變更將無法保留。仍要關閉？`,
  "dialog.backupFailedDiscard": "放棄變更並關閉",
  "dialog.unsavedChangesTitle": "未儲存的變更",
  "dialog.reopenMessage": (title) =>
    `重新開啟將捨棄「${title}」中未儲存的變更，是否繼續？`,
  "dialog.reopen": "重新開啟",
  "dialog.reopenFailedTitle": "重新開啟失敗",
  "dialog.printTitle": "列印",

  "encoding.utf8": "UTF-8",
  "encoding.utf8Bom": "UTF-8（含 BOM）",
  "encoding.utf16le": "UTF-16 LE",
  "encoding.utf16be": "UTF-16 BE",
  "encoding.big5": "Big5（繁體中文）",
  "encoding.gb18030": "GB18030（簡體中文）",
  "encoding.gbk": "GBK（簡體中文）",
  "encoding.shiftJis": "Shift_JIS（日文）",
  "encoding.eucJp": "EUC-JP（日文）",
  "encoding.eucKr": "EUC-KR（韓文）",
  "encoding.windows1252": "Windows-1252（西歐語系）",

  "common.loading": "載入中…",
};

const dictionaries: Record<Locale, Messages> = { en, "zh-TW": zhTW };

/**
 * Resolve a BCP-47 language tag (e.g. `navigator.language`) to a supported
 * `Locale`. Only Traditional-Chinese-bearing tags resolve to `zh-TW`
 * ("zh-TW", anything containing "Hant", "zh-HK", "zh-MO"); every other tag —
 * including Simplified Chinese ("zh-CN") — falls back to English, since
 * there is no Simplified Chinese dictionary.
 */
export function resolveSystemLocale(tag: string | undefined | null): Locale {
  const lang = (tag ?? "").toLowerCase();
  if (!lang.startsWith("zh")) return "en";
  if (lang === "zh-tw" || lang.includes("hant") || lang === "zh-hk" || lang === "zh-mo") {
    return "zh-TW";
  }
  return "en";
}

/**
 * Resolve a stored language preference ("system" | "en" | "zh-TW") to an
 * effective `Locale`, following the system locale for "system" or any
 * unrecognized value (forward-compatible default for prefs written by a
 * future build).
 */
export function effectiveLocale(pref: string, systemTag?: string | null): Locale {
  if (pref === "en" || pref === "zh-TW") return pref;
  return resolveSystemLocale(
    systemTag ?? (typeof navigator !== "undefined" ? navigator.language : undefined),
  );
}

let currentLocale: Locale = resolveSystemLocale(
  typeof navigator !== "undefined" ? navigator.language : undefined,
);

type LocaleListener = () => void;
const listeners = new Set<LocaleListener>();

export function getLocale(): Locale {
  return currentLocale;
}

/** Set the active locale and notify subscribers so live UI can redraw. */
export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  for (const listener of listeners) listener();
}

/** Subscribe to locale changes; returns an unsubscribe function. */
export function onLocaleChange(listener: LocaleListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Args<K extends keyof Messages> = Messages[K] extends (...a: infer A) => string
  ? A
  : [];

/** Look up and (if templated) interpolate a UI string in the active locale. */
export function t<K extends keyof Messages>(key: K, ...args: Args<K>): string {
  const entry = dictionaries[currentLocale][key];
  if (typeof entry === "function") {
    return (entry as unknown as (...a: Args<K>) => string)(...args);
  }
  return entry as string;
}

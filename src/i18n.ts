// Typed UI dictionary. English is the source-of-truth key set: every other
// dictionary (`zhTW`, `ja`, `zhCN`) is typed against the exact same
// `Messages` interface, so a missing (or extra) key in any dictionary is a
// compile error — there is no runtime "key not found" fallback path to test
// for.
//
// Values are either a plain string or a template function (for strings that
// interpolate a filename, a number, etc.). Word order varies by language, so
// every interpolated string is a full sentence template here, never string
// concatenation at the call site.
//
// Scope: this module owns all *frontend* UI strings. The native menu
// (src-tauri/src/menu.rs) maintains its own small en/zh-TW/ja/zh-CN label
// table in Rust, since it is built before the frontend loads — see menu.rs.

export type Locale = "en" | "zh-TW" | "ja" | "zh-CN";

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
  "statusbar.buildingIndex": string;
  "statusbar.textStats": (words: number, chars: number, lines: number) => string;
  "statusbar.textStatsSelection": (words: number, chars: number, lines: number) => string;

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
  "menu.compareEncodings": string;
  "menu.viewRawBytes": string;
  "menu.repairMojibake": string;
  "menu.lineEndingLf": string;
  "menu.lineEndingCrlf": string;
  "menu.lineEndingCr": string;

  "mojibake.title": string;
  "mojibake.noCandidates": string;
  "mojibake.pickCandidate": string;
  "mojibake.candidateDescription": (original: string, intermediate: string) => string;
  "mojibake.replacementCount": (count: number) => string;
  "mojibake.before": string;
  "mojibake.after": string;
  "mojibake.appliedTitle": string;
  "mojibake.appliedMessage": string;
  "mojibake.staleContentTitle": string;
  "mojibake.staleContentMessage": string;

  "comparePreview.title": (file: string) => string;
  "comparePreview.encodingALabel": string;
  "comparePreview.encodingBLabel": string;
  "comparePreview.compareButton": string;
  "comparePreview.malformedBadge": string;
  "comparePreview.reopenButton": string;

  "batchConvert.title": string;
  "batchConvert.chooseFolder": string;
  "batchConvert.chooseFolderFirst": string;
  "batchConvert.extPlaceholder": string;
  "batchConvert.targetLabel": string;
  "batchConvert.keepEncoding": string;
  "batchConvert.lineEndingLabel": string;
  "batchConvert.lineEndingKeep": string;
  "batchConvert.scanButton": string;
  "batchConvert.scanning": string;
  "batchConvert.noResults": string;
  "batchConvert.summary": (
    convertible: number,
    alreadyTarget: number,
    lossy: number,
    undecodable: number,
    tooLarge: number,
  ) => string;
  "batchConvert.statusConvertible": string;
  "batchConvert.statusAlreadyTarget": string;
  "batchConvert.statusLossy": string;
  "batchConvert.statusUndecodable": string;
  "batchConvert.statusTooLarge": string;
  "batchConvert.lineEndingMixed": string;
  "batchConvert.includeFileLabel": string;
  "batchConvert.convertButton": (count: number) => string;
  "batchConvert.confirmMessage": (count: number) => string;
  "batchConvert.confirmMessageIncomplete": (count: number, scanErrorCount: number) => string;
  "batchConvert.rescanNeeded": string;
  "batchConvert.converting": string;
  "batchConvert.resultSummary": (ok: number, failed: number) => string;
  "batchConvert.scanErrorsSummary": (count: number) => string;

  "streamReplace.title": (file: string) => string;
  "streamReplace.searchPlaceholder": string;
  "streamReplace.replacePlaceholder": string;
  "streamReplace.caseInsensitiveHint": string;
  "streamReplace.executeButton": string;
  "streamReplace.replacing": string;
  "streamReplace.resultMessage": (count: number) => string;

  "dialog.pagingTitle": string;
  "dialog.fileChangedTitle": string;
  "dialog.fileChangedMessage": (title: string) => string;
  "dialog.reload": string;
  "dialog.staleFileMessage": (title: string) => string;
  "dialog.overwrite": string;
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
  "dialog.streamReplaceUseRegularTitle": string;
  "dialog.streamReplaceUseRegularMessage": string;
  "dialog.lineIndexFailedTitle": string;
  "dialog.bookmarkNeedsGotoTitle": string;
  "dialog.bookmarkNeedsGotoMessage": string;

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
  "statusbar.buildingIndex": "Building line index…",
  "statusbar.textStats": (words, chars, lines) =>
    `${words} word${words === 1 ? "" : "s"}, ${chars} char${chars === 1 ? "" : "s"}, ` +
    `${lines} line${lines === 1 ? "" : "s"}`,
  "statusbar.textStatsSelection": (words, chars, lines) =>
    `Selected: ${words} word${words === 1 ? "" : "s"}, ${chars} char${chars === 1 ? "" : "s"}, ` +
    `${lines} line${lines === 1 ? "" : "s"}`,

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
  "menu.compareEncodings": "Compare encodings…",
  "menu.viewRawBytes": "View raw bytes…",
  "menu.repairMojibake": "Repair mojibake…",
  "menu.lineEndingLf": "LF (Unix / macOS)",
  "menu.lineEndingCrlf": "CRLF (Windows)",
  "menu.lineEndingCr": "CR (Classic Mac)",

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
  "mojibake.staleContentTitle": "Repair not applied",
  "mojibake.staleContentMessage":
    "The document changed while the repair was being prepared, so it wasn't applied — your edits are safe. Reopen Repair mojibake to try again.",

  "comparePreview.title": (file) => `Compare encodings — ${file}`,
  "comparePreview.encodingALabel": "A",
  "comparePreview.encodingBLabel": "B",
  "comparePreview.compareButton": "Compare",
  "comparePreview.malformedBadge": "decode errors",
  "comparePreview.reopenButton": "Reopen with this encoding",

  "batchConvert.title": "Batch Encoding Conversion",
  "batchConvert.chooseFolder": "Choose folder…",
  "batchConvert.chooseFolderFirst": "Choose a folder first.",
  "batchConvert.extPlaceholder":
    "Extensions, comma-separated (e.g. txt,md) — empty means all files",
  "batchConvert.targetLabel": "Target encoding",
  "batchConvert.keepEncoding": "Keep current encoding",
  "batchConvert.lineEndingLabel": "Line ending",
  "batchConvert.lineEndingKeep": "Keep",
  "batchConvert.scanButton": "Scan (dry run)",
  "batchConvert.scanning": "Scanning…",
  "batchConvert.noResults": "No matching files found.",
  "batchConvert.summary": (convertible, alreadyTarget, lossy, undecodable, tooLarge) =>
    `${convertible} convertible, ${alreadyTarget} already this encoding, ` +
    `${lossy} would lose data, ${undecodable} undecodable, ${tooLarge} too large`,
  "batchConvert.statusConvertible": "Convertible",
  "batchConvert.statusAlreadyTarget": "Already this encoding",
  "batchConvert.statusLossy": "Would lose data",
  "batchConvert.statusUndecodable": "Undecodable",
  "batchConvert.statusTooLarge": "Too large",
  "batchConvert.lineEndingMixed": "Mixed",
  "batchConvert.includeFileLabel": "Include this file",
  "batchConvert.convertButton": (count) => `Convert ${count} file${count === 1 ? "" : "s"}`,
  "batchConvert.confirmMessage": (count) =>
    `Convert ${count} file${count === 1 ? "" : "s"} in place? Each file is ` +
    `re-encoded from the auto-detected encoding shown in the report — ` +
    `review the Detected column first. This cannot be undone.`,
  "batchConvert.confirmMessageIncomplete": (count, scanErrorCount) =>
    `Convert ${count} file${count === 1 ? "" : "s"} in place? ${scanErrorCount} ` +
    `item${scanErrorCount === 1 ? "" : "s"} could not be scanned, so this report may ` +
    `be missing files — review the Detected column and the scan-error list first. ` +
    `This cannot be undone.`,
  "batchConvert.rescanNeeded": "Settings changed — scan again before converting.",
  "batchConvert.converting": "Converting…",
  "batchConvert.resultSummary": (ok, failed) =>
    failed === 0
      ? `Converted ${ok} file${ok === 1 ? "" : "s"}.`
      : `Converted ${ok} file${ok === 1 ? "" : "s"}, ${failed} failed.`,
  "batchConvert.scanErrorsSummary": (count) =>
    `${count} item${count === 1 ? "" : "s"} could not be scanned — this report may be incomplete.`,

  "streamReplace.title": (file) => `Replace in Large File — ${file}`,
  "streamReplace.searchPlaceholder": "Search…",
  "streamReplace.replacePlaceholder": "Replace with…",
  "streamReplace.caseInsensitiveHint":
    "Case-insensitive matching applies to ASCII letters only.",
  "streamReplace.executeButton": "Replace All",
  "streamReplace.replacing": "Replacing…",
  "streamReplace.resultMessage": (count) =>
    `${count} replacement${count === 1 ? "" : "s"} made.`,

  "dialog.pagingTitle": "Paging",
  "dialog.fileChangedTitle": "File changed on disk",
  "dialog.fileChangedMessage": (title) =>
    `"${title}" changed on disk. Reload it and discard your unsaved changes?`,
  "dialog.reload": "Reload",
  "dialog.staleFileMessage": (title) =>
    `"${title}" changed on disk since it was opened. Overwrite it with ` +
    `your version, reload the newer version and discard your unsaved ` +
    `changes, or cancel this save.`,
  "dialog.overwrite": "Overwrite",
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
  "dialog.streamReplaceUseRegularTitle": "Replace in Large File",
  "dialog.streamReplaceUseRegularMessage":
    "This isn't a large-file preview. Use the regular Find and Replace " +
    "(Cmd/Ctrl+F) instead.",
  "dialog.lineIndexFailedTitle": "Line index failed",
  "dialog.bookmarkNeedsGotoTitle": "Position unknown",
  "dialog.bookmarkNeedsGotoMessage":
    "This window's position in the file isn't known yet. Use Go to Line " +
    "to jump somewhere first, then bookmark it.",

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
  "statusbar.buildingIndex": "正在建立行號索引…",
  "statusbar.textStats": (words, chars, lines) => `${words} 詞、${chars} 字元、${lines} 行`,
  "statusbar.textStatsSelection": (words, chars, lines) =>
    `已選取：${words} 詞、${chars} 字元、${lines} 行`,

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
  "menu.compareEncodings": "比較編碼…",
  "menu.viewRawBytes": "檢視原始位元組…",
  "menu.repairMojibake": "修復亂碼…",
  "menu.lineEndingLf": "LF（Unix / macOS）",
  "menu.lineEndingCrlf": "CRLF（Windows）",
  "menu.lineEndingCr": "CR（Classic Mac）",

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
  "mojibake.staleContentTitle": "未套用修復",
  "mojibake.staleContentMessage":
    "修復準備期間文件內容已變更，因此未套用——你的編輯內容已保留。請重新開啟「修復亂碼」再試一次。",

  "comparePreview.title": (file) => `比較編碼 — ${file}`,
  "comparePreview.encodingALabel": "A",
  "comparePreview.encodingBLabel": "B",
  "comparePreview.compareButton": "比較",
  "comparePreview.malformedBadge": "解碼錯誤",
  "comparePreview.reopenButton": "以此編碼重新開啟",

  "batchConvert.title": "批次轉換編碼",
  "batchConvert.chooseFolder": "選擇資料夾…",
  "batchConvert.chooseFolderFirst": "請先選擇資料夾。",
  "batchConvert.extPlaceholder": "副檔名，逗號分隔（如 txt,md）——留空代表所有檔案",
  "batchConvert.targetLabel": "目標編碼",
  "batchConvert.keepEncoding": "保持目前編碼",
  "batchConvert.lineEndingLabel": "行尾",
  "batchConvert.lineEndingKeep": "保持不變",
  "batchConvert.scanButton": "掃描（僅預覽）",
  "batchConvert.scanning": "掃描中…",
  "batchConvert.noResults": "找不到符合的檔案。",
  "batchConvert.summary": (convertible, alreadyTarget, lossy, undecodable, tooLarge) =>
    `可轉換 ${convertible}、已是目標編碼 ${alreadyTarget}、會遺失資料 ${lossy}、` +
    `無法解碼 ${undecodable}、檔案過大 ${tooLarge}`,
  "batchConvert.statusConvertible": "可轉換",
  "batchConvert.statusAlreadyTarget": "已是目標編碼",
  "batchConvert.statusLossy": "會遺失資料",
  "batchConvert.statusUndecodable": "無法解碼",
  "batchConvert.statusTooLarge": "檔案過大",
  "batchConvert.lineEndingMixed": "混合換行",
  "batchConvert.includeFileLabel": "包含此檔案",
  "batchConvert.convertButton": (count) => `轉換 ${count} 個檔案`,
  "batchConvert.confirmMessage": (count) =>
    `即將就地轉換 ${count} 個檔案？每個檔案將依報告中自動偵測的編碼` +
    `（Detected 欄）重新編碼——請先確認偵測結果。此操作無法復原。`,
  "batchConvert.confirmMessageIncomplete": (count, scanErrorCount) =>
    `即將就地轉換 ${count} 個檔案？另有 ${scanErrorCount} 個項目無法掃描，本報告` +
    `可能未涵蓋所有檔案——請先確認 Detected 欄與掃描錯誤清單。此操作無法復原。`,
  "batchConvert.rescanNeeded": "設定已變更——請重新掃描後再轉換。",
  "batchConvert.converting": "轉換中…",
  "batchConvert.resultSummary": (ok, failed) =>
    failed === 0 ? `已轉換 ${ok} 個檔案。` : `已轉換 ${ok} 個檔案，失敗 ${failed} 個。`,
  "batchConvert.scanErrorsSummary": (count) =>
    `有 ${count} 個項目無法掃描——本報告可能不完整。`,

  "streamReplace.title": (file) => `在大型檔案中取代 — ${file}`,
  "streamReplace.searchPlaceholder": "尋找…",
  "streamReplace.replacePlaceholder": "取代為…",
  "streamReplace.caseInsensitiveHint": "不區分大小寫僅適用於 ASCII 字母。",
  "streamReplace.executeButton": "全部取代",
  "streamReplace.replacing": "取代中…",
  "streamReplace.resultMessage": (count) => `已取代 ${count} 處。`,

  "dialog.pagingTitle": "翻頁",
  "dialog.fileChangedTitle": "檔案已在磁碟上異動",
  "dialog.fileChangedMessage": (title) =>
    `「${title}」已在磁碟上異動，要重新載入並捨棄未儲存的變更嗎？`,
  "dialog.reload": "重新載入",
  "dialog.staleFileMessage": (title) =>
    `「${title}」自開啟後已在磁碟上異動。要覆寫為目前版本、重新載入較新的版本並捨棄未儲存的變更，還是取消這次儲存？`,
  "dialog.overwrite": "覆寫",
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
  "dialog.streamReplaceUseRegularTitle": "在大型檔案中取代",
  "dialog.streamReplaceUseRegularMessage":
    "這不是大型檔案的唯讀預覽。請改用一般的尋找與取代（Cmd/Ctrl+F）。",
  "dialog.lineIndexFailedTitle": "建立行號索引失敗",
  "dialog.bookmarkNeedsGotoTitle": "位置未知",
  "dialog.bookmarkNeedsGotoMessage":
    "目前視窗在檔案中的位置尚未確定。請先用「跳至行號」跳轉一次，再設定書籤。",

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

const ja: Messages = {
  "app.untitled": "無題",
  "app.untitledNumbered": (n) => `無題-${n}`,

  "tabs.closeAria": (title) => `${title} を閉じる`,
  "tabs.newTabAria": "新しいタブ",

  "statusbar.noFile": "ファイルなし",
  "statusbar.cursor": (line, column) => `行 ${line}、列 ${column}`,
  "statusbar.encodingWithBom": (encoding) => `${encoding} BOM`,
  "statusbar.readonlyPreview": (size) => `読み取り専用プレビュー（ファイルサイズ ${size}）`,
  "statusbar.decodeWarning": "⚠ デコードエラーが発生しました",
  "statusbar.buildingIndex": "行番号インデックスを構築中…",
  "statusbar.textStats": (words, chars, lines) => `${words} 語、${chars} 文字、${lines} 行`,
  "statusbar.textStatsSelection": (words, chars, lines) =>
    `選択範囲：${words} 語、${chars} 文字、${lines} 行`,

  "confirm.unsavedChanges": (title) => `「${title}」には保存されていない変更があります。`,
  "confirm.dontSave": "保存しない",
  "confirm.cancel": "キャンセル",
  "confirm.save": "保存",

  "detectcard.reasonBom": "BOM が検出されました",
  "detectcard.reasonExtension": "拡張子ごとの設定により、正常にデコードされました",
  "detectcard.reasonDetector": "chardetng による統計的判定",
  "detectcard.reasonFallback": "分析できる情報がないため（空のファイル）、既定値を使用",
  "detectcard.noBom": "BOM は検出されませんでした",
  "detectcard.title": (encoding) => `なぜ ${encoding} なのか？`,
  "detectcard.labelFile": "ファイル",
  "detectcard.labelBom": "BOM",
  "detectcard.labelVerdict": "chardetng の判定結果",
  "detectcard.labelSampled": "サンプリング範囲",
  "detectcard.labelWouldChoose": "自動検出の場合の選択",
  "detectcard.labelCurrentlyUsing": "現在使用中",
  "detectcard.sampledAll": (size) => `全 ${size}`,
  "detectcard.sampledPartial": (shown, total) => `先頭 ${shown}（全 ${total} 中）`,
  "detectcard.wouldChooseValue": (encoding, reason) => `${encoding}（${reason}）`,
  "detectcard.manualNote": (current, detected) =>
    `現在手動で ${current} を使用しています。自動検出では ${detected} が選択されます。`,

  "hexview.showingAll": (size) => `全 ${size} を表示`,
  "hexview.showingPartial": (shown, total) => `先頭 ${shown} を表示（全 ${total} 中）`,

  "findInFiles.chooseFolder": "フォルダーを選択…",
  "findInFiles.searchPlaceholder": "ファイル内を検索…",
  "findInFiles.matchCase": "大文字と小文字を区別",
  "findInFiles.regex": "正規表現",
  "findInFiles.searching": "検索中…",
  "findInFiles.status": (count, truncated, filesScanned) =>
    `${filesScanned} 個のファイル中 ${count}${truncated ? "+" : ""} 件一致`,

  "goto.placeholder": "行に移動…",

  "quickOpen.searchPlaceholder": "最近使用したファイルを検索…",
  "quickOpen.noRecent": "最近使用したファイルはありません",
  "quickOpen.noMatches": "一致する項目がありません",

  "preferences.title": "環境設定",
  "preferences.editorFont": "エディターフォント",
  "preferences.editorFontPlaceholder": "システム既定",
  "preferences.fontSize": "フォントサイズ",
  "preferences.theme": "テーマ",
  "preferences.language": "言語",
  "preferences.encodingForNewFiles": "新規ファイルのエンコーディング",
  "preferences.extHeading": "拡張子ごとのエンコーディング",
  "preferences.extHint":
    "これらの拡張子のファイルは指定したエンコーディングで開かれます。ただし BOM、" +
    "有効な UTF-8 テキスト、またはバイト不一致が検出された場合はそちらが優先されます。",
  "preferences.extPlaceholder": "txt",
  "preferences.extRemoveTitle": "削除",
  "preferences.extAdd": "追加",
  "preferences.cancel": "キャンセル",
  "preferences.save": "保存",
  "preferences.themeSystem": "システムに従う",
  "preferences.themeLight": "ライト",
  "preferences.themeDark": "ダーク",
  "preferences.themePaper": "紙",
  "preferences.themeDusk": "黄昏",
  "preferences.langSystemOption": "システム既定",

  "menu.whyEncoding": (encoding) => `なぜ ${encoding} なのか？`,
  "menu.reopenWithEncoding": "エンコーディングを指定して再度開く",
  "menu.saveWithEncoding": "エンコーディングを指定して保存",
  "menu.compareEncodings": "エンコーディングを比較…",
  "menu.viewRawBytes": "生バイトを表示…",
  "menu.repairMojibake": "文字化けを修復…",
  "menu.lineEndingLf": "LF（Unix / macOS）",
  "menu.lineEndingCrlf": "CRLF（Windows）",
  "menu.lineEndingCr": "CR（Classic Mac）",

  "mojibake.title": "文字化けを修復",
  "mojibake.noCandidates":
    "修復可能な誤デコードパターンが見つかりませんでした — 文字化けではないようです。",
  "mojibake.pickCandidate": "適用する修復方法を選択してください：",
  "mojibake.candidateDescription": (original, intermediate) =>
    `${original} の内容が誤って ${intermediate} としてデコードされたようです。`,
  "mojibake.replacementCount": (count) => `約 ${count} 文字を変更`,
  "mojibake.before": "修復前",
  "mojibake.after": "修復後",
  "mojibake.appliedTitle": "文字化けを修復しました",
  "mojibake.appliedMessage":
    "エディター内のコンテンツを修復しました。誤っていた場合は元に戻す（Undo）で戻せます。",
  "mojibake.staleContentTitle": "修復は適用されませんでした",
  "mojibake.staleContentMessage":
    "修復の準備中にドキュメントの内容が変更されたため、適用されませんでした（編集内容は保持されています）。「文字化けを修復」を開き直してもう一度お試しください。",

  "comparePreview.title": (file) => `エンコーディングを比較 — ${file}`,
  "comparePreview.encodingALabel": "A",
  "comparePreview.encodingBLabel": "B",
  "comparePreview.compareButton": "比較",
  "comparePreview.malformedBadge": "デコードエラー",
  "comparePreview.reopenButton": "このエンコーディングで再度開く",

  "batchConvert.title": "エンコーディング一括変換",
  "batchConvert.chooseFolder": "フォルダーを選択…",
  "batchConvert.chooseFolderFirst": "先にフォルダーを選択してください。",
  "batchConvert.extPlaceholder":
    "拡張子をカンマ区切りで指定（例: txt,md）— 空欄の場合はすべてのファイルが対象",
  "batchConvert.targetLabel": "変換先エンコーディング",
  "batchConvert.keepEncoding": "現在のエンコーディングを維持",
  "batchConvert.lineEndingLabel": "改行コード",
  "batchConvert.lineEndingKeep": "維持",
  "batchConvert.scanButton": "スキャン（プレビューのみ）",
  "batchConvert.scanning": "スキャン中…",
  "batchConvert.noResults": "一致するファイルが見つかりません。",
  "batchConvert.summary": (convertible, alreadyTarget, lossy, undecodable, tooLarge) =>
    `変換可能 ${convertible} 件、既にこのエンコーディング ${alreadyTarget} 件、` +
    `データ損失あり ${lossy} 件、デコード不可 ${undecodable} 件、サイズ超過 ${tooLarge} 件`,
  "batchConvert.statusConvertible": "変換可能",
  "batchConvert.statusAlreadyTarget": "既にこのエンコーディング",
  "batchConvert.statusLossy": "データ損失あり",
  "batchConvert.statusUndecodable": "デコード不可",
  "batchConvert.statusTooLarge": "サイズ超過",
  "batchConvert.lineEndingMixed": "混在",
  "batchConvert.includeFileLabel": "このファイルを含める",
  "batchConvert.convertButton": (count) => `${count} 件のファイルを変換`,
  "batchConvert.confirmMessage": (count) =>
    `${count} 件のファイルをその場で変換しますか？各ファイルはレポートに表示された` +
    `自動検出エンコーディング（Detected 列）に基づいて再エンコードされます。先に検出結果を` +
    `ご確認ください。この操作は元に戻せません。`,
  "batchConvert.confirmMessageIncomplete": (count, scanErrorCount) =>
    `${count} 件のファイルをその場で変換しますか？${scanErrorCount} 件の項目をスキャンでき` +
    `なかったため、このレポートにはファイルが漏れている可能性があります——先に Detected 列と` +
    `スキャンエラーの一覧をご確認ください。この操作は元に戻せません。`,
  "batchConvert.rescanNeeded": "設定が変更されました — 変換前に再度スキャンしてください。",
  "batchConvert.converting": "変換中…",
  "batchConvert.resultSummary": (ok, failed) =>
    failed === 0
      ? `${ok} 件のファイルを変換しました。`
      : `${ok} 件のファイルを変換しました。${failed} 件失敗。`,
  "batchConvert.scanErrorsSummary": (count) =>
    `${count} 件の項目をスキャンできませんでした — このレポートは不完全な可能性があります。`,

  "streamReplace.title": (file) => `大きいファイル内で置換 — ${file}`,
  "streamReplace.searchPlaceholder": "検索…",
  "streamReplace.replacePlaceholder": "置換後の文字列…",
  "streamReplace.caseInsensitiveHint":
    "大文字・小文字を区別しない照合は ASCII 文字にのみ適用されます。",
  "streamReplace.executeButton": "すべて置換",
  "streamReplace.replacing": "置換中…",
  "streamReplace.resultMessage": (count) => `${count} 件を置換しました。`,

  "dialog.pagingTitle": "ページング",
  "dialog.fileChangedTitle": "ファイルがディスク上で変更されました",
  "dialog.fileChangedMessage": (title) =>
    `「${title}」はディスク上で変更されています。再読み込みして未保存の変更を破棄しますか？`,
  "dialog.reload": "再読み込み",
  "dialog.staleFileMessage": (title) =>
    `「${title}」を開いた後にディスク上で変更されました。現在の内容で上書きするか、` +
    `未保存の変更を破棄して新しいバージョンを再読み込みするか、この保存をキャンセルしてください。`,
  "dialog.overwrite": "上書き",
  "dialog.openFailedTitle": "開くのに失敗しました",
  "dialog.readonlyPreviewTitle": "読み取り専用プレビュー",
  "dialog.readonlyPreviewMessage": (title) =>
    `「${title}」は大きいファイルの読み取り専用プレビューです。保存はできません。`,
  "dialog.saveFailedTitle": "保存に失敗しました",
  "dialog.lossyEncodingTitle": "エンコーディングに関する警告",
  "dialog.lossyEncodingMessage": (encoding) =>
    `一部の文字は ${encoding} で表現できません。このまま保存すると代替文字が書き込まれ、` +
    `元に戻すことはできません。`,
  "dialog.lossyEncodingConfirm": "このまま保存",
  "dialog.backupFailedTitle": "バックアップに失敗しました",
  "dialog.backupFailedMessage": (titles) =>
    `${titles.join("、")} の未保存の変更をバックアップに書き込めませんでした` +
    `（ディスクの空き容量不足か、フォルダーが書き込み不可の可能性があります）。` +
    `今閉じるとこれらの変更は失われます。それでも閉じますか？`,
  "dialog.backupFailedDiscard": "変更を破棄して閉じる",
  "dialog.unsavedChangesTitle": "未保存の変更",
  "dialog.reopenMessage": (title) =>
    `再度開くと「${title}」の未保存の変更が破棄されます。続行しますか？`,
  "dialog.reopen": "再度開く",
  "dialog.reopenFailedTitle": "再度開くのに失敗しました",
  "dialog.printTitle": "印刷",
  "dialog.streamReplaceUseRegularTitle": "大きいファイル内で置換",
  "dialog.streamReplaceUseRegularMessage":
    "これは大きいファイルのプレビューではありません。通常の検索と置換（Cmd/Ctrl+F）を" +
    "ご利用ください。",
  "dialog.lineIndexFailedTitle": "行番号インデックスの作成に失敗しました",
  "dialog.bookmarkNeedsGotoTitle": "位置が不明です",
  "dialog.bookmarkNeedsGotoMessage":
    "このウィンドウのファイル内での位置がまだ確定していません。先に「行に移動」で" +
    "ジャンプしてから、ブックマークを設定してください。",

  "encoding.utf8": "UTF-8",
  "encoding.utf8Bom": "UTF-8（BOM 付き）",
  "encoding.utf16le": "UTF-16 LE",
  "encoding.utf16be": "UTF-16 BE",
  "encoding.big5": "Big5（繁体字中国語）",
  "encoding.gb18030": "GB18030（簡体字中国語）",
  "encoding.gbk": "GBK（簡体字中国語）",
  "encoding.shiftJis": "Shift_JIS（日本語）",
  "encoding.eucJp": "EUC-JP（日本語）",
  "encoding.eucKr": "EUC-KR（韓国語）",
  "encoding.windows1252": "Windows-1252（西欧言語）",

  "common.loading": "読み込み中…",
};

const zhCN: Messages = {
  "app.untitled": "未命名",
  "app.untitledNumbered": (n) => `未命名-${n}`,

  "tabs.closeAria": (title) => `关闭 ${title}`,
  "tabs.newTabAria": "新建标签页",

  "statusbar.noFile": "无文件",
  "statusbar.cursor": (line, column) => `第 ${line} 行，第 ${column} 列`,
  "statusbar.encodingWithBom": (encoding) => `${encoding} BOM`,
  "statusbar.readonlyPreview": (size) => `只读预览（文件大小 ${size}）`,
  "statusbar.decodeWarning": "⚠ 解码时发生错误",
  "statusbar.buildingIndex": "正在构建行号索引…",
  "statusbar.textStats": (words, chars, lines) => `${words} 词、${chars} 字符、${lines} 行`,
  "statusbar.textStatsSelection": (words, chars, lines) =>
    `已选择：${words} 词、${chars} 字符、${lines} 行`,

  "confirm.unsavedChanges": (title) => `“${title}”有未保存的更改。`,
  "confirm.dontSave": "不保存",
  "confirm.cancel": "取消",
  "confirm.save": "保存",

  "detectcard.reasonBom": "检测到 BOM",
  "detectcard.reasonExtension": "根据扩展名偏好设置，解码成功",
  "detectcard.reasonDetector": "chardetng 统计检测",
  "detectcard.reasonFallback": "无可分析的依据（空文件），使用默认值",
  "detectcard.noBom": "未检测到 BOM",
  "detectcard.title": (encoding) => `为什么是 ${encoding}？`,
  "detectcard.labelFile": "文件",
  "detectcard.labelBom": "BOM",
  "detectcard.labelVerdict": "chardetng 判定结果",
  "detectcard.labelSampled": "采样范围",
  "detectcard.labelWouldChoose": "自动检测将选择",
  "detectcard.labelCurrentlyUsing": "目前使用",
  "detectcard.sampledAll": (size) => `全部 ${size}`,
  "detectcard.sampledPartial": (shown, total) => `前 ${shown}（共 ${total}）`,
  "detectcard.wouldChooseValue": (encoding, reason) => `${encoding}（${reason}）`,
  "detectcard.manualNote": (current, detected) =>
    `目前手动使用 ${current}——自动检测将选择 ${detected}。`,

  "hexview.showingAll": (size) => `显示全部 ${size}`,
  "hexview.showingPartial": (shown, total) => `显示前 ${shown}（共 ${total}）`,

  "findInFiles.chooseFolder": "选择文件夹…",
  "findInFiles.searchPlaceholder": "在文件中搜索…",
  "findInFiles.matchCase": "区分大小写",
  "findInFiles.regex": "正则表达式",
  "findInFiles.searching": "搜索中…",
  "findInFiles.status": (count, truncated, filesScanned) =>
    `在 ${filesScanned} 个文件中找到 ${count}${truncated ? "+" : ""} 处匹配`,

  "goto.placeholder": "跳转到行…",

  "quickOpen.searchPlaceholder": "搜索最近的文件…",
  "quickOpen.noRecent": "没有最近的文件",
  "quickOpen.noMatches": "没有匹配项",

  "preferences.title": "首选项",
  "preferences.editorFont": "编辑器字体",
  "preferences.editorFontPlaceholder": "系统默认",
  "preferences.fontSize": "字体大小",
  "preferences.theme": "主题",
  "preferences.language": "语言",
  "preferences.encodingForNewFiles": "新建文件的编码",
  "preferences.extHeading": "按扩展名设置编码",
  "preferences.extHint":
    "符合这些扩展名的文件会以指定编码打开；若检测到 BOM、有效的 UTF-8 文本，" +
    "或字节不匹配，仍会优先采用。",
  "preferences.extPlaceholder": "txt",
  "preferences.extRemoveTitle": "移除",
  "preferences.extAdd": "添加",
  "preferences.cancel": "取消",
  "preferences.save": "保存",
  "preferences.themeSystem": "跟随系统",
  "preferences.themeLight": "浅色",
  "preferences.themeDark": "深色",
  "preferences.themePaper": "纸张",
  "preferences.themeDusk": "黄昏",
  "preferences.langSystemOption": "系统默认",

  "menu.whyEncoding": (encoding) => `为什么是 ${encoding}？`,
  "menu.reopenWithEncoding": "以指定编码重新打开",
  "menu.saveWithEncoding": "以指定编码保存",
  "menu.compareEncodings": "比较编码…",
  "menu.viewRawBytes": "查看原始字节…",
  "menu.repairMojibake": "修复乱码…",
  "menu.lineEndingLf": "LF（Unix / macOS）",
  "menu.lineEndingCrlf": "CRLF（Windows）",
  "menu.lineEndingCr": "CR（Classic Mac）",

  "mojibake.title": "修复乱码",
  "mojibake.noCandidates": "未找到可修复的误解码模式——这看起来不像乱码。",
  "mojibake.pickCandidate": "选择要应用的修复方式：",
  "mojibake.candidateDescription": (original, intermediate) =>
    `看起来是 ${original} 的内容曾被误当作 ${intermediate} 解码。`,
  "mojibake.replacementCount": (count) => `约变更 ${count} 个字符`,
  "mojibake.before": "修复前",
  "mojibake.after": "修复后",
  "mojibake.appliedTitle": "乱码已修复",
  "mojibake.appliedMessage": "编辑器内容已修复，可撤销还原。",
  "mojibake.staleContentTitle": "未应用修复",
  "mojibake.staleContentMessage":
    "修复准备期间文档内容已变更，因此未应用——你的编辑内容已保留。请重新打开「修复乱码」再试一次。",

  "comparePreview.title": (file) => `比较编码 — ${file}`,
  "comparePreview.encodingALabel": "A",
  "comparePreview.encodingBLabel": "B",
  "comparePreview.compareButton": "比较",
  "comparePreview.malformedBadge": "解码错误",
  "comparePreview.reopenButton": "以此编码重新打开",

  "batchConvert.title": "批量转换编码",
  "batchConvert.chooseFolder": "选择文件夹…",
  "batchConvert.chooseFolderFirst": "请先选择文件夹。",
  "batchConvert.extPlaceholder": "扩展名，逗号分隔（如 txt,md）——留空表示所有文件",
  "batchConvert.targetLabel": "目标编码",
  "batchConvert.keepEncoding": "保持当前编码",
  "batchConvert.lineEndingLabel": "换行符",
  "batchConvert.lineEndingKeep": "保持不变",
  "batchConvert.scanButton": "扫描（仅预览）",
  "batchConvert.scanning": "扫描中…",
  "batchConvert.noResults": "未找到匹配的文件。",
  "batchConvert.summary": (convertible, alreadyTarget, lossy, undecodable, tooLarge) =>
    `可转换 ${convertible}、已是目标编码 ${alreadyTarget}、会丢失数据 ${lossy}、` +
    `无法解码 ${undecodable}、文件过大 ${tooLarge}`,
  "batchConvert.statusConvertible": "可转换",
  "batchConvert.statusAlreadyTarget": "已是目标编码",
  "batchConvert.statusLossy": "会丢失数据",
  "batchConvert.statusUndecodable": "无法解码",
  "batchConvert.statusTooLarge": "文件过大",
  "batchConvert.lineEndingMixed": "混合换行",
  "batchConvert.includeFileLabel": "包含此文件",
  "batchConvert.convertButton": (count) => `转换 ${count} 个文件`,
  "batchConvert.confirmMessage": (count) =>
    `即将就地转换 ${count} 个文件？每个文件将依报告中自动检测的编码` +
    `（Detected 列）重新编码——请先确认检测结果。此操作无法撤销。`,
  "batchConvert.confirmMessageIncomplete": (count, scanErrorCount) =>
    `即将就地转换 ${count} 个文件？另有 ${scanErrorCount} 个项目无法扫描，本报告` +
    `可能未涵盖所有文件——请先确认 Detected 列与扫描错误列表。此操作无法撤销。`,
  "batchConvert.rescanNeeded": "设置已更改——请重新扫描后再转换。",
  "batchConvert.converting": "转换中…",
  "batchConvert.resultSummary": (ok, failed) =>
    failed === 0 ? `已转换 ${ok} 个文件。` : `已转换 ${ok} 个文件，失败 ${failed} 个。`,
  "batchConvert.scanErrorsSummary": (count) =>
    `有 ${count} 个项目无法扫描——本报告可能不完整。`,

  "streamReplace.title": (file) => `在大文件中替换 — ${file}`,
  "streamReplace.searchPlaceholder": "查找…",
  "streamReplace.replacePlaceholder": "替换为…",
  "streamReplace.caseInsensitiveHint": "不区分大小写仅适用于 ASCII 字母。",
  "streamReplace.executeButton": "全部替换",
  "streamReplace.replacing": "替换中…",
  "streamReplace.resultMessage": (count) => `已替换 ${count} 处。`,

  "dialog.pagingTitle": "翻页",
  "dialog.fileChangedTitle": "文件已在磁盘上更改",
  "dialog.fileChangedMessage": (title) =>
    `“${title}”已在磁盘上更改，是否重新加载并放弃未保存的更改？`,
  "dialog.reload": "重新加载",
  "dialog.staleFileMessage": (title) =>
    `“${title}”自打开后已在磁盘上更改。要覆盖为当前版本、重新加载较新的版本并放弃未保存的更改，还是取消这次保存？`,
  "dialog.overwrite": "覆盖",
  "dialog.openFailedTitle": "打开失败",
  "dialog.readonlyPreviewTitle": "只读预览",
  "dialog.readonlyPreviewMessage": (title) => `“${title}”是大文件的只读预览，无法保存。`,
  "dialog.saveFailedTitle": "保存失败",
  "dialog.lossyEncodingTitle": "编码警告",
  "dialog.lossyEncodingMessage": (encoding) =>
    `有字符无法以 ${encoding} 表示，继续保存将写入替代字符，且无法撤销。`,
  "dialog.lossyEncodingConfirm": "仍要保存",
  "dialog.backupFailedTitle": "备份写入失败",
  "dialog.backupFailedMessage": (titles) =>
    `${titles.join("、")} 的未保存更改无法写入备份（磁盘已满或文件夹` +
    `无法写入？），现在关闭的话，这些更改将无法保留。仍要关闭？`,
  "dialog.backupFailedDiscard": "放弃更改并关闭",
  "dialog.unsavedChangesTitle": "未保存的更改",
  "dialog.reopenMessage": (title) => `重新打开将放弃“${title}”中未保存的更改，是否继续？`,
  "dialog.reopen": "重新打开",
  "dialog.reopenFailedTitle": "重新打开失败",
  "dialog.printTitle": "打印",
  "dialog.streamReplaceUseRegularTitle": "在大文件中替换",
  "dialog.streamReplaceUseRegularMessage":
    "这不是大文件的只读预览。请改用常规的查找和替换（Cmd/Ctrl+F）。",
  "dialog.lineIndexFailedTitle": "创建行号索引失败",
  "dialog.bookmarkNeedsGotoTitle": "位置未知",
  "dialog.bookmarkNeedsGotoMessage":
    "当前窗口在文件中的位置尚未确定。请先使用“跳转到行”跳转一次，再设置书签。",

  "encoding.utf8": "UTF-8",
  "encoding.utf8Bom": "UTF-8（带 BOM）",
  "encoding.utf16le": "UTF-16 LE",
  "encoding.utf16be": "UTF-16 BE",
  "encoding.big5": "Big5（繁体中文）",
  "encoding.gb18030": "GB18030（简体中文）",
  "encoding.gbk": "GBK（简体中文）",
  "encoding.shiftJis": "Shift_JIS（日文）",
  "encoding.eucJp": "EUC-JP（日文）",
  "encoding.eucKr": "EUC-KR（韩文）",
  "encoding.windows1252": "Windows-1252（西欧语系）",

  "common.loading": "加载中…",
};

const dictionaries: Record<Locale, Messages> = {
  en,
  "zh-TW": zhTW,
  ja,
  "zh-CN": zhCN,
};

/**
 * Resolve a BCP-47 language tag (e.g. `navigator.language`) to a supported
 * `Locale`. "ja"/"ja-*" tags resolve to `ja`. Chinese tags split by script:
 * Traditional-Chinese-bearing tags ("zh-TW", anything containing "Hant",
 * "zh-HK", "zh-MO") resolve to `zh-TW`; Simplified-Chinese-bearing tags
 * ("zh-CN", anything containing "Hans", "zh-SG") resolve to `zh-CN`. A bare
 * "zh" with no script/region hint, and every other language, falls back to
 * English rather than guessing a script.
 */
export function resolveSystemLocale(tag: string | undefined | null): Locale {
  const lang = (tag ?? "").toLowerCase();
  if (lang === "ja" || lang.startsWith("ja-")) return "ja";
  if (!lang.startsWith("zh")) return "en";
  if (lang === "zh-tw" || lang.includes("hant") || lang === "zh-hk" || lang === "zh-mo") {
    return "zh-TW";
  }
  if (lang === "zh-cn" || lang.includes("hans") || lang === "zh-sg") {
    return "zh-CN";
  }
  return "en";
}

/**
 * Resolve a stored language preference ("system" | "en" | "zh-TW" | "ja" |
 * "zh-CN") to an effective `Locale`, following the system locale for
 * "system" or any unrecognized value (forward-compatible default for prefs
 * written by a future build).
 */
export function effectiveLocale(pref: string, systemTag?: string | null): Locale {
  if (pref === "en" || pref === "zh-TW" || pref === "ja" || pref === "zh-CN") return pref;
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

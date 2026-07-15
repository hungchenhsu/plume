# Judgment Overlay — plume（最後查證日期：2026-07-15）

依全域 skill `judgment-rubrics` 的 overlay 規格建立，由 repo 根目錄 CLAUDE.md 正式引用。內容更新時同步上方查證日期；若本檔與 CLAUDE.md 衝突，以 CLAUDE.md 為準並更新本檔。

## 1. 危險域清單（R1 用）

plume 是本機文字編輯器，「使用者檔案的資料完整性」等同其他專案的金流——默默毀損內容是最貴的錯誤：

- 儲存路徑：原子寫入（暫存檔＋rename）、hot exit 的備份/還原邏輯。
- 編碼/換行/BOM 的 decode–encode round-trip；decode error 必須呈現給使用者，絕不默默當正常文字渲染（ARCHITECTURE.md 硬約束）。
- IPC 邊界：所有磁碟 I/O 只在 Rust core，raw bytes 不得跨 IPC（ARCHITECTURE.md 硬約束）。
- large-file mode 的 offset 計算：CM6 的 chars 與檔案 bytes 是兩種單位，絕不可混用（2026-06 開發期真實教訓）。
- Release／tag／發佈：對外動作，一律先問（R3）。

## 2. 驗證指令表（R5 用）

| 變更觸及 | 最低驗證指令 | 真相來源 |
| --- | --- | --- |
| 前端 `src/`（TS） | `npm run build`（tsc strict＋vite）＋ `npm test`（vitest） | CLAUDE.md「Definition of done」 |
| `src-tauri/`（Rust） | `cd src-tauri && cargo test` ＋ `cargo fmt --check && cargo clippy --all-targets -- -D warnings` | CLAUDE.md「Definition of done」 |
| encoding 行為 | 上列 Rust 全套，且必含 round-trip 測試（新增或更新） | CLAUDE.md「Definition of done」#3 |
| 不需 WebView 的前端邏輯（tab store、pure helpers） | 對應 `src/*.test.ts` vitest 單元測試存在且通過 | CLAUDE.md「Definition of done」#3 |
| 任何 PR | 對應 ROADMAP.md checkbox 同 PR 更新 | CLAUDE.md「Definition of done」#4 |

環境細節：fresh clone 先 `npm install && npm run build` 再跑任何 cargo 指令（`tauri::generate_context!` 需要 `dist/` 存在）——cargo 指令莫名失敗時先檢查這個，不是程式碼的錯。

## 3. 檔案權限增補（R6 用）

- Green：`src/`、`src-tauri/` 範圍內 code＋tests（feature branch）；同 PR 勾 ROADMAP.md checkbox；本檔（judgment-overlay.md）的教訓寫回。
- Yellow（先提案）：ARCHITECTURE.md（硬約束文件）；新增任何 runtime dependency（CLAUDE.md 明定需強理由）；DIRECTION.md 的方向性內容（決策關卡、階段計畫——2026-07-08 應使用者要求建立，內含完整策略、情境對策與 session 交接協定；把 §6 backlog 項目升級進 ROADMAP 需使用者簽核）。
- Red：發佈 release／刪 tag；把 repo 轉 public（維持 private 至正式命名定案）；在任何對外文字提及 Notepad++（定位紅線）；「Plume」目前僅為 codename（撞名 joinplu.me），不要寫進對外命名。

## 4. 教訓寫回目標（R7 用）

- repo 專屬 ops 規則／死路 → 本檔對應節。
- 專案狀態交接、個人偏好 → auto-memory 目錄（現有：`plume-session-1-status`、`plume-positioning-constraints`、`gh-pr-checks-watch-race`）。
- 技術債 → plume 無獨立 register，記入 ROADMAP.md 相應區塊。

已知死路（動手前先讀）：

- `encoding_rs::Encoding::new_encoder()` 對 UTF-16LE/BE 回傳的其實是 UTF-8 encoder（`output_encoding()` 規則：UTF-16/replacement 的 output encoding 都是 UTF-8）——任何 streaming encode 路徑對 UTF-16 用它會靜默寫出錯誤 bytes；`streamreplace.rs` 因此顯式拒絕 UTF-16，未來新增 streaming-encode 功能前先查這條（streamreplace.rs 模組註解，2026-07-12）。
- `gh pr checks --watch` 在 PR 剛建立時會誤報通過——先輪詢 check 註冊完成再 watch（memory：gh-pr-checks-watch-race）。
- 選單建構必須在 Tauri `setup()` 內（PathResolver state 順序）；啟動期 panic 要靠啟動煙霧測試抓，CI 一般測試抓不到（memory：plume-session-1-status）。
- GH Actions macOS runner 跑不了需要 WKWebView 實際載入的測試：native setup 正常完成後 WebView 永不開始載入頁面（`on_page_load` Started 不觸發；Aqua session 存在、ad-hoc codesign 無效，root cause 未定；本機鎖屏時同症狀）。startup bench 只能在解鎖的互動桌面本機跑，勿再嘗試 CI 化（PR #38，2026-07-10）。
- 用 Unicode general category 當行為代理（如 `\p{M}` 當「可與前字合成」）會漏非 Mark 的 composition 二元素（Hangul V/T jamo、U+16D67 都是 Lo）——正解是 UAX #15 normalization boundary＋以 runtime 自己的 `normalize` 對 planes 0–2 全分解字元掃描驗證，手挑 fixture 的測試綠燈抓不到（normalize.ts，critic 審查抓到，2026-07-15）。
- Windows 的 `SystemTime` 是 FILETIME（100ns 粒度）：`UNIX_EPOCH ± Duration::new(_, 1)` 這種 1ns 位移在 Windows 靜默截斷、pre-epoch fixture 直接變 epoch——時間類測試 fixture 的次秒位移一律用 100ns 倍數，兩平台皆精確（fsguard EpochOffset 測試，首次真 Windows CI 抓到，2026-07-15）。

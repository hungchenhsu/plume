# Judgment Overlay — plume（最後查證日期：2026-07-07）

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
- Yellow（先提案）：ARCHITECTURE.md（硬約束文件）；新增任何 runtime dependency（CLAUDE.md 明定需強理由）；下一階段 roadmap 的內容（2026-06-13 使用者已決策：暫停開發、先實測，新 roadmap 等回饋後與使用者討論）。
- Red：發佈 release／刪 tag；把 repo 轉 public（維持 private 至正式命名定案）；在任何對外文字提及 Notepad++（定位紅線）；「Plume」目前僅為 codename（撞名 joinplu.me），不要寫進對外命名。

## 4. 教訓寫回目標（R7 用）

- repo 專屬 ops 規則／死路 → 本檔對應節。
- 專案狀態交接、個人偏好 → auto-memory 目錄（現有：`plume-session-1-status`、`plume-positioning-constraints`、`gh-pr-checks-watch-race`）。
- 技術債 → plume 無獨立 register，記入 ROADMAP.md 相應區塊。

已知死路（動手前先讀）：

- `time` crate 釘在 0.3.47：cookie 0.18 對 time 0.3.48 編譯失敗（E0119）。cookie 未修復前不得 `cargo update` 越過（CLAUDE.md「Known pins」）。
- `gh pr checks --watch` 在 PR 剛建立時會誤報通過——先輪詢 check 註冊完成再 watch（memory：gh-pr-checks-watch-race）。
- 選單建構必須在 Tauri `setup()` 內（PathResolver state 順序）；啟動期 panic 要靠啟動煙霧測試抓，CI 一般測試抓不到（memory：plume-session-1-status）。

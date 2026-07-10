# D1 正式名稱查證 — 最終彙整（2026-07-10）

20 個候選 × 5 項查證（軟體撞名 WebSearch、GitHub repo/org、crates.io、npm、
.app/.dev 網域 RDAP）。方法與逐名完整證據見 `naming-batch-A.md`、`naming-batch-B.md`。
網域查證走 Google Registry 官方 RDAP（`pubapi.registry.google/rdap/`，經
已知已註冊網域與亂數字串雙向驗證端點行為）。

## 決策表（依推薦排序）

| 排名 | 名字 | 總評 | 一句話理由 |
|---|---|---|---|
| 1 | **Plumelet** | ✅ clean | 五項全綠（org/crates/npm/.app/.dev 全可用），查無同名軟體；唯一保留＝與 codename「Plume」同詞根，可能被聯想到 joinplu.me（詞根層級風險，非本身撞名） |
| 2 | **Barbule** | ✅ clean | 五項全綠，查無同名軟體；與 Plume 同屬羽毛意象但無詞根重疊 |
| 3 | **Mojiko** | ⚠️ minor | 其餘全綠；.app 於 2026-06-08（一個月前）被搶註、疑投機非產品；「文字＋門司港」意象契合編碼定位 |
| 4 | Serein | ⚠️ minor | 無編輯器撞名；npm（疑廢棄佔位）＋雙網域被佔 |
| 5 | Rachis | ⚠️ minor | 無編輯器撞名；雙網域被佔＋中度知名生資專案同名 |
| — | Kotori | ⚠️ minor（暫定） | 軟體撞名一格 unchecked（子批次未回傳）；npm＋雙網域被佔 |

**Blocked（14 名，證據在批次檔）**：Calamus、Alula、Pinion、Swiftlet、Wren、
Lark、Tern、Sumi（batch A）；Limn、Lucent、Scrivo、Nib、Wisp、Vellum（batch B）。
最嚴重者：Vellum（同賽道現售 macOS 寫作軟體）、Lark（ByteDance 文件編輯器）、
Wren（8k★ 程式語言）。

## 建議

首選 **Barbule**（全綠且無 Plume 詞根聯想）或 **Plumelet**（全綠、延續現有
codename 血緣，但繼承 joinplu.me 聯想風險）。若想要與「文字/編碼」直接呼應的
名字，**Mojiko** 是唯一可行的選項（需接受 .app 被搶註、只用 .dev 或其他 TLD）。

## 使用者決策點

1. 從 shortlist 選名（或全部否決、開新一輪查證）。
2. 選定後：註冊網域（.dev 皆可用）＋ GitHub org ＋ crates/npm 佔位（D2 runbook
   `d2-updater-runbook.md` 有簽章/發佈其餘前置）。

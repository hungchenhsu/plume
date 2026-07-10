# Naming batch B — 查證結果（全部重查，2026-07-10）

前一個查證 agent 中途死亡，其寫入本檔的舊版本內容不可信，已整檔覆寫。本檔為從零
重新查證 10 個候選名的結果。

## 方法論備註（會影響如何解讀下表）

- **GitHub**：一開始無認證 curl 遇到 rate limit（search 10/min、core 60/hr 皆被打滿，
  部分名字回應為 rate-limit 錯誤而非真實查詢結果），改用 `gh api`（已登入帳號
  hungchenhsu，認證後限額更高）重查全部 10 名，結果可信。
- **crates.io**：不帶 User-Agent 的請求會被其 API 存取政策擋下（403 "data access
  policy" 錯誤），改用帶身份的 UA（`plume-naming-research (contact:
  hhsu.business@gmail.com)`）後恢復正常回應。
- **網域 RDAP**：題目建議的端點 `https://www.registry.google/rdap/domain/<name>.app`
  **實際不存在**——連拿它查 `google.dev`（確定已註冊多年）都回 404，證實該路徑本身
  是錯的，並非網域可用。已透過 IANA RDAP bootstrap
  (`https://data.iana.org/rdap/dns.json`) 查出 `.app`/`.dev` 官方 RDAP base 是
  `https://pubapi.registry.google/rdap/`，改用
  `https://pubapi.registry.google/rdap/domain/<name>.app`，並以 `google.dev`（回
  200，已註冊）與一個隨機亂數字串（回 404，未註冊）驗證此端點行為正確後，才對 10
  個候選名做正式查詢。
- 10 名 × 5 項全部查得明確結果（200/404/實際內容），無 unchecked。

---

## 證據表

| 名字 | 軟體撞名 | GitHub | crates.io | npm | .app / .dev | 總評 |
|---|---|---|---|---|---|---|
| **Mojiko** | 無編輯器類撞名。僅為 PS2 節奏遊戲《Mojib-Ribbon》(2003) 中角色/內建歌詞編輯功能之名；另有拼寫相近但不同的 Mojio（車聯網平台）、Moji（語言交友 app）——皆非同名。[Mojib-Ribbon](https://grokipedia.com/page/Mojib-Ribbon) ・ [Mojio](https://www.moj.io/) | org `mojiko` 可用 (404)。repo 搜尋 total=18，最高星 `mojikojs/MojikoJS`（瀏覽器遊戲引擎，5★，無關）；`mojiko/mojiko`（0★，內容不明） | 可用 (404) | 可用 (404) | **.app 已註冊 (200)**，但註冊時間僅 2026-06-08（約一個月前，疑似投機搶註而非實際產品）；.dev 可用 (404) | **minor**（.app 被搶註但查無實際軟體撞名） |
| **Limn** | 多個活躍軟體同名：Wikimedia Limn（GUI 視覺化工具）、tednaleid/limn（心智圖 PWA，已包裝成原生 macOS app）、**Limn Labs Inc**（有上架 app 的 App Store 開發者）、limn.software（商業網站）、Limn（logo 設計工具）。[GitHub](https://github.com/tednaleid/limn) ・ [limn.software](https://limn.software/) ・ [App Store 開發者頁](https://apps.apple.com/us/developer/limn-labs-inc/id1626436011) | org `limn` 可用 (404)；repo 搜尋 total=555，`christolliday/limn`「Experimental cross platform GUI library」405★ | **已註冊 (200)** — "Placeholder for the limn GUI library" | **已註冊 (200)** — "Reactive library for drawing 2D" | **兩者皆已註冊 (200/200)** | **blocked**（crates.io + npm + 雙網域全佔用，且有活躍商業 macOS app 同名） |
| **Lucent** | 無專屬文字編輯器撞名，但撞上重量級歷史品牌 **Lucent Technologies**（AT&T/貝爾實驗室分拆電信巨頭，後併入 Nokia，業界極知名）。另有 Lucent Health（保險 app）、Lucent AI 影片廣告工具、npm 上的 "lucent" 為輕量圖片編輯器。[搜尋結果](https://apps.apple.com/us/app/lucent-health/id6636489090) | org `lucent` 可用 (404)；repo 搜尋 total=990，最高星 `greentfrapp/lucent`（PyTorch 可解釋性庫）661★，無關 | **已註冊 (200)** — 玩具程式語言 | **已註冊 (200)** — "Lightweight Instant Image Editor"（圖片編輯器，貼近「編輯器」定位） | **兩者皆已註冊 (200/200)** | **blocked**（npm/crates/雙網域全佔用 + 知名歷史電信品牌） |
| **Scrivo** | **直接、嚴重撞名**：「Scrivo Pro / Scrivener Companion」是 App Store 上活躍銷售多年的 iOS 寫作 app（Scrivener 的搭配應用，已出到 Scrivo 4），有專屬 Twitter 帳號 @scrivoapp；另有 scrivo.one「手寫筆記轉數位內容」含內建編輯器（Excalidraw/LaTeX/表格）。[Scrivo Pro](https://apps.apple.com/us/app/scrivo-pro-scrivener-writers/id1068691473) ・ [scrivo.one](https://www.scrivo.one/) | org `scrivo` 可用 (404)；repo 搜尋 total=41，`scrivo/highlight.php`（PHP 語法高亮移植）713★（帳號名即 scrivo，非編輯器但知名度高） | 可用 (404) | 可用 (404) | **兩者皆已註冊 (200/200)** | **blocked**（活躍商業寫作 app 直接同名 + 雙網域已佔用） |
| **Nib** | **直接撞名**：`nib-edit/Nib`（GitHub org）是一個以 ProseMirror 打造、官方形容為「a simple, elegant and light-weight **text editor**」的富文本編輯器專案（雖已停止維護）；另外 macOS/NeXT 的 `.nib` 檔案格式（Interface Builder）是蘋果開發圈 30 年老術語，用 Nib 命名 macOS 編輯器容易造成混淆；另有 nib.com.au 大型健康保險公司 app。[Nib text editor](https://nib-edit.github.io/nib/) ・ [Interface Builder .nib](https://en.wikipedia.org/wiki/Interface_Builder) | org `nib` 可用 (404)；repo 搜尋 total=8773，最高星 `stylus/nib`（CSS mixin 庫）1883★ | **已註冊 (200)** — 靜態網站產生器 | **已註冊 (200)** — Stylus CSS mixins | **兩者皆可用 (404/404)** | **blocked**（存在同名「text editor」專案本體 + `.nib` 是 macOS 開發圈重度既有術語，命名混淆風險高，儘管網域可用） |
| **Wisp** | 多個相近撞名：itch.io 上直接名為「wisp - text editor」的作品；Wisp CMS（含富文本編輯器）；**Wisp（macOS 版）**——Softpedia 收錄「一個 macOS 記事小工具，支援 Markdown、單一快捷鍵喚出、極簡介面」，與 Plume 定位高度接近。[itch.io wisp](https://monochroma380.itch.io/wisp-text-editor) ・ [Wisp macOS](https://mac.softpedia.com/get/Word-Processing/SH-Wisp.shtml) | **org `wisp` 已存在 (200)** — "Wireless Identification and Sensing Platform" 學術研究組織；repo 搜尋 total=4277，`gleam-wisp/wisp`（Web 框架）1447★、`wisp-lang/wisp`（Lisp 語言）988★ | **已註冊 (200)** — tmux workspace navigator，2026-07-03 才更新（活躍維護中） | **已註冊 (200)** — Clojure 語法 JS（Gozala/wisp） | **兩者皆已註冊 (200/200)** | **blocked**（org/crates/npm/雙網域全佔用，且有直接的 macOS 輕量寫作 app 同名） |
| **Vellum** | **本批最嚴重撞名**：Vellum（vellum.pub）是行之有年、**目前仍在銷售**的 macOS 電子書排版軟體，內建完整「Text Editor」功能，定價 $199.99，多家出版類媒體撰文評測；另有 **Vellum AI**（vellum.ai）——有資金的 AI 開發平台，npm 上的 "vellum" package（"Install the full Vellum stack locally"）**今天（2026-07-10）才更新**，證實極活躍。與 Plume 同屬「桌面寫作/文字處理軟體」精確賽道。[Vellum 排版軟體](https://vellum.pub/) ・ [Text Editor 功能頁](https://help.vellum.pub/text-editor/) ・ [Vellum AI](https://www.vellum.ai/) | org `vellum` 可用 (404)；repo 搜尋 total=758，`vellum-ai/vellum-assistant` 856★ | **已註冊 (200)** — 個人 wiki app placeholder | **已註冊 (200)** — 今日（2026-07-10）仍在更新 | **兩者皆已註冊 (200/200)** | **blocked**（兩個獨立、活躍、有商業實體的產品同名，其中一個與 Plume 完全同賽道） |
| **Serein** | 無文字編輯器類撞名。多個小型行動 app 同名（心情陪伴、待辦/日記、習慣追蹤、化妝師管理系統），皆非桌面編輯器領域。[搜尋結果](https://apps.apple.com/ng/app/serein-to-do-list-journal/id6758219371) | org `serein` 可用 (404)；repo 搜尋 total=612，最高星為中文滲透測試工具 `W01fh4cker/Serein` 1252★，與編輯器無關 | 可用 (404) | **已註冊 (200)** — 無描述、2022 年後未更新，疑似廢棄佔位 package | **兩者皆已註冊 (200/200)** | **minor**（無直接編輯器撞名，但 npm + 雙網域已被佔用） |
| **Plumelet** | 查無任何同名軟體。搜尋僅命中「Plume」品牌本體的不相關產品（Plume WiFi mesh 路由器公司、Plume Labs 空氣品質 app、Plume Creator 小說寫作工具、PLUME 文件產生器 app），皆非「Plumelet」本身。[搜尋結果](https://sourceforge.net/projects/plume-creator/) — 備註：Plumelet 與專案既有 codename「Plume」共享詞根，語音/視覺上仍可能被聯想到 Plume 既有撞名（joinplu.me，見專案記憶 plume-positioning-constraints），但這是詞根層級風險，非 Plumelet 本身撞名 | org `plumelet` 可用 (404)；repo 搜尋 total=29，全數 0★ 或極低星（`paolomococci/PlumeletPHP` 0★ 等），皆無關 | 可用 (404) | 可用 (404) | **兩者皆可用 (404/404)** | **clean** |
| **Rachis** | 無文字編輯器類撞名。多家小型/區域性公司使用此名：Rachis System（rachis.co，AI 解決方案）、Rachis Systems（研究培訓）、myrachis.com（企業/行動應用開發商）、Rachis Clinic（健身 app）、SourceForge 上的舊專案「Rachis」（跨平台階層識別系統，已停滯）。[rachis.co](https://www.rachis.co/) ・ [SourceForge](https://rachis.sourceforge.net/) | org `rachis` 可用 (404)；repo 搜尋 total=59，`rachis-org/rachis`（生物資訊學框架，前身 QIIME2 Framework）527★，具一定知名度但領域不同 | 可用 (404) | 可用 (404) | **兩者皆已註冊 (200/200)** | **minor**（無編輯器撞名，但多產業小型公司同名 + 雙網域已佔用 + 有一定知名度的開源生物資訊專案同名） |

---

## 總評摘要（10 名一行版）

- **Mojiko** — minor：.app 網域一個月前才被搶註（疑似投機），其餘全乾淨，無軟體撞名。
- **Limn** — blocked：crates.io / npm / .app / .dev 全部已被佔用，且有活躍商業 macOS app 同名。
- **Lucent** — blocked：npm / crates.io / 雙網域全佔用，且撞上知名歷史電信品牌 Lucent Technologies。
- **Scrivo** — blocked：與活躍銷售中的 iOS 寫作 app「Scrivo Pro」直接同名，雙網域已佔用。
- **Nib** — blocked：GitHub 上已有名為「Nib」的 text editor 專案，且 `.nib` 是 macOS 開發圈重度既有術語。
- **Wisp** — blocked：GitHub org 已被學術機構佔用，npm/crates/雙網域全占用，且有同定位的 macOS 輕量寫作 app 同名。
- **Vellum** — blocked：本批最嚴重，撞上仍在銷售、同賽道（macOS 桌面寫作軟體）的知名商業產品 Vellum。
- **Serein** — minor：無編輯器類撞名，但 npm 與雙網域已被佔用。
- **Plumelet** — clean：五項全部乾淨，本批唯一無保留的候選。
- **Rachis** — minor：無編輯器撞名，但雙網域已佔用，且有多家小公司與一個中度知名開源專案同名。

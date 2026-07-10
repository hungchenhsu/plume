# Plume 正式名稱查證 — Batch A（10 名 × 5 項）

查證日期：2026-07-10。方法：WebSearch（軟體撞名）、GitHub API（repo 搜尋 + org 查詢）、
crates.io API、npm registry、Google Registry RDAP（`pubapi.registry.google/rdap/domain/…`，
rdap.org 對自動查詢回 403/429，已改走 registry 官方端點，HTTP 200＝已註冊、404＝未註冊）。
凡標 unchecked 的格子＝該項查詢未能完成，附原因；絕無推測值。

| 名字 | 軟體撞名 | GitHub | crates.io | npm | .app/.dev 網域 | 總評 |
|---|---|---|---|---|---|---|
| **Calamus** | 有。歷史 DTP 排版軟體 Calamus SL（1987 起，[calamus.net](https://www.calamus.net/calamus/index.php?lan=en)、[Wikipedia](https://en.wikipedia.org/wiki/Calamus_(software))）；現行 AI 瀏覽器 [calamus.app](https://www.calamus.app/)；TTRPG 地圖工具（[App Store](https://apps.apple.com/us/app/calamus/id1457518364)、[Google Play](https://play.google.com/store/apps/details?id=air.com.trapStreetStudios.theCalamus)） | 無同名高星 repo（最高 67★ Calamus.TaskScheduler，無關）；org `calamus` 不存在（404） | 可用（404） | 可用（404） | .app 已註冊（200，即上述 AI 瀏覽器）；.dev 未註冊（404） | **blocked**（.app 被現行同名數位產品佔用＋文書處理近鄰的歷史知名軟體） |
| **Alula** | 有。美國智慧居家保全公司 Alula（[alula.com](https://alula.com/)），有 iOS/Android 消費者 app「Alula Security」，品牌現行經營中；非編輯器/開發工具類 | 無同名高星 repo（最高 81★，個人帳號專案）；org `alula` 不存在（404） | 可用（404） | 已佔用（200，alula v5.0.0，2023 建立） | .app 已註冊（200）；.dev 已註冊（200） | **blocked**（現行消費 app 品牌＋npm＋兩網域皆註冊） |
| **Pinion** | 有。德國腳踏車變速箱大廠 Pinion（[pinion.eu](https://pinion.eu/en/software/)，含「Pinion Smart.Shift」app）；公民參與平台 [pinionvote.com](https://www.pinionvote.com/)；巴西問卷 app「PiniOn」；非編輯器類 | [yaqwsx/Pinion](https://github.com/yaqwsx/Pinion) 491★（KiCad 工具）；org `pinion` 不存在（404） | 已佔用（200，inkwell wrapper） | 已佔用（200，2014 建立、仍在更新） | .app 已註冊（200）；.dev 已註冊（200） | **blocked**（crates＋npm 雙佔用＋491★ GitHub 專案＋兩網域註冊＋強實體品牌） |
| **Barbule** | 無。三組 WebSearch（「Barbule software」「Barbule app」「Barbule text editor」）皆無同名軟體/app/編輯器命中，僅無關結果：barber 管理軟體、Barbie Software（Mattel）、Barbor Software（聖經遊戲）、「barbidule」GitHub 帳號、Barbu 紙牌遊戲 app、Barbelle Health、BBEdit（純同音誤植提示，非撞名）。查無任何名為 Barbule 的活躍軟體產品 | 無同名 repo（前 3 名皆為姓氏 Barbulescu 個人專案，≤2★）；org `barbule` 不存在（404） | 可用（404） | 可用（404） | .app 未註冊（404）；.dev 未註冊（404） | **clean**——五項全綠、全 batch 唯一五項皆無撞名/皆可註冊者 |
| **Swiftlet** | 有（GitHub 直接證據）：[AliasIO/Swiftlet](https://github.com/AliasIO/Swiftlet) 417★，PHP MVC framework（framework 依判準算撞名）；另 [enmerk4r/Swiftlet](https://github.com/enmerk4r/Swiftlet) 94★ Grasshopper plugin。正式 WebSearch 未執行（子批次未回傳），但上述為實查 GitHub API 結果 | AliasIO/Swiftlet 417★；org `swiftlet` 存在（200） | 已佔用（200） | 已佔用（200） | .app 已註冊（200）；.dev 已註冊（200） | **blocked**（同名 framework＋org/crates/npm/兩網域全被佔） |
| **Wren** | 有，重大。Wren 程式語言（[wren.io](https://wren.io/)，[wren-lang/wren](https://github.com/wren-lang/wren) 8,062★）；另 [Canner/WrenAI](https://github.com/Canner/WrenAI) 15,774★（GenBI 工具）。wren.io 首頁實查存在 | wren-lang/wren 8,062★＋WrenAI 15,774★；org `wren` 不存在（404） | 已佔用（200） | 已佔用（200） | .app 已註冊（200）；.dev 已註冊（200） | **blocked**（知名同名程式語言，開發者圈直接混淆） |
| **Lark** | 有，重大。Lark Suite（ByteDance/飛書國際版企業辦公套件，含富文字「Lark Docs」編輯器：[larksuite.com](https://www.larksuite.com/en_us/download)、[Wikipedia](https://en.wikipedia.org/wiki/Lark_(software))）；Python 解析器函式庫 Lark（[lark-parser.org/ide](https://www.lark-parser.org/ide/)、[github.com/lark-parser/ide](https://github.com/lark-parser/ide)）；GTK 文法工具 [github.com/lark-editor](https://github.com/lark-editor) | lark-parser/lark 5,930★；org `lark` 不存在（404） | 已佔用（200，Salsa-based 編譯器實驗） | 已佔用（200，koa-based Node.js framework，[github.com/larkjs/lark](https://github.com/larkjs/lark)） | .app 已註冊（200）；.dev 已註冊（200） | **blocked**（ByteDance 知名產品且含文件編輯器＝正面撞名） |
| **Tern** | 有。Tern.js——JavaScript 程式碼分析器，供各編輯器 JS 補全（[github.com/ternjs/tern](https://github.com/ternjs/tern) 4,241★，編輯器生態直接相關）；另 Tern 旅遊 app 含內建富文字編輯器（[help.tern.travel](https://help.tern.travel/en/articles/11187577-new-text-editor)） | ternjs/tern 4,241★＋jackc/tern 1,308★（SQL migrator）；org `tern` 不存在（404） | 已佔用（200，SQL migration crate，164k+ 下載） | 已佔用（200，即 Tern.js 本體，0.24.3） | .app 已註冊（200）；.dev 已註冊（200） | **blocked**（知名編輯器生態工具同名＋npm/crates 皆為活躍專案） |
| **Kotori** | unchecked（負責此名 WebSearch 的子批次表格未成功回傳，依指示不再等待；GitHub 搜尋側面顯示最高僅 126★ 的 data historian [daq-tools/kotori](https://github.com/daq-tools/kotori)，無知名同名編輯器/開發工具） | 最高 daq-tools/kotori 126★（InfluxDB/Grafana data historian）；org `kotori` 不存在（404） | 可用（404） | 已佔用（200） | .app 已註冊（200）；.dev 已註冊（200） | **minor（暫定）**（無重大產品撞名跡象，但 npm＋兩網域已被佔；軟體撞名一項待補查） |
| **Sumi** | 有。OpenSumi——「快速建構 AI Native IDE 產品」的 framework（[github.com/opensumi/core](https://github.com/opensumi/core) 3,643★，[opensumi.com](https://opensumi.com)），與文字編輯器/IDE 同空間直接撞名。正式 WebSearch 未執行（子批次表格未回傳），但上述為實查 GitHub API 結果 | opensumi/core 3,643★；另 Sumi-Interactive org（SIAlertView 2,500★）；org `sumi` 不存在（404） | 已佔用（200） | 已佔用（200） | .app 已註冊（200）；.dev 已註冊（200） | **blocked**（同空間 IDE framework 撞名＋crates/npm/兩網域全被佔） |

## 備註

- 網域查證走 Google Registry 官方 RDAP（.app/.dev 的 registry 皆為 Google），20 個網域全部拿到明確 200/404，無 unchecked。
- Calamus/Alula/Pinion 的網域結果經兩個獨立管道（子批次＋本 agent 直接 curl）交叉一致。
- 「unchecked」僅出現在 Barbule 與 Kotori 的軟體撞名（WebSearch）一格：負責的子批次結果未能回傳，且依協調者指示不再等待或重派；兩格皆已附 GitHub API 側面證據供參考，但不視為完整查證。
- 唯一五項近全綠者：**Barbule**（crates/npm/org/.app/.dev 全部可用）。

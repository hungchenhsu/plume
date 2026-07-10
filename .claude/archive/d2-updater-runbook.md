# Plume — Tauri v2 Updater 金鑰與設定 Runbook

狀態：僅為未來導入 auto-update 做準備的**步驟文件**。本文件本身不執行任何金鑰生成、不改動任何 repo 檔案、不設定任何 GitHub secret。所有帶「使用者需要做」標籤的步驟都需要 repo 擁有者本人操作。

查證範圍：所有指令、旗標、設定鍵名、環境變數名稱，均對照 Tauri v2 官方文件（v2.tauri.app）與 `tauri-apps/tauri` / `tauri-apps/tauri-action` 原始碼（dev branch）逐一核對，來源列在每節末尾。查不到的細節已明確標「未確認」，不得憑記憶補完。

---

## 0. 名詞與前提

- Plume 目前**尚未**接上 updater plugin（`src-tauri/Cargo.toml` 未列 `tauri-plugin-updater`；`tauri.conf.json` 的 `plugins` 區塊目前不存在）。本 runbook 描述的是「將來要做這件事時」的完整步驟，現在不需要動任何程式碼。
- release pipeline 現況：`.github/workflows/release.yml` 用 `tauri-apps/tauri-action@v0`，tag `v*` 觸發，產出 6 個安裝檔到 **draft** release（不會自動 publish）。官方最新文件範例用的是 `tauri-apps/tauri-action@v1`——差異見第 4 節備註。

---

## 1. 金鑰生成

**確切指令**（於 repo 根目錄執行；npm 專案用此變體）：

```sh
npm run tauri signer generate -- -w ~/.tauri/myapp.key
```

（yarn/pnpm/deno/bun/cargo 各有對應語法，官方文件同一段落列出全部變體。）

**旗標**（來源：`tauri-apps/tauri` 原始碼 `crates/tauri-cli/src/signer/generate.rs`，dev branch）：

| 旗標 | 說明 |
| --- | --- |
| `-p, --password <PASSWORD>` | 設定私鑰密碼 |
| `-w, --write-keys <PATH>` | 把私鑰寫入檔案（強烈建議用，否則金鑰只印在 terminal） |
| `-f, --force` | 該路徑已有金鑰時強制覆寫 |
| `--ci` | 略過互動式提示（`env: CI=true` 時自動生效）；若同時未給 `-p`，CLI 會印警告：「Generating new private key without password. For security reasons, we recommend setting a password instead.」 |

**輸出物**（確切檔名規則，來源：`crates/tauri-cli/src/helpers/updater_signature.rs::save_keypair`）：

- 私鑰：`-w` 指定的路徑本身，例如 `~/.tauri/myapp.key`（**絕對保密**）。
- 公鑰：同路徑 + `.pub` 後綴，自動產生，例如 `~/.tauri/myapp.key.pub`（可公開分享，會填進 `tauri.conf.json`）。
- 若不加 `-w`：私鑰與公鑰內容直接印在 terminal，不落地成檔案（`generate.rs` 的 else 分支）。CLI 執行完會印出：

  ```
  Environment variables used to sign:
  - `TAURI_SIGNING_PRIVATE_KEY`: String of your private key
  - `TAURI_SIGNING_PRIVATE_KEY_PATH`: Path to your private key file
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`:  Your private key password (optional if key has no password)

  ATTENTION: If you lose your private key OR password, you'll not be able to sign your update package and updates will not work
  ```

  這段警語是 CLI 官方原文，直接印證第 2 節「私鑰遺失 = 所有已安裝副本永遠無法更新」的說法。

**建議存放位置**：`-w ~/.tauri/<app>.key`（家目錄下 `.tauri/` 是官方文件範例路徑，不在 repo 內、不會被 git 追蹤）。

**使用者需要做**：實際執行上述指令、設定私鑰密碼、確認 `~/.tauri/` 目錄權限（建議 `chmod 700`，本文件僅建議，非官方文件強制規定——**未確認**官方是否有明文權限建議）。

來源：
- https://v2.tauri.app/plugin/updater/#signing-updates
- https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/src/signer/generate.rs
- https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/src/helpers/updater_signature.rs

---

## 2. 私鑰保管

### 2.1 環境變數名稱（build 時讀取，官方文件逐字稿）

> While building your update artifacts, you need to have the private key you generated above in your environment variables. `.env` files do *not* work!

- `TAURI_SIGNING_PRIVATE_KEY` — 私鑰的**路徑或內容**（"Path or content of your private key"）。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — 選填，私鑰密碼。

CLI 原始碼另外多印出一個第三變數 `TAURI_SIGNING_PRIVATE_KEY_PATH`（私鑰檔案路徑），但**官方 updater plugin 文件頁只示範 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 這兩個**（本機 export 私鑰內容或路徑皆可用同一個變數名 `TAURI_SIGNING_PRIVATE_KEY`）。CI 上通常放「私鑰檔案內容」而非路徑，因為 GitHub Actions runner 上沒有你本機的檔案。

macOS/Linux 本機測試簽章：

```sh
export TAURI_SIGNING_PRIVATE_KEY="Path or content of your private key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

Windows PowerShell：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY="Path or content of your private key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

### 2.2 GitHub Actions secrets 設定

**未確認**：官方 updater plugin 文件頁、`distribute/pipelines/github` 頁、以及 `tauri-apps/tauri-action` repo 的四份官方 example workflow（`publish-to-auto-release.yml`、`publish-to-manual-release.yml`、`publish-to-auto-release-universal-macos-app-with-signing-certificate.yml`、`test-build-only.yml`）**都沒有**任何一份把 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 接到 `env:` 區塊、示範對應的 `secrets.*` 命名的 verbatim 範例——這點已對照原始碼與四份 example 逐一確認，不是漏查。

可確定的官方慣例（同頁其他 secrets 都是這樣接，例如 `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`、`APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}`）：**GitHub repo secret 名稱與 CI 環境變數名稱慣例上取相同字串**。据此類推（非官方逐字範例，是依同頁其他 secrets 的一致寫法推導）：

```yaml
- uses: tauri-apps/tauri-action@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  with:
    ...
```

**使用者需要做**：
1. `TAURI_SIGNING_PRIVATE_KEY` secret 內容 = `~/.tauri/<app>.key` 檔案**全文**（`cat` 出來直接貼，不必額外 base64——官方文件寫的是「path or content」，未提及需要 base64 編碼；**未確認**是否有編碼上的邊界情況，正式導入時建議先在本機 `tauri build` 用同一組環境變數跑一次驗證 CI 前）。
2. 到 repo（`hungchenhsu/plume`）Settings → Secrets and variables → Actions → New repository secret，建立上述兩個 secret。
3. **離線備份要求**：私鑰檔案（`~/.tauri/<app>.key`）與密碼需額外備份到 GitHub secrets 之外的地方（例如密碼管理器、離線加密硬碟）。**私鑰遺失＝所有已安裝副本永遠無法再收到更新**——這是 Tauri CLI 官方警語原文的直接後果（見第 1 節 ATTENTION 訊息），沒有救援機制、沒有「找 Tauri 官方重發」這回事。

來源：
- https://v2.tauri.app/plugin/updater/#building
- https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/distribute/Pipelines/github.mdx
- https://raw.githubusercontent.com/tauri-apps/tauri-action/dev/examples/publish-to-auto-release.yml（等四份 example，逐一確認未出現 TAURI_SIGNING_* ）

---

## 3. `tauri.conf.json` 變更

官方文件給的完整區塊（逐字，來源見下）：

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "CONTENT FROM PUBLICKEY.PEM",
      "endpoints": [
        "https://releases.myapp.com/{{target}}/{{arch}}/{{current_version}}",
        "https://github.com/user/repo/releases/latest/download/latest.json"
      ]
    }
  }
}
```

鍵名說明（官方表格逐字）：

| 鍵 | 說明 |
| --- | --- |
| `bundle.createUpdaterArtifacts` | 設 `true` 才會讓 bundler 產生 updater 用的簽章產物；文件註明「This setting will be removed in v3」，遷移自 v1 的專案才用 `"v1Compatible"`。 |
| `plugins.updater.pubkey` | 上一節產生的**公鑰內容本身**（`.pub` 檔全文），**不可是檔案路徑**（官方文件原文加粗強調 cannot be a file path）。 |
| `plugins.updater.endpoints` | endpoint URL 字串陣列；production mode 強制 TLS；依序嘗試，非 2XX 才換下一個。 |
| `plugins.updater.dangerousInsecureTransportProtocol` | 選填，設 `true` 才允許非 HTTPS endpoint——本專案不需要，Plume 用 GitHub Releases。 |

**GitHub Releases 的 `latest.json` endpoint 寫法**（官方文件同一區塊內給的範例，直接可用於 Plume 這種 private repo → 之後若要用 auto-update 需注意 private repo 的 asset 存取權限，官方文件未特別著墨——**未確認** private repo 情境下這個 URL 是否需要額外認證，post-alpha 決定 repo 是否轉 public 時要重新檢查）：

```
https://github.com/user/repo/releases/latest/download/latest.json
```

代入 Plume 的話會是 `https://github.com/hungchenhsu/plume/releases/latest/download/latest.json`。這個 `latest.json` 檔案由 `tauri-action` 自動產生上傳（見官方文件「Tauri Action generates a static JSON file for you」），**不需要手動寫**。

動態變數（可用於自架 endpoint，GitHub Releases 靜態 JSON 場景通常不需要）：`{{current_version}}`、`{{target}}`（`linux`/`windows`/`darwin`）、`{{arch}}`（`x86_64`/`i686`/`aarch64`/`armv7`）。

**使用者需要做**：正式導入時，把 `plugins.updater.pubkey` 的值換成第 1 節產生的 `.pub` 檔內容；`endpoints` 陣列填 Plume 的 GitHub Releases `latest.json` URL。

**agent 可自主做**：在此之前，把 `bundle.createUpdaterArtifacts` 及 `plugins.updater` 區塊寫進 `tauri.conf.json`（走 feature branch + PR，依 CLAUDE.md workflow），但 `pubkey` 欄位必須等使用者提供第 1 節產生的公鑰內容才能真正填值——不得先放空字串上 CI 當佔位符後忘記換回。

來源：
- https://v2.tauri.app/plugin/updater/#tauri-configuration
- https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/plugin/updater.mdx

---

## 4. Release workflow 需要的變更（概述）

現況 `.github/workflows/release.yml`（節錄）：

```yaml
- uses: tauri-apps/tauri-action@v0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    tagName: ${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || '' }}
    releaseName: Plume ${{ github.ref_name }}
    releaseDraft: true
    prerelease: true
    args: ${{ matrix.args }}
```

要接上 updater 簽章，`env:` 區塊需要新增（依第 2.2 節）：

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

其餘（tagName/releaseDraft/args 等 `with:` 參數）不受影響，`tauri-action` 會在偵測到這兩個簽章環境變數存在時自動對 build 出來的產物簽章、並在 release 產物中一併附上 `.sig` 檔與彙整的 `latest.json`。

**備註（非官方文件內容，實測前不確定，標「未確認」）**：
- Plume 目前釘的是 `tauri-apps/tauri-action@v0`，官方 2026 年文件範例已全面改用 `@v1`。**未確認** `@v0` 是否完整支援目前的簽章環境變數行為與 `latest.json` 產出格式；正式導入 updater 前建議連同這次一起評估升到 `@v1`（屬於 workflow 檔變更，依 CLAUDE.md 走 feature branch + PR，不算 Red 危險域，但建議連同 updater 這個功能一起提案，不要靜默升版本）。
- macOS 產物在啟用 updater 簽章前，若沒有 Apple Developer 簽章/notarization，`.app.tar.gz` 仍可用 Tauri 私鑰簽章（updater 的簽章跟 Apple 的程式碼簽章是兩件事，互相獨立）；本 runbook 只涵蓋 updater 簽章，不涵蓋 macOS/Windows 平台簽章憑證——那是另一個獨立主題（官方文件另有 `/distribute/sign/macos/`、`/distribute/sign/windows/` 頁面）。

來源：
- https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/distribute/Pipelines/github.mdx
- `/Users/alstonhsu/Desktop/GitHub/plume/.github/workflows/release.yml`（repo 現況）

---

## 5. 之後 auto-update 功能實作時的 UX 約束（既定決策，寫給未來實作者）

這幾條是產品面既定決策，不是本次查證的技術文件內容，記在這裡是為了讓未來實作 auto-update 功能的人（可能是未來的 agent session）不用重新問一次：

- **檢查時機**：啟動時自動檢查一次是否有新版本（呼叫官方 JS API `check()`，來源 https://v2.tauri.app/plugin/updater/#checking-for-updates）。
- **手動觸發**：選單需有「Check for Updates」項，讓使用者隨時手動觸發檢查。
- **絕不**：未經使用者同意自動安裝更新。官方 API `update.downloadAndInstall()` 技術上可以無感執行，但 Plume 的決策是——找到更新後必須先呈現給使用者確認（版本號、更新說明），使用者按下「安裝並重啟」之後才能呼叫 `download_and_install` / `downloadAndInstall`。這是產品決策，Tauri 官方 API 本身不強制這個流程，需要在 Plume 自己的程式碼裡把「發現更新」和「安裝更新」這兩步驟拆開、中間插入使用者確認 UI。

**未確認**：这一節沒有對應官方文件連結可查證——因為這是 Plume 自己的產品決策，不是 Tauri 官方規範。列在此處純粹是把既有決策寫下來，不代表官方文件有相同要求。

---

## 6. 檢核清單

### 使用者需要做（agent 不可代勞）

- [ ] 實際執行 `npm run tauri signer generate -- -w ~/.tauri/plume.key`，設定私鑰密碼
- [ ] 確認 `~/.tauri/plume.key`（私鑰）與密碼已備份到 GitHub secrets 以外的地方（密碼管理器 / 離線加密媒介），並確實理解「私鑰遺失 = 所有已安裝副本永遠無法更新」
- [ ] 到 GitHub repo Settings → Secrets and variables → Actions，建立 `TAURI_SIGNING_PRIVATE_KEY`（貼私鑰檔案全文）與 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（貼密碼）兩個 repository secret
- [ ] 把 `~/.tauri/plume.key.pub` 的內容提供給後續要修改 `tauri.conf.json` 的 agent/自己（`pubkey` 欄位要填這個）
- [ ] 決定是否連同這次一起把 `tauri-apps/tauri-action` 從 `@v0` 升到 `@v1`（第 4 節備註）
- [ ] 決定要不要在正式導入 updater 前，先在本機用相同環境變數跑一次 `npm run tauri build` 驗證簽章流程，再推上 CI

### agent 可自主做（走 feature branch + PR，依 CLAUDE.md workflow；不需事前徵詢但仍需 PR review）

- [ ] 在 `src-tauri/Cargo.toml` 加 `tauri-plugin-updater` 依賴（依官方 Setup 步驟，目標平台限定 `cfg(any(target_os = "macos", windows, target_os = "linux"))`）
- [ ] `lib.rs` 加 `app.handle().plugin(tauri_plugin_updater::Builder::new().build())`
- [ ] 前端加 `@tauri-apps/plugin-updater` 套件
- [ ] `tauri.conf.json` 加 `bundle.createUpdaterArtifacts: true` 與 `plugins.updater` 區塊（`pubkey` 留待使用者提供公鑰內容才能填值，不得放空字串佔位後忘記替換）
- [ ] `.github/workflows/release.yml` 的 `tauri-action` step `env:` 加上 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（引用 `secrets.*`，前提是使用者已完成上面的 secret 設定）
- [ ] 實作「啟動時檢查＋選單 Check for Updates＋使用者確認後才安裝」的前端流程（第 5 節約束）
- [ ] 對應 ROADMAP.md checkbox 同 PR 更新（CLAUDE.md Definition of done #4）

---

## 未確認項清單（彙整）

1. `~/.tauri/` 目錄權限（`chmod 700`）— 非官方文件強制規定，僅為常識性建議。
2. `TAURI_SIGNING_PRIVATE_KEY` 這個 GitHub secret 的**命名慣例**（secret 名 = 環境變數名）——依同頁其他 secrets 的一致寫法推導，官方文件與 `tauri-action` 四份 example workflow 都沒有 updater 簽章的 verbatim 範例可直接引用。
3. 私鑰內容貼進 GitHub secret 是否需要額外編碼（例如 base64）——官方文件只說「path or content」，未提編碼細節。
4. GitHub Releases 的 `latest.json` endpoint 在 **private repo** 情境下是否需要額外認證才能被已安裝的 app 存取——官方範例未區分 public/private repo。Plume repo 目前是 private（judgment-overlay.md Red：正式命名定案前不轉 public）。
5. `tauri-apps/tauri-action@v0`（Plume 現況）是否完整支援本文件描述的簽章環境變數與 `latest.json` 產出行為——官方最新範例都已是 `@v1`，未針對 `@v0` 查證。

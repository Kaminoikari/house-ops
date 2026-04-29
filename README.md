# house-ops

台灣看房 AI 管線，建構於 Claude Code 之上。自動化物件發掘、評估與追蹤，涵蓋租屋與購屋市場的完整搜尋流程。

支援三種使用者類型：**租屋族**、**首購族**、**換屋族**。

---

## Demo

**每日日報** — 591 上架物件、價格變動、已下架條目；瀏覽器中可排序篩選

![日報](docs/images/daily-report.png)

**個別物件評估報告** — 五維度評分、基本資訊、屋況介紹、必要設備檢查

![個別物件評估報告](docs/images/listing-report.png)

---

## 功能概覽

### 自動化（腳本層，可獨立執行）

- **掃描 591** 上架物件並依 `config/profile.yml` 條件初篩（`scan-591.mjs`）
- **評估** 從 591 頁面擷取資料後，以五維度啟發式評分（`eval-591.mjs`）：
  - 價格合理性（依單坪租金門檻判斷）
  - 空間與格局（坪數 + 房廳數）
  - 區域生活機能（頁面文字含「捷運」「學區」「市場」等關鍵字加分）
  - 物件條件（電梯、陽台、總樓層、裝潢字樣）
  - 風險與潛力（社宅、deal-breaker 命中、建物類型）
- **追蹤** `data/tracker.md` 結構化表格，搭配 `merge-tracker.mjs` / `dedup-tracker.mjs` / `verify-pipeline.mjs`
- **每日排程** launchd 觸發 `run-daily.mjs`：scan + eval + 寫日報 (md + html) + email 通知

### 互動式 Mode（Claude Code 會話中觸發）

下列 mode 為 Claude prompt 設計，需在 Claude Code 會話中以指令呼叫；非自動化腳本：

- **可負擔房價試算** — `affordability`（`modes/afford.md`，首購族）
- **換屋財務規劃** — `upgrade plan`（`modes/switch.md`，換屋族）
- **看屋清單與議價策略** — `prepare visit for {###}`（`modes/visit.md`）
- **物件比較** — `compare 001, 003`（`modes/compare.md`）
- **批次處理 pipeline** — `pipeline`（`modes/pipeline.md`）

---

## 事前準備

掃描（`scan`）與物件上架驗證依賴 `agent-browser`，**使用前必須安裝**：

```bash
npm install -g agent-browser
```

確認安裝成功：

```bash
agent-browser --version
```

> 未安裝的情況下執行 `scan` 或貼上 URL，Claude 將無法爬取真實頁面內容，後續評估結果不可信。

---

## 快速開始

1. 安裝 `agent-browser`（見上方）
2. Clone 此 repo 並在 Claude Code 中開啟
3. Claude 會自動偵測缺少的設定檔，啟動初始設定流程
4. 設定完成後，貼上任何物件 URL 即可評估——或輸入 `scan` 搜尋目標區域

---

## 用法

| 輸入 | 動作 |
|------|------|
| 貼上物件 URL | 自動判斷租屋 / 買屋 → 評估 → 產生報告 |
| `scan` | 在目標區域掃描 591 的新物件 |
| `pipeline` | 批次處理 `data/pipeline.md` 中所有待評估 URL |
| `compare 001, 003` | 並列比較兩間已評估物件 |
| `prepare visit for 001` | 產生報告 001 的看屋清單與議價策略 |
| `affordability` | 試算可負擔房價與區域適配（首購族） |
| `upgrade plan` | 換屋財務規劃：賣舊屋 + 買新房時程與資金缺口分析（換屋族） |
| `tracker` | 顯示所有追蹤物件的摘要 |

---

## 評分標準

物件依五個維度評分 0–5：

| 維度 | 租屋權重 | 買屋權重 |
|------|----------|----------|
| 價格合理性 | 30% | 35% |
| 空間與格局 | 20% | 20% |
| 區域生活機能 | 25% | 20% |
| 物件條件 | 15% | 15% |
| 風險與潛力 | 10% | 10% |

分數判讀：≥4.0 → 推薦看屋　·　3.5–3.9 → 持保留態度　·　<3.5 → 建議跳過

---

## 追蹤表狀態

`Scanned` → `Evaluated` → `Visit` → `Visited` → `Offer` → `Negotiating` → `Signed` → `Done`

另有：`Skip`（篩除）、`Pass`（看後放棄）、`Expired`（物件已下架）

---

## 資料合約

**使用者層**（永遠不會被自動覆寫）：`config/profile.yml`、`modes/_profile.md`、`data/*`、`reports/*`

**系統層**（可能隨系統更新）：所有 mode 檔案、`CLAUDE.md`、`*.mjs` 腳本、`templates/*`

---

## 腳本

```bash
# 日常
node scripts/scan-591.mjs         # 爬蟲：依 profile.yml 條件掃 591
node scripts/eval-591.mjs --from-pipeline 10   # 評估 pipeline 前 10 筆（同步產 .md + .html）
node scripts/rank-listings.mjs --rewrite       # Phase 1.5 排序重寫 pipeline.md
node scripts/run-daily.mjs        # 🌅 一鍵跑：scan → eval 今日新 → 寫日報 (md + html) → 寄 email

# 維護
node scripts/convert-reports-html.mjs  # 批次將 reports/*.md 轉成 .html（個別物件報告）
node merge-tracker.mjs           # 合併待新增 TSV 至 tracker.md
node verify-pipeline.mjs         # 檢查 pipeline 完整性
node dedup-tracker.mjs           # 移除重複追蹤條目
node --test tests/**/*.test.mjs  # 執行所有測試
```

報告檔案類型：
- `reports/NNN-*.md` — 個別物件評估報告（canonical 原始檔，git 追蹤）
- `reports/NNN-*.html` — 對應的美化檢視頁面（.md 自動渲染，gitignore）
- `reports/daily/YYYY-MM-DD.md` + `.html` — 每日彙總，html 支援排序 / 篩選

---

## 自動排程（macOS launchd）

每天固定時間自動跑 `run-daily.mjs`，產 `reports/daily/YYYY-MM-DD.md`。

### 安裝步驟

1. 編輯 `launchd/com.house-ops.daily.plist.example`，把 `YOUR_USERNAME` 換成你的 macOS 使用者名稱（`whoami` 查詢），如需調整執行時間改 `StartCalendarInterval` 的 Hour / Minute（預設每日 09:00）。

2. 複製到使用者 LaunchAgents：
   ```bash
   cp launchd/com.house-ops.daily.plist.example ~/Library/LaunchAgents/com.house-ops.daily.plist
   ```

3. 載入並啟動：
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.house-ops.daily.plist
   launchctl start com.house-ops.daily   # 立即手動觸發一次做測試
   ```

4. 確認已註冊：
   ```bash
   launchctl list | grep house-ops
   tail -f data/logs/daily.out.log       # 看每次跑的 stdout
   ls reports/daily/                     # 看每日日報
   ```

### Mac 熟睡解方

launchd 只在 Mac 醒著時觸發。若你的 Mac 夜間熟睡，可設定自動喚醒：

```bash
# 工作日 08:55 自動喚醒（09:00 跑完會自行進入睡眠）
sudo pmset repeat wakeorpoweron MTWRF 08:55:00
```

### Email 通知（選用）

跑完 daily 之後可自動把日報寄到信箱，避免漏看。本機透過 Gmail SMTP（nodemailer）寄送，需要 Gmail App Password。

設定步驟詳見 [`docs/email-setup.md`](docs/email-setup.md)，重點：

1. 到 <https://myaccount.google.com/apppasswords> 產一組 16 字元 App Password
2. 在 `~/Library/LaunchAgents/com.house-ops.daily.plist` 的 `EnvironmentVariables` 區塊加入 `GMAIL_USER`、`GMAIL_APP_PASSWORD`、`NOTIFY_EMAIL_TO`
3. `launchctl unload && launchctl load` 重載
4. 馬上測試：`node scripts/run-daily.mjs --email-only`

未設定環境變數時 daily run 仍正常完成，只是跳過寄信並顯示 `⚠ Email 跳過：缺少環境變數`。

寄出信件內容包含：今日新物件表格（分數 / 行政區 / 月租 / 坪數 / 格局 / 警示 / 591 連結）、價格變動、已下架條目、各區統計。詳細個別報告請至本機 `reports/` 目錄查看。

### CLI Flags

`scripts/run-daily.mjs` 支援以下 flag：

| Flag | 行為 |
|---|---|
| (預設) | 完整 scan + eval + 渲染 + 寄信 |
| `--dry-run` | 只重新渲染今日日報，不 scan、不寄信 |
| `--email-only` | 重新渲染今日日報並寄信，不 scan |
| `--no-email` | 完整 scan + eval + 渲染，但不寄信 |

`--dry-run` 與 `--email-only` 用 `data/last-scan.json`（前一次真跑的快取）+ 現有 `reports/NNN-*-YYYY-MM-DD.md` 重建 `reports/daily/YYYY-MM-DD.{md,html}`，不觸發 scan、不改 `scan-history.tsv`、不產新的個別報告。第一次使用前必須先有一次真跑以產生快取。

### 解除安裝

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.house-ops.daily.plist
rm ~/Library/LaunchAgents/com.house-ops.daily.plist
```

---

## 修改搜尋條件

所有條件集中在 **`config/profile.yml`**，修改後不必動 code：

| 欄位 | 影響 |
|---|---|
| `budget.rent_max` | 月租上限 |
| `property.size_min` | 最小坪數 |
| `regions[].city` + `districts` | 搜尋縣市與行政區（可多城市、多區）|
| `narrative.deal_breakers` | 標題命中直接排除 |
| `narrative.required_features` | Phase 2 評估時檢查必備設備 |

`config/591-sections.yml` 是系統層（591 的 region/section 代碼對照表），除非 591 改變編碼否則不用動。

---

## 使用原則

本系統以精準找房為目標，非大量瀏覽。Claude 不會代替你送出 offer、簽約或送出任何申請。評分低於 3.5/5 的物件將被明確建議不值得追蹤。

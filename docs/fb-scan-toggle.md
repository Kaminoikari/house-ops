# FB 社團爬蟲開關

每日排程（`com.house-ops.daily`，每天 09:00 透過 `scripts/run-daily.mjs` 觸發）預設會跑 591 → FB 兩段掃描。FB 段可用環境變數 `SKIP_FB=1` 暫停，591 不受影響。

## Chrome CDP 實例（chrome-debug）行為

從 2026-05 起 `com.house-ops.chrome-debug` 改為 **on-demand 模式**（`RunAtLoad: false` + `KeepAlive: false`）：

- 登入時**不會**自動啟動，日常使用 Chrome 關閉後**不會**被自動拉回。
- `run-daily.mjs` 在跑 FB scan 前會自動 `launchctl kickstart` 拉起 chrome-debug、跑完 `launchctl stop` 關掉。
- 若 user 已經手動 `launchctl start` 啟動了（例如要重新登入 FB），run-daily 會偵測到（透過 `/json/version` probe）並**不會**主動關掉它。

### 首次登入 FB / 手動測試
```bash
launchctl start com.house-ops.chrome-debug
# Chrome 視窗會跳出，登入 / 加入社團
# 完成後關閉視窗（KeepAlive=false 不會被拉回）；或：
launchctl stop com.house-ops.chrome-debug
```

## 暫停（停用 FB scan）

1. 編輯 `~/Library/LaunchAgents/com.house-ops.daily.plist`，在 `EnvironmentVariables` dict 內加入：
   ```xml
   <key>SKIP_FB</key>
   <string>1</string>
   ```
2. Reload daily 排程：
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.house-ops.daily.plist
   launchctl load   ~/Library/LaunchAgents/com.house-ops.daily.plist
   ```
3. chrome-debug 已是 on-demand（不常駐），SKIP_FB=1 時 run-daily 不會去拉它，無需額外動作。

暫停後行為：
- `run-daily.mjs` 印 `[daily] === Scan FB 已停用（SKIP_FB=1） ===`
- `data/last-scan.json` 的 `fb` 欄位寫入 `{ paused: true, ... }`
- 日報摘要顯示「FB 社團掃描：⏸ 已暫停」

## 恢復（重新啟用 FB scan）

1. 編輯 `~/Library/LaunchAgents/com.house-ops.daily.plist`，移除 `SKIP_FB` 兩行。
2. Reload daily 排程：
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.house-ops.daily.plist
   launchctl load   ~/Library/LaunchAgents/com.house-ops.daily.plist
   ```
3. chrome-debug 是 on-demand，恢復 SKIP_FB 後 run-daily 自動拉起；無需動 launchctl。
4. 若 FB session 過期，手動跑一次 `launchctl start com.house-ops.chrome-debug` 進去重新登入，登入完關掉視窗或 `launchctl stop` 即可。

## 驗證指令

```bash
# 排程是否載入
launchctl list | grep house-ops

# 環境變數是否注入成功
launchctl print "gui/$(id -u)/com.house-ops.daily" | grep SKIP_FB

# 跑一次（會真的爬，會覆寫 last-scan.json）
SKIP_FB=1 node scripts/run-daily.mjs --no-email
```

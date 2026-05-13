# FB 社團爬蟲開關

每日排程（`com.house-ops.daily`，每天 09:00 透過 `scripts/run-daily.mjs` 觸發）預設會跑 591 → FB 兩段掃描。FB 段可用環境變數 `SKIP_FB=1` 暫停，591 不受影響。

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
3. （建議）關掉 FB 爬蟲依賴的 Chrome CDP 實例，避免常駐：
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.house-ops.chrome-debug.plist
   ```

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
3. 重新載入 Chrome CDP 實例：
   ```bash
   launchctl load ~/Library/LaunchAgents/com.house-ops.chrome-debug.plist
   ```
4. 連到 `http://localhost:9222` 確認 Chrome 已起來；若 FB session 過期，手動登入一次即可。

## 驗證指令

```bash
# 排程是否載入
launchctl list | grep house-ops

# 環境變數是否注入成功
launchctl print "gui/$(id -u)/com.house-ops.daily" | grep SKIP_FB

# 跑一次（會真的爬，會覆寫 last-scan.json）
SKIP_FB=1 node scripts/run-daily.mjs --no-email
```

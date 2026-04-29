# Daily Email Notification Setup

跑完每日 scan 後，`scripts/run-daily.mjs` 會把 HTML 日報寄到你的信箱，避免漏看。本機用 Gmail SMTP + nodemailer。

## 1. 產 Gmail App Password（一次性）

App Password 是 16 字元的專屬密碼，給程式登入用，不會洩漏你真正的 Gmail 密碼。

1. 確認 Google 帳號已開啟「兩步驟驗證」（沒開的話 App Password 選項不會出現）
2. 前往 <https://myaccount.google.com/apppasswords>
3. App 名稱填「house-ops」（或任何你認得的名稱）→ Create
4. 複製產生的 16 字元密碼（含空格也可，貼上時系統會忽略空格）

> 如果頁面顯示「This setting is not available for your account」，先到 <https://myaccount.google.com/security> 啟用「2-Step Verification」。

## 2. 編輯本機 launchd plist

編輯 `~/Library/LaunchAgents/com.house-ops.daily.plist`（如果還沒拷貝過，先參考 `launchd/com.house-ops.daily.plist.example`）：

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>PATH</key>
  <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  <key>GMAIL_USER</key>
  <string>your.address@gmail.com</string>
  <key>GMAIL_APP_PASSWORD</key>
  <string>abcd efgh ijkl mnop</string>
  <key>NOTIFY_EMAIL_TO</key>
  <string>your.address@gmail.com</string>
</dict>
```

`NOTIFY_EMAIL_TO` 可以跟 `GMAIL_USER` 一樣（寄給自己）或填別的地址。

`launchd/com.house-ops.daily.plist`（不含 `.example`）已被 `.gitignore` 排除，App Password 不會進 git。

## 3. 重新載入 launchd

```bash
launchctl unload ~/Library/LaunchAgents/com.house-ops.daily.plist
launchctl load ~/Library/LaunchAgents/com.house-ops.daily.plist
```

## 4. 立刻測試一封

不等隔天 09:00，馬上手動跑一次：

```bash
cd ~/house-ops
GMAIL_USER='your.address@gmail.com' \
GMAIL_APP_PASSWORD='abcd efgh ijkl mnop' \
NOTIFY_EMAIL_TO='your.address@gmail.com' \
node scripts/run-daily.mjs --email-only
```

`--email-only` 會跳過 scan 跟 eval，只重新渲染今天的日報並寄信（需要至少跑過一次正常 daily run，產生 `data/last-scan.json` 跟 `reports/daily/{today}.md|.html`）。

預期 stderr 看到：

```
✓ Email 已寄出至 your.address@gmail.com
```

收件匣應該收到主旨像 `[house-ops] 2026-04-29 日報：3 筆新物件，最高分 4.2` 的信，HTML body 直接是日報內容。

## CLI Flags

| Flag | 行為 |
|---|---|
| (預設) | 完整 scan + eval + 渲染 + 寄信 |
| `--dry-run` | 只重新渲染今日日報，不 scan、不寄信 |
| `--email-only` | 重新渲染今日日報並寄信，不 scan |
| `--no-email` | 完整 scan + eval + 渲染，但不寄信 |

## Troubleshooting

- **`Invalid login: 535-5.7.8 Username and Password not accepted`**：App Password 錯誤或沒打開兩步驟驗證。重新產一次。
- **信寄出但沒收到**：檢查垃圾匣。Gmail 偶爾把自己寄給自己的信判斷為垃圾。
- **`⚠ Email 跳過：缺少環境變數`**：plist 沒設好，或 launchctl 還沒重載。
- **想暫時關掉**：跑 `node scripts/run-daily.mjs --no-email`，或在 plist 移除 `GMAIL_APP_PASSWORD` 環境變數即可（缺一個就會跳過寄信，daily run 仍正常完成）。

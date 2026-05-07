# FB 貼文評估模式

當使用者貼一個 FB 社團貼文 URL（`https://www.facebook.com/groups/{gid}/posts/{post_id}/` 或 `.../permalink/...`）時觸發。

## 前置需求

- `~/Library/LaunchAgents/com.house-ops.chrome-debug.plist` 已載入並執行
- 使用者已在該 Chrome 實例（`/Users/charles/house-ops/.chrome-profile`）登入 FB
- `ANTHROPIC_API_KEY` 已在環境變數中

## 流程

### 1. 連線並開啟貼文

```bash
agent-browser connect 9222
agent-browser open "{url}"
agent-browser wait 2500
```

驗證：
```bash
agent-browser get url
```
- 若 redirect 到 `login` / `checkpoint` → 提醒使用者重新登入該 Chrome 實例後再試，停止
- 若仍在 `facebook.com/groups/...` → 繼續

### 2. 抽出貼文文字

用 `agent-browser eval` 取主貼文 article 的 innerText：

```javascript
const arts = document.querySelectorAll('[role="article"]');
let main = null, maxLen = 0;
for (const el of arts) {
  let p = el.parentElement, isTop = true;
  while (p) { if (p.getAttribute && p.getAttribute('role') === 'article') { isTop = false; break; } p = p.parentElement; }
  if (!isTop) continue;
  const t = (el.innerText || '').length;
  if (t > maxLen) { maxLen = t; main = el; }
}
JSON.stringify({ text: main ? main.innerText : '', images: main ? [...main.querySelectorAll('img')].map(i=>i.src).filter(s=>s.startsWith('https://scontent')).length : 0 });
```

若 text 為空 → 貼文已刪除或不公開 → 回報使用者後停止。

### 3. LLM 結構化抽取

呼叫 `lib/extract-fb-post.mjs` 的 `extract(text)`，得到：
```javascript
{ price_num, address, district, size, layout, contact, confidence }
```

判斷：
- `confidence < 0.4` 或 `price_num` 為 null → 告訴使用者「貼文資訊不足」並貼出原文摘要
- `layout === '雅房'` 或 `layout === '分租套房'` → 仍可繼續但需在報告標註

### 4. Phase 1 快篩（同 591 流程）

對 `config/profile.yml` 比對：
| 條件 | 失敗 → skip |
|------|-------------|
| `price_num > budget.rent_max` | ✓ |
| `size < property.size_min` | ✓ |
| `layout` 是雅房 / 分租 | ✓ |

### 5. Phase 2 完整評估

若通過 Phase 1，走 `modes/rent.md` 完整流程，但**資料來源不同**：
- 591 走詳情頁；FB 用步驟 2 抽到的原文 + 步驟 3 抽到的結構化欄位作為輸入
- 評分時若部分欄位缺（樓層、建物年齡、設備），請在報告中明確標註「資訊不全 — FB 來源」並降低該維度權重

### 6. 寫入報告與 tracker

依 `CLAUDE.md` Report Conventions：
- 報告檔名：`{###}-{district}-{road-slug}-{YYYY-MM-DD}.md`
- 報告 header 的 `**URL:**` 用 FB permalink
- 報告 header 加一行：`**Source:** facebook_group ({group_id})`
- TSV 寫入 `batch/tracker-additions/{num}-{slug}.tsv`，platform 欄位寫 `FB社團`
- 跑 `node merge-tracker.mjs`

## 失敗模式

| 症狀 | 處置 |
|------|------|
| `agent-browser connect 9222` 失敗 | chrome-debug launchd 未跑；提醒使用者 `launchctl load -w ~/Library/LaunchAgents/com.house-ops.chrome-debug.plist` |
| 開啟後 redirect 到 login | session 過期；提醒使用者在該 Chrome 實例手動重登 |
| `extract` 回 null 或 throw `MissingApiKeyError` | API key 未設或抽取失敗；保留原文給使用者人工判斷 |
| 貼文已刪除（article 抽不到內文） | 告知並停止 |

// extract-fb-post.mjs — 用 Claude API 從 FB 租屋貼文文字抽結構化欄位。
// API: extract(text) → { price_num, address, district, size, layout, contact, confidence } | null

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;

const SYSTEM_PROMPT = `你是台灣租屋貼文資料抽取器。讀使用者給的 FB 租屋貼文文字，回傳 **單一 JSON 物件**，不要任何前後說明、不要 code fence。

JSON schema：
{
  "price_num": 月租金整數（單位元）；若是「萬」要換算（1.2萬 → 12000）；若無或不確定 → null,
  "address": 完整地址（含區），盡量保留路名與門牌；不確定 → null,
  "district": 行政區（例：松山區、中山區、板橋區）；不確定 → null,
  "size": 坪數浮點數；不確定 → null,
  "layout": 房型字串（例：1房1廳、套房、雅房）；不確定 → null,
  "contact": 聯絡方式（電話 / Line ID / FB 名稱）；不確定 → null,
  "confidence": 整體信心 0.0–1.0
}

判斷規則：
- 看到「分租 / 雅房 / 合租 / 押金」是雅房或分租 → layout 標 "雅房" 或 "分租套房"
- 「整層」「整套」→ 整層住家
- 看到「售 / 總價 / 萬以下買」→ 這是買屋貼文，所有欄位回 null，confidence 0
- 看到「徵 / 求 / 找房」→ 這是求租貼文（不是出租），所有欄位回 null，confidence 0
- 不要編造資料；不確定一律 null`;

export class MissingApiKeyError extends Error {
  constructor() { super('ANTHROPIC_API_KEY 未設定'); this.name = 'MissingApiKeyError'; }
}

async function callApi(text, signal) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();

  const res = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.content?.[0]?.text || '';
  return content.trim();
}

function parseJsonSafe(s) {
  // 容錯：模型偶爾會包 ```json ... ```
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); }
  catch { return null; }
}

export async function extract(text) {
  if (!text || typeof text !== 'string' || text.length < 30) return null;

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const raw = await callApi(text, ctrl.signal);
      clearTimeout(t);
      const obj = parseJsonSafe(raw);
      if (!obj) { lastErr = new Error('回傳非 JSON'); continue; }
      return {
        price_num: typeof obj.price_num === 'number' ? obj.price_num : null,
        address:   typeof obj.address   === 'string' ? obj.address.trim() : null,
        district:  typeof obj.district  === 'string' ? obj.district.trim() : null,
        size:      typeof obj.size      === 'number' ? obj.size : null,
        layout:    typeof obj.layout    === 'string' ? obj.layout.trim() : null,
        contact:   typeof obj.contact   === 'string' ? obj.contact.trim() : null,
        confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
      };
    } catch (e) {
      clearTimeout(t);
      if (e instanceof MissingApiKeyError) throw e;
      lastErr = e;
    }
  }
  console.error(`[extract-fb-post] 失敗 (${MAX_RETRIES + 1} 次): ${lastErr?.message}`);
  return null;
}

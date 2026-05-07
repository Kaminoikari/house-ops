#!/usr/bin/env node
// scan-fb.mjs — 透過 agent-browser CDP 連到使用者已登入的 Chrome，掃 FB 公開租屋社團貼文。
// 1) 連線 9222 → 開 group_url → 滾動 N 輪 → eval 抽 article 清單
// 2) 正則粗篩（含「租/月租/押金/萬」等關鍵字）
// 3) 對通過粗篩的貼文呼叫 lib/extract-fb-post.mjs（Claude API）抽結構化欄位
// 4) dedup（permalink 為 key），寫入 data/scan-history.tsv（共用 591 history）
// 5) 把當日結果以 ## FB Pending 區塊追加到 data/pipeline.md（不覆寫 591 寫的內容）
// 支援 --json：輸出結構化結果給 run-daily.mjs

import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { normalizeAddress } from '../lib/normalize-address.mjs';
import { extract, MissingApiKeyError } from '../lib/extract-fb-post.mjs';
import { syntheticScrollDown, closeCdp } from '../lib/cdp-scroll.mjs';

const ROOT  = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const DUMP  = resolve(tmpdir(), `scan-fb-${process.pid}.json`);

const PORTALS_PATH  = resolve(ROOT, 'portals.yml');
const HISTORY_PATH  = resolve(ROOT, 'data/scan-history.tsv');
const PIPELINE_PATH = resolve(ROOT, 'data/pipeline.md');
const PROFILE_PATH  = resolve(ROOT, 'config/profile.yml');

const CDP_PORT = 9222;
const FB_MARKER = '\n## FB Pending\n';

const run = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
const safeRun = (cmd) => { try { return run(cmd); } catch (e) { return ''; } };
// 不過 shell 直接傳 args，避免長 JS 因 shell escape 被截斷
const safeRunArgs = (args) => {
  try { return execFileSync('agent-browser', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }); }
  catch (e) { return ''; }
};

// ───────── 抽貼文卡片的 JS ─────────
// FB 群組頁結構：[role="feed"] > div
//   [0] = 排序切換按鈕
//   [1..] = 貼文卡片
// 每張卡片內：[data-ad-preview="message"] 是貼文主文字
// permalink link 在卡片內某個 a[href*="/posts/"]，URL 含 comment_id 等 query 要剝掉只留 /posts/{id}/
const EXTRACT_JS = `
  (function() {
    function hashStr(s) {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return (h >>> 0).toString(16);
    }
    const feed = document.querySelector('[role="feed"]');
    if (!feed) return JSON.stringify([]);
    const groupM = location.pathname.match(/\\/groups\\/(\\d+)/);
    const gid = groupM ? groupM[1] : 'unknown';
    const cards = feed.children;
    const seen = new Set();
    const out = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const msgEl = card.querySelector('[data-ad-preview="message"], [data-ad-rendering-role="story_message"]');
      let text = (msgEl ? msgEl.innerText : '').replace(/\\s+/g, ' ').trim();
      if (text.length < 20) continue;
      let permalink = null;
      const realLnk = card.querySelector('a[href*="/posts/"], a[href*="/permalink/"]');
      if (realLnk) {
        const m = (realLnk.href || '').match(/\\/(?:posts|permalink)\\/(\\d+)/);
        if (m) permalink = 'https://www.facebook.com/groups/' + gid + '/posts/' + m[1] + '/';
      }
      if (!permalink) {
        const userLnk = card.querySelector('a[href*="/user/"]');
        const userM = userLnk ? (userLnk.href || '').match(/\\/user\\/(\\d+)/) : null;
        const uid = userM ? userM[1] : 'anon';
        permalink = 'https://www.facebook.com/groups/' + gid + '/#post-' + uid + '-' + hashStr(text.slice(0, 80));
      }
      if (seen.has(permalink)) continue;
      seen.add(permalink);
      if (text.length > 4000) text = text.slice(0, 4000);
      const imgs = [...card.querySelectorAll('img')]
        .map(i => i.src || '').filter(s => s.startsWith('https://scontent')).length;
      out.push({ permalink, text, image_count: imgs });
    }
    return JSON.stringify(out);
  })();
`.replace(/\s+/g, ' ');

// 點擊所有「查看更多」展開摺疊貼文（FB 把 See more 放在 message div 結尾，用 span/div + 各種 role）
const EXPAND_JS = `
  (function() {
    const targets = ['查看更多', '顯示更多', 'See more', 'See More', '...查看更多', '… 查看更多'];
    let n = 0;
    const feed = document.querySelector('[role="feed"]');
    if (!feed) return '0';
    const candidates = feed.querySelectorAll('div[role="button"], span[role="button"], div[tabindex="0"]');
    for (const el of candidates) {
      const t = (el.textContent || '').trim();
      if (targets.includes(t)) { try { el.click(); n++; } catch(e) {} }
    }
    return String(n);
  })();
`.replace(/\s+/g, ' ');

// 切換 sort 為 "New posts"（按貼文發布時間排，排除 FB 演算法干擾）
const SORT_NEW_POSTS_JS = `
  (function() {
    const feed = document.querySelector('[role="feed"]');
    if (!feed || !feed.children[0]) return 'no_feed';
    const sortBtn = feed.children[0].querySelector('div[role="button"][aria-haspopup="dialog"], div[role="button"]');
    if (!sortBtn) return 'no_sort_btn';
    const label = (feed.children[0].textContent || '').trim();
    if (label.includes('New posts') || label.includes('最新貼文')) return 'already_new';
    sortBtn.click();
    return 'opened';
  })();
`.replace(/\s+/g, ' ');

const SORT_PICK_NEW_JS = `
  (function() {
    const items = document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="radio"]');
    for (const it of items) {
      const t = (it.textContent || '').trim();
      if (t.startsWith('New posts') || t.startsWith('最新貼文')) {
        it.click();
        return 'picked';
      }
    }
    return 'not_found';
  })();
`.replace(/\s+/g, ' ');

// 取得 scroll 狀態（用來偵測「卡在底部」）
const SCROLL_STATE_JS = `(function(){return JSON.stringify({y:window.scrollY, h:document.body.scrollHeight});})();`;
const SCROLL_TOP_JS = `(function(){window.scrollTo(0, 0); return 'ok';})();`;

function readScrollState(out) {
  const f = out.indexOf('"{');
  const l = out.lastIndexOf('}"');
  if (f < 0 || l <= f) return { y: -1, h: -1 };
  try { return JSON.parse(JSON.parse(out.slice(f, l + 2))); }
  catch { return { y: -1, h: -1 }; }
}

function expandSeeMore() {
  return safeRunArgs(['eval', EXPAND_JS]);
}

function evalOnPage() {
  const out = safeRunArgs(['eval', EXTRACT_JS]);
  const first = out.indexOf('"[');
  const last = out.lastIndexOf(']"');
  if (first < 0 || last < 0) return [];
  try { return JSON.parse(JSON.parse(out.slice(first, last + 2))); }
  catch { return []; }
}

// ───────── 正則粗篩 ─────────
const RE_RENT_HINT  = /(月租|月付|押金|租金|出租|招租|頂讓|分租|自租|套房|整層|雅房)/;
// 價格：含「元/塊/K/千/萬/月」單位 OR 4-5 位連續數字（台灣租屋常見區間 5000-25000）
const RE_PRICE_HINT = /([\d,.]+)\s*(元|塊|[kK]|千|萬|[\/／]月)|\b\d{4,5}\b/;
const RE_BUY_HINT   = /(總價|出售|售屋|萬以下買|自售|售\s|售\.)/;
const RE_DEMAND_HEAD = /^.{0,100}(徵|求租|找房|找室友|想租|找出租)/;
// hashtag 形式的求租文（任何位置）
const RE_DEMAND_TAG  = /#\s*(求租|找房|徵租|徵房|尋租|找室友|想租|徵房客找室友)/;

function prefilter(text) {
  if (!RE_RENT_HINT.test(text)) return false;
  if (!RE_PRICE_HINT.test(text)) return false;
  if (RE_BUY_HINT.test(text)) return false;
  if (RE_DEMAND_HEAD.test(text)) return false;
  if (RE_DEMAND_TAG.test(text)) return false;
  return true;
}

// ───────── permalink → external_id ─────────
function postIdFromPermalink(permalink) {
  // https://www.facebook.com/groups/{gid}/posts/{post_id}/
  const m = permalink.match(/\/(?:posts|permalink)\/(\d+)/);
  return m ? m[1] : permalink.split('/').filter(Boolean).pop() || '';
}

// ───────── history I/O（共用 scan-591 schema）─────────
const HISTORY_HEADER = [
  'url', 'first_seen', 'last_seen', 'source', 'portal', 'external_id', 'title',
  'address', 'normalized_address', 'price', 'size', 'status', 'price_history'
];

function parseHistory() {
  if (!existsSync(HISTORY_PATH)) return new Map();
  const raw = readFileSync(HISTORY_PATH, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) return new Map();
  const header = lines[0].split('\t');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const map = new Map();
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const url = cols[idx.url];
    if (!url) continue;
    const price_num = parseInt((cols[idx.price] || '').replace(/[^\d]/g, '')) || null;
    map.set(url, {
      url,
      first_seen: cols[idx.first_seen] || '',
      last_seen:  cols[idx.last_seen]  || cols[idx.first_seen] || '',
      source:     cols[idx.source]     || '591',
      portal:     cols[idx.portal]     || '',
      external_id: cols[idx.external_id] || '',
      title:      cols[idx.title] || '',
      address:    cols[idx.address] || '',
      normalized: cols[idx.normalized_address] || '',
      price_raw:  cols[idx.price] || '',
      price_num,
      size:       cols[idx.size] || '',
      status:     cols[idx.status] || '',
      price_history: cols[idx.price_history] || '',
    });
  }
  return map;
}

function writeHistory(map) {
  const rows = [HISTORY_HEADER.join('\t')];
  for (const h of map.values()) {
    rows.push([
      h.url, h.first_seen, h.last_seen, h.source || '591', h.portal,
      h.external_id || '',
      h.title, h.address, h.normalized, h.price_raw, h.size, h.status, h.price_history,
    ].map(v => String(v ?? '').replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t'));
  }
  writeFileSync(HISTORY_PATH, rows.join('\n') + '\n');
}

// ───────── 主流程 ─────────
async function scanGroup(portal) {
  console.error(`[fb] === ${portal.name} (${portal.group_id}) ===`);
  safeRun(`agent-browser open "${portal.group_url}"`);
  safeRun(`agent-browser wait 4500`);

  // 切換排序為「New posts」（按發布時間排）
  const sortOpen = safeRunArgs(['eval', SORT_NEW_POSTS_JS]);
  if (sortOpen.includes('opened')) {
    safeRun(`agent-browser wait 1500`);
    const pick = safeRunArgs(['eval', SORT_PICK_NEW_JS]);
    safeRun(`agent-browser wait 4500`); // 切換後 FB 重新渲染 feed
    console.error(`[fb] 切換排序為 New posts: ${pick.includes('picked') ? '✓' : '⚠️ ' + pick}`);
  } else if (sortOpen.includes('already_new')) {
    console.error(`[fb] 排序已是 New posts ✓`);
  } else {
    console.error(`[fb] ⚠️ 無法切換排序: ${sortOpen.slice(0, 80)}`);
  }

  // 偵測登入頁 redirect
  const url = safeRun(`agent-browser get url`).trim();
  if (/login|checkpoint/i.test(url)) {
    console.error(`[fb] ⚠️ Chrome 似未登入 FB（current url: ${url}）— 請在 Chrome 實例手動登入後重試`);
    return [];
  }

  const rounds = portal.scroll_rounds ?? 20;
  const collected = new Map();
  // 從頂部開始，確保所有 placeholder card 都會逐一進入 viewport 觸發 FB 內容渲染
  safeRunArgs(['eval', SCROLL_TOP_JS]);
  safeRun(`agent-browser wait 1500`);
  let prevY = -1;
  let stuckRounds = 0;
  for (let i = 0; i < rounds; i++) {
    expandSeeMore();
    safeRun(`agent-browser wait 700`);
    const items = evalOnPage();
    let fresh = 0;
    for (const it of items) {
      const prev = collected.get(it.permalink);
      if (!prev) { collected.set(it.permalink, it); fresh++; }
      else if (it.text.length > prev.text.length) collected.set(it.permalink, it);
    }
    // CDP 合成觸控手勢觸發 FB lazy load（JS scroll / keyboard / agent-browser scroll 都被 anti-bot 忽略）
    try { await syntheticScrollDown(900); }
    catch (e) { console.error(`[fb] CDP scroll 失敗: ${e.message}`); break; }
    safeRun(`agent-browser wait 2200`);
    const { y, h } = readScrollState(safeRunArgs(['eval', SCROLL_STATE_JS]));
    console.error(`[fb] scroll ${i + 1}/${rounds}: +${fresh} (total ${collected.size}) y=${Math.round(y)} h=${h}`);
    if (Math.abs(y - prevY) < 20) stuckRounds++; else stuckRounds = 0;
    if (stuckRounds >= 3) { console.error(`[fb] scroll 卡在 y=${Math.round(y)}（已到底），提早結束`); break; }
    prevY = y;
  }
  // 最後再 expand + 抽一次（capture 上次 scroll 後仍可能新渲染的）
  expandSeeMore();
  safeRun(`agent-browser wait 1000`);
  for (const it of evalOnPage()) {
    const prev = collected.get(it.permalink);
    if (!prev || it.text.length > prev.text.length) collected.set(it.permalink, it);
  }
  return [...collected.values()].map(it => ({ ...it, portal: portal.name, group_id: portal.group_id }));
}

function profileMatches(extracted, profile) {
  const reasons = [];
  const rentMax = profile.budget?.rent_max ?? 25000;
  const sizeMin = profile.property?.size_min ?? 8;
  if (extracted.price_num != null && extracted.price_num > rentMax) reasons.push(`price>${rentMax}`);
  if (extracted.size      != null && extracted.size      < sizeMin) reasons.push(`size<${sizeMin}`);
  if (extracted.layout && /雅房|分租|合租/.test(extracted.layout))   reasons.push(`layout=${extracted.layout}`);
  return reasons;
}

async function main() {
  const wantJson = process.argv.includes('--json');
  const log = wantJson ? ((...a) => console.error(...a)) : ((...a) => console.log(...a));

  const portals = YAML.parse(readFileSync(PORTALS_PATH, 'utf8'));
  const profile = YAML.parse(readFileSync(PROFILE_PATH, 'utf8'));
  const fbPortals = (portals.tracked_portals || [])
    .filter(p => p.enabled && p.source === 'facebook_group');
  if (!fbPortals.length) { console.error('[fb] portals.yml 無 facebook_group，略過'); if (wantJson) process.stdout.write(JSON.stringify({ today: TODAY, totalFound: 0, qualified: [], skipped: [], newItems: [], refreshed: [], skipped_prefilter: 0, skipped_extract: 0 }) + '\n'); return; }

  // CDP 連線
  const conn = safeRun(`agent-browser connect ${CDP_PORT}`);
  if (!conn) {
    console.error(`[fb] ⚠️ 無法連到 Chrome (port ${CDP_PORT})。請確認 chrome-debug launchd 已載入。`);
    if (wantJson) process.stdout.write(JSON.stringify({ today: TODAY, error: 'cdp_connect_failed', totalFound: 0, qualified: [], skipped: [], newItems: [], refreshed: [], skipped_prefilter: 0, skipped_extract: 0 }) + '\n');
    process.exit(2);
  }

  // 1) 抓所有社團原始貼文
  const rawAll = [];
  for (const p of fbPortals) {
    const items = await scanGroup(p);
    rawAll.push(...items);
  }
  log(`[fb] 原始貼文：${rawAll.length}`);

  // 2) 正則粗篩
  const passed = rawAll.filter(it => prefilter(it.text));
  const filteredOut = rawAll.length - passed.length;
  log(`[fb] 正則粗篩通過：${passed.length} / 排除：${filteredOut}`);

  // 3) LLM 結構化抽取
  let llmOk = 0, llmFail = 0, missingKey = false;
  const extracted = [];
  for (const it of passed) {
    if (missingKey) break;
    let r = null;
    try {
      r = await extract(it.text);
    } catch (e) {
      if (e instanceof MissingApiKeyError) {
        console.error('[fb] ⚠️ ANTHROPIC_API_KEY 未設，後續 LLM 階段全部跳過（仍寫原文到 pipeline）');
        missingKey = true;
        break;
      }
      throw e;
    }
    if (r && r.confidence > 0.4 && r.price_num) { extracted.push({ ...it, ...r }); llmOk++; }
    else { llmFail++; }
  }
  log(`[fb] LLM 抽取成功：${llmOk}，丟棄：${llmFail}${missingKey ? '（API key 缺）' : ''}`);

  // 4) profile 過濾
  const qualified = [];
  const skipped = [];
  for (const it of extracted) {
    const reasons = profileMatches(it, profile);
    if (reasons.length) skipped.push({ ...it, reasons });
    else qualified.push(it);
  }

  // 5) dedup + history
  const history = parseHistory();
  const newItems = [], refreshed = [];
  for (const it of [...qualified, ...skipped]) {
    const h = history.get(it.permalink);
    if (!h) newItems.push(it);
    else refreshed.push(it);
  }

  for (const it of newItems) {
    history.set(it.permalink, {
      url: it.permalink, first_seen: TODAY, last_seen: TODAY,
      source: 'facebook', portal: it.portal,
      external_id: postIdFromPermalink(it.permalink),
      title: (it.text || '').slice(0, 60).replace(/\s+/g, ' '),
      address: it.address || '', normalized: it.address ? normalizeAddress(it.address) : '',
      price_raw: it.price_num ? `${it.price_num.toLocaleString()}元/月` : '',
      price_num: it.price_num ?? null,
      size: it.size ?? '',
      status: skipped.some(s => s.permalink === it.permalink) ? 'skipped_profile' : 'Added',
      price_history: it.price_num ? `${TODAY}:${it.price_num}` : '',
    });
  }
  for (const it of refreshed) {
    const prev = history.get(it.permalink);
    history.set(it.permalink, { ...prev, last_seen: TODAY });
  }

  // 也把 prefilter 排除/LLM 失敗 的 permalink 記入 history（避免每天重抽）
  for (const it of rawAll) {
    if (history.has(it.permalink)) continue;
    history.set(it.permalink, {
      url: it.permalink, first_seen: TODAY, last_seen: TODAY,
      source: 'facebook', portal: it.portal,
      external_id: postIdFromPermalink(it.permalink),
      title: (it.text || '').slice(0, 60).replace(/\s+/g, ' '),
      address: '', normalized: '',
      price_raw: '', price_num: null, size: '',
      status: 'skipped_prefilter', price_history: '',
    });
  }

  writeHistory(history);

  // 6) 追加 ## FB Pending 到 pipeline.md（不覆寫 591 部分）
  const lines = qualified.map(q => {
    const district = q.district || '未知區';
    const price = q.price_num ? `${q.price_num.toLocaleString()}元/月` : '?';
    const size = q.size != null ? `${q.size}坪` : '?坪';
    const layout = q.layout || '';
    const excerpt = (q.text || '').slice(0, 50).replace(/\s+/g, ' ');
    return `- [ ] ${q.permalink} | ${q.portal} | ${district} | 租 | ${price} | ${size} | ${layout} | ${excerpt}…`;
  });
  let existing = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf8') : `# Pipeline Inbox\n\n## Pending\n`;
  const idx = existing.indexOf(FB_MARKER);
  const head = idx >= 0 ? existing.slice(0, idx) : existing.replace(/\n+$/, '') + '\n';
  const fbBody = `${FB_MARKER}\n_Auto-generated by scripts/scan-fb.mjs on ${TODAY}._\n\n${lines.join('\n') || '_(無新物件通過評估)_'}\n`;
  writeFileSync(PIPELINE_PATH, head + fbBody);

  // 7) dump + summary
  writeFileSync(DUMP, JSON.stringify({
    qualified, skipped, newItems,
    rawCount: rawAll.length,
    rawAll: rawAll.map(r => ({
      permalink: r.permalink,
      length: r.text.length,
      passed_prefilter: prefilter(r.text),
      text: r.text.slice(0, 600),
    })),
  }, null, 2));

  log('\n━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`FB Scan — ${TODAY}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`社團數：${fbPortals.length}`);
  log(`原始貼文：${rawAll.length}`);
  log(`粗篩通過：${passed.length}`);
  log(`LLM 抽取成功：${llmOk}`);
  log(`profile 過濾通過：${qualified.length}`);
  log(`新增物件：${newItems.length}`);
  log(`既有更新：${refreshed.length}`);
  log(`dump: ${DUMP}`);

  if (wantJson) {
    process.stdout.write(JSON.stringify({
      today: TODAY,
      totalFound: rawAll.length,
      prefilterPassed: passed.length,
      llmOk, llmFail,
      missingApiKey: missingKey,
      qualified, skipped, newItems, refreshed,
      dumpPath: DUMP,
    }) + '\n');
  } else if (qualified.length) {
    log('\n本次通過評估的 FB 物件：');
    for (const q of qualified.slice(0, 10)) {
      const price = q.price_num ? `${q.price_num.toLocaleString()}元` : '?';
      log(`  🆕 [${q.district || '?'}] ${price.padEnd(10)} ${(q.size ?? '?')}坪 ${q.layout || ''}  ${q.permalink}`);
    }
    if (qualified.length > 10) log(`  ...(+${qualified.length - 10} more)`);
  }
}

main()
  .then(() => closeCdp())
  .catch(e => { console.error(e); closeCdp(); process.exit(1); });

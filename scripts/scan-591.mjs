#!/usr/bin/env node
// scan-591.mjs — scrape 591 rental listings via agent-browser.
// Reads config/profile.yml + config/591-sections.yml to build SEARCH_URLS dynamically.
// Performs cross-day dedup via data/scan-history.tsv, tracks price changes, detects expired.
// If called with --json, prints structured result to stdout for run-daily.mjs consumption.

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const DUMP = resolve(tmpdir(), `scan-591-${process.pid}.json`);

const run = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

const PROFILE_PATH  = resolve(ROOT, 'config/profile.yml');
const SECTIONS_PATH = resolve(ROOT, 'config/591-sections.yml');
const HISTORY_PATH  = resolve(ROOT, 'data/scan-history.tsv');
const PIPELINE_PATH = resolve(ROOT, 'data/pipeline.md');

const EXTRACT_JS = `
  const items = document.querySelectorAll('.list-wrapper .item');
  const out = [];
  for (const el of items) {
    const a = el.querySelector('a');
    const link = a ? a.href : '';
    if (!link) continue;
    out.push({
      link: link,
      title: (el.querySelector('.item-info-title') || {}).innerText || '',
      price: (el.querySelector('.item-info-price') || {}).innerText || '',
      tags:  (el.querySelector('.item-info-txt')   || {}).innerText || '',
      full:  el.innerText || ''
    });
  }
  JSON.stringify(out);
`.replace(/\s+/g, ' ');

function extractOnPage() {
  const out = run(`agent-browser eval ${JSON.stringify(EXTRACT_JS)}`);
  const first = out.indexOf('"[');
  const last = out.lastIndexOf(']"');
  if (first < 0) return [];
  return JSON.parse(JSON.parse(out.slice(first, last + 2)));
}

const RE_TYPE   = /(整層住家|獨立套房|分租套房|雅房)/;
const RE_LAYOUT = /(\d+房\d+廳)/;
const RE_SIZE   = /(\d+(?:\.\d+)?)坪/;
const RE_FLOOR  = /(B?\d+)F\/(\d+)F/;
const RE_PRICE  = /([\d,]+)元/;

function buildDistrictRegex(profile) {
  const dists = profile.regions.flatMap(r => r.districts);
  return new RegExp(`(${dists.join('|')})-?([^\\s|]+)?`);
}

function parseListing(raw, reDistrict) {
  const text = raw.full.replace(/\s+/g, ' ');
  const typeM = raw.tags.match(RE_TYPE);
  const layoutM = raw.tags.match(RE_LAYOUT);
  const sizeM = raw.tags.match(RE_SIZE);
  const floorM = raw.tags.match(RE_FLOOR);
  const priceM = raw.price.match(RE_PRICE);
  const distM = text.match(reDistrict);
  const district = distM ? distM[1] : '未知區';
  const addr = distM ? `${distM[1]}-${distM[2] || ''}`.replace(/-$/, '') : district;
  return {
    url: raw.link,
    title: raw.title.trim(),
    price_raw: raw.price.trim(),
    price_num: priceM ? parseInt(priceM[1].replace(/,/g, '')) : null,
    type: typeM ? typeM[1] : '未知',
    layout: layoutM ? layoutM[1] : '',
    size: sizeM ? parseFloat(sizeM[1]) : null,
    floor: floorM ? floorM[1] : '',
    total_floor: floorM ? parseInt(floorM[2]) : null,
    address: addr,
    district,
    full: text,
  };
}

const RE_ELEVATOR_SIGNAL = /電梯|大樓|華廈|社宅|社會住宅|社會宅|包租代管|公宅/;
const RE_PARKING_ONLY = /停車位|車位$|B\d+大?(停車|車)位|機械車位|平面車位/;

function titleFilter(l, rentMax) {
  const reasons = [];
  const text = `${l.title} ${l.full}`;
  if (RE_PARKING_ONLY.test(l.title)) reasons.push('停車位');
  if (l.price_num && l.price_num > rentMax) reasons.push(`price>${rentMax}`);
  if (l.size != null && l.size < 8) reasons.push('size<8');
  if (l.type === '分租套房' || l.type === '雅房') reasons.push(`type=${l.type}`);
  if (/雅房|分租|合租/.test(text)) reasons.push('keyword:雅房/分租/合租');
  if (/頂樓加蓋|加蓋/.test(text)) reasons.push('keyword:頂樓加蓋');
  if (/地下室/.test(text) || /^B\d+$/.test(l.floor)) reasons.push('地下室');
  if (l.floor === '1') reasons.push('floor=1');
  if (l.total_floor && l.total_floor <= 5 && !RE_ELEVATOR_SIGNAL.test(text)) {
    reasons.push(`疑似公寓(${l.floor}F/${l.total_floor}F)`);
  }
  return reasons;
}

const normalize = (s) => s.replace(/\s+/g, '').replace(/台/g, '臺').toLowerCase();

function buildSearchUrls(profile, sections) {
  const urls = [];
  const rentMax = profile.budget?.rent_max ?? 25000;
  const sizeMin = profile.property?.size_min ?? 8;
  for (const r of profile.regions || []) {
    const cityEntry = sections.regions[r.city];
    if (!cityEntry) {
      console.error(`[scan] ⚠️ 591-sections.yml 缺少城市「${r.city}」，略過`);
      continue;
    }
    const codes = [];
    for (const d of r.districts) {
      const code = cityEntry.sections[d];
      if (code == null) { console.error(`[scan] ⚠️ ${r.city}-${d} 缺 section code，略過`); continue; }
      codes.push(code);
    }
    if (!codes.length) continue;
    const url = `https://rent.591.com.tw/list?region=${cityEntry.code}&section=${codes.join(',')}&rentprice=0,${rentMax}&area=${sizeMin},&kind=1,2&shape=2,4,6&order=posttime&orderType=desc`;
    urls.push({ name: `${r.city} ${r.districts.length} 區 (${r.districts.join('/')})`, url });
  }
  return urls;
}

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
      external_id: cols[idx.external_id] || (url.split('/').filter(Boolean).pop() || '').split('?')[0],
      title:      cols[idx.title]      || '',
      address:    cols[idx.address]    || '',
      normalized: cols[idx.normalized_address] || '',
      price_raw:  cols[idx.price]      || '',
      price_num,
      size:       cols[idx.size]       || '',
      status:     cols[idx.status]     || '',
      price_history: cols[idx.price_history] || '',
    });
  }
  return map;
}

const HISTORY_HEADER = [
  'url', 'first_seen', 'last_seen', 'source', 'portal', 'external_id', 'title',
  'address', 'normalized_address', 'price', 'size', 'status', 'price_history'
];

function writeHistory(map) {
  const rows = [HISTORY_HEADER.join('\t')];
  for (const h of map.values()) {
    rows.push([
      h.url, h.first_seen, h.last_seen, h.source || '591', h.portal,
      h.external_id || (h.url.split('/').filter(Boolean).pop() || '').split('?')[0],
      h.title, h.address, h.normalized, h.price_raw, h.size, h.status, h.price_history,
    ].map(v => String(v ?? '')).join('\t'));
  }
  writeFileSync(HISTORY_PATH, rows.join('\n') + '\n');
}

async function scanOneUrl(baseUrl, name, all, seen) {
  console.error(`[scan] === ${name} ===`);
  run(`agent-browser open "${baseUrl}"`);
  run(`agent-browser wait 2500`);
  for (let page = 1; page <= 10; page++) {
    const listings = extractOnPage();
    if (!listings.length) { console.error(`[scan] ${name} page ${page}: empty, stop`); break; }
    let fresh = 0;
    for (const raw of listings) {
      if (seen.has(raw.link)) continue;
      seen.add(raw.link);
      all.push(raw);
      fresh++;
    }
    console.error(`[scan] ${name} page ${page}: +${fresh} new (total ${all.length})`);
    if (fresh === 0) break;
    run(`agent-browser open "${baseUrl}&firstRow=${page * 30}"`);
    run(`agent-browser wait 2500`);
  }
}

async function main() {
  const wantJson = process.argv.includes('--json');
  const log = wantJson ? ((...a) => console.error(...a)) : ((...a) => console.log(...a));

  const profile  = YAML.parse(readFileSync(PROFILE_PATH, 'utf8'));
  const sections = YAML.parse(readFileSync(SECTIONS_PATH, 'utf8'));
  const rentMax = profile.budget?.rent_max ?? 25000;
  const reDistrict = buildDistrictRegex(profile);

  const searchUrls = buildSearchUrls(profile, sections);
  if (!searchUrls.length) { console.error('[scan] 無有效 search URL，檢查 profile.yml + 591-sections.yml'); process.exit(1); }

  const rawAll = [];
  const seenToday = new Set();
  for (const s of searchUrls) await scanOneUrl(s.url, s.name, rawAll, seenToday);

  const parsedAll = rawAll.map(raw => parseListing(raw, reDistrict));
  const qualified = [];
  const skipped = [];
  for (const l of parsedAll) {
    const reasons = titleFilter(l, rentMax);
    if (reasons.length) skipped.push({ ...l, reasons });
    else qualified.push(l);
  }

  const history = parseHistory();
  const newItems = [], refreshed = [], priceChanged = [];
  for (const l of qualified) {
    const h = history.get(l.url);
    if (!h || h.status === 'Expired') {
      newItems.push(l);
    } else {
      refreshed.push(l);
      if (h.price_num && l.price_num && h.price_num !== l.price_num) {
        priceChanged.push({ ...l, prev_price: h.price_num, prev_price_raw: h.price_raw });
      }
    }
  }

  const activeUrls = new Set([...qualified.map(l => l.url), ...skipped.map(l => l.url)]);
  const expired = [];
  for (const h of history.values()) {
    if (h.status === 'Added' && !activeUrls.has(h.url)) {
      expired.push(h);
    }
  }

  const now = history;
  for (const l of newItems) {
    now.set(l.url, {
      url: l.url, first_seen: TODAY, last_seen: TODAY,
      source: '591', portal: '591 租屋',
      external_id: (l.url.split('/').filter(Boolean).pop() || '').split('?')[0],
      title: l.title, address: l.address, normalized: normalize(l.address),
      price_raw: l.price_raw, price_num: l.price_num, size: l.size ?? '',
      status: 'Added', price_history: `${TODAY}:${l.price_num ?? ''}`,
    });
  }
  for (const l of refreshed) {
    const prev = now.get(l.url);
    const priceHistStr = prev.price_history || `${prev.first_seen}:${prev.price_num ?? ''}`;
    const newHist = (l.price_num && prev.price_num !== l.price_num)
      ? `${priceHistStr};${TODAY}:${l.price_num}`
      : priceHistStr;
    now.set(l.url, { ...prev, last_seen: TODAY, title: l.title, address: l.address,
      price_raw: l.price_raw, price_num: l.price_num, status: 'Added', price_history: newHist });
  }
  for (const s of skipped) {
    if (now.has(s.url)) continue;
    now.set(s.url, {
      url: s.url, first_seen: TODAY, last_seen: TODAY,
      source: '591', portal: '591 租屋',
      external_id: (s.url.split('/').filter(Boolean).pop() || '').split('?')[0],
      title: s.title, address: s.address, normalized: normalize(s.address),
      price_raw: s.price_raw, price_num: s.price_num, size: s.size ?? '',
      status: 'skipped_title', price_history: `${TODAY}:${s.price_num ?? ''}`,
    });
  }
  for (const e of expired) {
    now.set(e.url, { ...e, status: 'Expired' });
  }
  writeHistory(now);

  const pipeLines = qualified.map(l =>
    `- [ ] ${l.url} | 591 | ${l.district} | 租 | ${l.price_raw} | ${l.size ?? '?'}坪 | ${l.type}${l.layout}`
  );
  const pipeHeader = `# Pipeline Inbox\n\nAuto-generated by scripts/scan-591.mjs on ${TODAY}.\n\n## Pending\n`;
  writeFileSync(PIPELINE_PATH, pipeHeader + pipeLines.join('\n') + '\n');

  writeFileSync(DUMP, JSON.stringify({ qualified, skipped, newItems, refreshed, expired, priceChanged }, null, 2));

  log('\n━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`Portal Scan — ${TODAY}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`掃描 URL：${searchUrls.length} 組`);
  log(`物件找到：${parsedAll.length}`);
  log(`快篩通過：${qualified.length}`);
  log(`  └─ 新物件：${newItems.length}`);
  log(`  └─ 既有仍在架：${refreshed.length}`);
  log(`  └─ 價格變動：${priceChanged.length}`);
  log(`已下架：${expired.length}`);
  log(`標題不符：${skipped.length}`);
  log(`dump: ${DUMP}`);

  if (wantJson) {
    const jsonOut = { today: TODAY, searchUrls: searchUrls.length, totalFound: parsedAll.length,
      qualified, skipped, newItems, refreshed, expired, priceChanged, dumpPath: DUMP };
    process.stdout.write(JSON.stringify(jsonOut) + '\n');
  } else {
    const byDist = {};
    for (const l of qualified) (byDist[l.district] = byDist[l.district] || []).push(l);
    log('\n各區分佈：');
    for (const [d, ls] of Object.entries(byDist).sort((a, b) => b[1].length - a[1].length)) log(`  ${d}: ${ls.length} 筆`);
    if (newItems.length) {
      log('\n今日新物件：');
      for (const l of newItems.slice(0, 20)) {
        log(`  🆕 [${l.district}] ${(l.price_raw||'').padEnd(14)} ${String(l.size??'?').padStart(4)}坪 ${l.type}${l.layout}  ${l.title.slice(0, 30)}`);
      }
      if (newItems.length > 20) log(`  ...(+${newItems.length - 20} more)`);
    }
    if (priceChanged.length) {
      log('\n價格變動：');
      for (const l of priceChanged) {
        const diff = l.price_num - l.prev_price;
        const pct = Math.round(diff / l.prev_price * 100);
        log(`  💰 [${l.district}] ${l.prev_price} → ${l.price_num} (${diff>0?'+':''}${diff}/${pct>0?'+':''}${pct}%) ${l.title.slice(0, 30)}`);
      }
    }
    if (expired.length) {
      log('\n已下架：');
      for (const e of expired.slice(0, 20)) log(`  💀 ${e.url.split('/').pop()} ${e.address} ${e.price_raw} (上次見 ${e.last_seen})`);
      if (expired.length > 20) log(`  ...(+${expired.length - 20} more)`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });

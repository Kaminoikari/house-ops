#!/usr/bin/env node
// scan-591.mjs — scrape 591 rental listings via agent-browser
import { execSync } from 'node:child_process';
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const DUMP = resolve(tmpdir(), `scan-591-${process.pid}.json`);

const run = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

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
  const wrapped = out.slice(first, last + 2);
  const inner = JSON.parse(wrapped);
  return JSON.parse(inner);
}

const RE_TYPE   = /(整層住家|獨立套房|分租套房|雅房)/;
const RE_LAYOUT = /(\d+房\d+廳)/;
const RE_SIZE   = /(\d+(?:\.\d+)?)坪/;
const RE_FLOOR  = /(B?\d+)F\/(\d+)F/;
const RE_PRICE  = /([\d,]+)元/;

function parseListing(raw) {
  const text = raw.full.replace(/\s+/g, ' ');
  const typeM = raw.tags.match(RE_TYPE);
  const layoutM = raw.tags.match(RE_LAYOUT);
  const sizeM = raw.tags.match(RE_SIZE);
  const floorM = raw.tags.match(RE_FLOOR);
  const priceM = raw.price.match(RE_PRICE);
  const addr = (text.match(/板橋區-[^\s|]+/) || ['板橋區'])[0];
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
    full: text,
  };
}

const RE_ELEVATOR_SIGNAL = /電梯|大樓|華廈|社宅|社會住宅|社會宅|包租代管|公宅/;
const RE_PARKING_ONLY = /停車位|車位$|B\d+大?(停車|車)位|機械車位|平面車位/;

function titleFilter(l) {
  const reasons = [];
  const text = `${l.title} ${l.full}`;
  if (RE_PARKING_ONLY.test(l.title)) reasons.push('停車位');
  if (l.price_num && l.price_num > 20000) reasons.push('price>20000');
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

async function main() {
  const baseUrl = 'https://rent.591.com.tw/list?region=3&section=26&rentprice=0,20000&area=8,&kind=1,2&shape=2,4,6&order=posttime&orderType=desc';

  console.log(`[scan] opening base URL`);
  run(`agent-browser open "${baseUrl}"`);
  run(`agent-browser wait 2500`);

  const all = [];
  const seen = new Set();

  for (let page = 1; page <= 6; page++) {
    const listings = extractOnPage();
    if (!listings.length) { console.log(`[scan] page ${page}: empty, stop`); break; }
    let fresh = 0;
    for (const raw of listings) {
      if (seen.has(raw.link)) continue;
      seen.add(raw.link);
      all.push(parseListing(raw));
      fresh++;
    }
    console.log(`[scan] page ${page}: +${fresh} new (total ${all.length})`);
    if (fresh === 0) break;

    run(`agent-browser open "${baseUrl}&firstRow=${page * 30}"`);
    run(`agent-browser wait 2500`);
  }

  const qualified = [];
  const skipped = [];
  for (const l of all) {
    const reasons = titleFilter(l);
    if (reasons.length) skipped.push({ ...l, reasons });
    else qualified.push(l);
  }

  const pipeLines = qualified.map(l =>
    `- [ ] ${l.url} | 591 | 板橋區 | 租 | ${l.price_raw} | ${l.size ?? '?'}坪 | ${l.type}${l.layout}`
  );
  if (pipeLines.length) appendFileSync(resolve(ROOT, 'data/pipeline.md'), pipeLines.join('\n') + '\n');

  const histLines = [
    ...qualified.map(l => [l.url, TODAY, '591 租屋', l.title, l.address, normalize(l.address), l.price_raw, l.size ?? '', 'Added'].join('\t')),
    ...skipped.map(l => [l.url, TODAY, '591 租屋', l.title, l.address, normalize(l.address), l.price_raw, l.size ?? '', 'skipped_title'].join('\t')),
  ];
  if (histLines.length) appendFileSync(resolve(ROOT, 'data/scan-history.tsv'), histLines.join('\n') + '\n');

  writeFileSync(DUMP, JSON.stringify({ qualified, skipped }, null, 2));

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Portal Scan — ${TODAY}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`物件找到: ${all.length}`);
  console.log(`快篩通過: ${qualified.length}`);
  console.log(`標題不符: ${skipped.length}`);
  console.log(`新增至 pipeline.md: ${qualified.length}`);
  console.log(`完整 dump: ${DUMP}\n`);
  for (const l of qualified.slice(0, 30)) {
    const p = (l.price_raw || '').padEnd(14);
    const s = String(l.size ?? '?').padStart(4);
    const f = `${l.floor}F/${l.total_floor}F`.padEnd(8);
    console.log(`  + ${p} ${s}坪 ${f} ${l.type}${(l.layout||'').padEnd(8)} ${l.title.slice(0, 36)}`);
  }
  if (qualified.length > 30) console.log(`  ...(+${qualified.length - 30} more)`);

  if (skipped.length) {
    const counts = {};
    for (const s of skipped) for (const r of s.reasons) counts[r] = (counts[r] || 0) + 1;
    console.log('\n略過原因：');
    for (const [r, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  × ${r}: ${n}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });

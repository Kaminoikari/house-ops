#!/usr/bin/env node
// rank-listings.mjs — Phase 1.5 ranker: score candidates in pipeline.md, sort desc, rewrite.
//
// Scoring:
//   - 單坪租金 vs 區域基準（折扣越大分越高）
//   - 坪數（大加分）
//   - 格局完整度（房 + 廳 bonus）
//   - 社宅加分（標題含社宅/社會住宅/租補）
//   - 區域偏好加權（精華區 vs 外圍）
//
// Usage:
//   node scripts/rank-listings.mjs              # 顯示排序結果
//   node scripts/rank-listings.mjs --rewrite    # 同時把 pipeline.md 以降序重寫

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DISTRICT_BASELINE = {
  '大安區': 1900, '信義區': 1900, '松山區': 1600, '中正區': 1500,
  '中山區': 1500, '大同區': 1300, '士林區': 1300, '南港區': 1400,
  '萬華區': 1200, '板橋區': 1100, '中和區': 1000, '三重區': 950,
};

const DISTRICT_BONUS = {
  '信義區': 0.5, '大安區': 0.4, '松山區': 0.3, '中山區': 0.2,
  '中正區': 0.2, '南港區': 0.2, '士林區': 0.1, '大同區': 0.1,
  '萬華區': 0, '板橋區': 0, '中和區': 0, '三重區': -0.1,
};

function parsePipeline() {
  const pipe = readFileSync(resolve(ROOT, 'data/pipeline.md'), 'utf8');
  const rows = [];
  for (const line of pipe.split('\n')) {
    const m = line.match(/^- \[ \] (https:\/\/rent\.591\.com\.tw\/\d+) \| 591 \| (\S+) \| 租 \| ([\d,]+)元\/月 \| ([\d.]+)坪 \| (.+)$/);
    if (!m) continue;
    const [, url, district, priceRaw, sizeRaw, type] = m;
    const layoutM = type.match(/(\d+)房(\d+)廳/);
    rows.push({
      url,
      district,
      price: parseInt(priceRaw.replace(/,/g, '')),
      size: parseFloat(sizeRaw),
      type,
      rooms: layoutM ? parseInt(layoutM[1]) : 0,
      halls: layoutM ? parseInt(layoutM[2]) : 0,
    });
  }
  return rows;
}

function parseHistory() {
  const tsv = readFileSync(resolve(ROOT, 'data/scan-history.tsv'), 'utf8');
  const byUrl = {};
  for (const line of tsv.split('\n').slice(1)) {
    const cols = line.split('\t');
    if (cols.length < 9) continue;
    byUrl[cols[0]] = { title: cols[3], address: cols[4] };
  }
  return byUrl;
}

function scoreListing(l, meta) {
  const title = meta?.title || '';
  const baseline = DISTRICT_BASELINE[l.district] || 1200;
  const pricePerPing = l.price / l.size;
  const discount = 1 - pricePerPing / baseline;

  let score = 0;

  score += discount * 40;

  if (l.size >= 25) score += 2.5;
  else if (l.size >= 20) score += 2;
  else if (l.size >= 15) score += 1.5;
  else if (l.size >= 12) score += 1;
  else if (l.size >= 10) score += 0.5;

  if (l.rooms >= 2 && l.halls >= 1) score += 1.5;
  else if (l.rooms >= 1 && l.halls >= 1) score += 0.5;

  if (/社宅|社會住宅|社會宅|租補|包租代管/.test(title)) score += 1;

  if (/電梯|大樓|華廈|管理|警衛/.test(title)) score += 0.5;

  if (/近捷運|捷運站|距.{1,4}站/.test(title)) score += 0.3;

  score += DISTRICT_BONUS[l.district] || 0;

  return {
    ...l,
    title,
    price_per_ping: Math.round(pricePerPing),
    baseline,
    discount: Math.round(discount * 100),
    score: Math.round(score * 10) / 10,
  };
}

function main() {
  const rows = parsePipeline();
  const history = parseHistory();
  const scored = rows.map(r => scoreListing(r, history[r.url])).sort((a, b) => b.score - a.score);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Phase 1.5 排序 — ${scored.length} 筆候選`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log('Top 30 （按綜合分排序）：');
  for (const l of scored.slice(0, 30)) {
    const score = l.score.toFixed(1).padStart(5);
    const dist = l.district.padEnd(4);
    const price = String(l.price).padStart(6);
    const size = String(l.size).padStart(5);
    const ppp = String(l.price_per_ping).padStart(5);
    const disc = `${l.discount >= 0 ? '-' : '+'}${Math.abs(l.discount)}%`.padStart(5);
    console.log(`  ${score}  ${dist} ${price}元 ${size}坪 單坪${ppp}(${disc})  ${l.type.slice(0, 14).padEnd(14)}  ${l.title.slice(0, 28)}`);
  }

  const byDist = {};
  for (const s of scored) (byDist[s.district] = byDist[s.district] || []).push(s);
  console.log('\n各區 Top 3：');
  for (const [d, ls] of Object.entries(byDist).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${d} (${ls.length} 筆):`);
    for (const l of ls.slice(0, 3)) {
      console.log(`  ${l.score.toFixed(1).padStart(5)}  ${String(l.price).padStart(6)}元 ${String(l.size).padStart(5)}坪 單坪${String(l.price_per_ping).padStart(5)}  ${l.title.slice(0, 36)}`);
    }
  }

  if (process.argv.includes('--rewrite')) {
    const header = `# Pipeline Inbox\n\nPaste listing URLs here, one per line. Claude will process them in order.\n\n## Pending (sorted by Phase 1.5 score desc)\n`;
    const lines = scored.map(l =>
      `- [ ] ${l.url} | 591 | ${l.district} | 租 | ${l.price.toLocaleString()}元/月 | ${l.size}坪 | ${l.type}  <!-- score=${l.score.toFixed(1)} ppp=${l.price_per_ping} -->`
    );
    writeFileSync(resolve(ROOT, 'data/pipeline.md'), header + lines.join('\n') + '\n');
    console.log(`\n✓ pipeline.md 已依分數降序重寫`);
  }

  const top3perDist = Object.values(byDist).flatMap(ls => ls.slice(0, 3));
  writeFileSync(resolve(ROOT, 'data/top3-per-district.txt'),
    top3perDist.map(l => l.url).join('\n') + '\n');
  console.log(`\n✓ Top 3 per district 寫入 data/top3-per-district.txt (${top3perDist.length} 筆)`);
}

main();

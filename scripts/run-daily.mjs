#!/usr/bin/env node
// run-daily.mjs — daily orchestrator: scan → eval today's NEW items → write daily report.
//
// Output:
//   reports/daily/YYYY-MM-DD.md   — per-day summary
//   reports/NNN-*.md              — individual evaluation reports for today's new items
//   data/scan-history.tsv         — updated with new/refreshed/expired/price_changed
//   data/pipeline.md              — overwritten (today's qualified, sorted by scan order)
//   data/logs/daily.out.log       — launchd stdout capture

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { renderDailyHtml } from './render-daily-html.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const DAILY_DIR = resolve(ROOT, 'reports/daily');
const SCAN_CACHE = resolve(ROOT, 'data/last-scan.json');
if (!existsSync(DAILY_DIR)) mkdirSync(DAILY_DIR, { recursive: true });

const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 100 * 1024 * 1024 });

function runScan() {
  console.error(`[daily] === Scan ===`);
  const out = run(`node ${resolve(ROOT, 'scripts/scan-591.mjs')} --json`);
  const jsonLine = out.trim().split('\n').pop();
  const scan = JSON.parse(jsonLine);
  writeFileSync(SCAN_CACHE, JSON.stringify(scan, null, 2));
  console.error(`[daily] cached scan → ${SCAN_CACHE}`);
  return scan;
}

function loadCachedScan() {
  if (!existsSync(SCAN_CACHE)) {
    console.error(`[daily] ERROR: no cached scan at ${SCAN_CACHE}`);
    console.error(`[daily] --dry-run needs at least one real run first to populate the cache.`);
    process.exit(1);
  }
  const scan = JSON.parse(readFileSync(SCAN_CACHE, 'utf8'));
  console.error(`[daily] loaded cached scan (${scan.newItems?.length ?? 0} newItems, ${scan.totalFound} totalFound)`);
  return scan;
}

function findTodayReports() {
  const re = new RegExp(`^\\d{3}-.*-${TODAY}\\.md$`);
  return readdirSync(resolve(ROOT, 'reports')).filter(f => re.test(f));
}

function runEvalOnNewItems(newItems) {
  if (!newItems.length) {
    console.error(`[daily] 今日無新物件，略過 Phase 2 詳評`);
    return [];
  }
  console.error(`[daily] === Phase 2: 評估 ${newItems.length} 筆新物件 ===`);
  const listFile = resolve(tmpdir(), `daily-new-urls-${TODAY}.txt`);
  writeFileSync(listFile, newItems.map(l => l.url).join('\n'));

  const reportsBefore = new Set(readdirSync(resolve(ROOT, 'reports')).filter(f => /^\d{3}-/.test(f)));
  try {
    execSync(`node ${resolve(ROOT, 'scripts/eval-591.mjs')} --from-file ${listFile}`, {
      stdio: 'inherit', maxBuffer: 100 * 1024 * 1024,
    });
  } catch (e) {
    console.error(`[daily] eval 部分失敗：${e.message}`);
  }
  const reportsAfter = readdirSync(resolve(ROOT, 'reports')).filter(f => /^\d{3}-/.test(f));
  return reportsAfter.filter(f => !reportsBefore.has(f));
}

function extractReportScore(reportFile) {
  const content = readFileSync(resolve(ROOT, 'reports', reportFile), 'utf8');
  const scoreM = content.match(/\*\*Score:\*\*\s*([\d.]+)/);
  const rentM = content.match(/月租：([\d,]+)\s*元/);
  const sizeM = content.match(/坪數：([\d.]+)\s*坪/);
  const layoutM = content.match(/格局：(\d+)房(\d+)廳(\d+)?衛/);
  const addrM = content.match(/地址：([^\n]+)/);
  const urlM = content.match(/\*\*URL:\*\*\s*(\S+)/);
  const dbM = content.match(/## ⚠️ Deal-Breaker/);
  return {
    file: reportFile,
    score: scoreM ? parseFloat(scoreM[1]) : null,
    rent: rentM ? parseInt(rentM[1].replace(/,/g, '')) : null,
    size: sizeM ? parseFloat(sizeM[1]) : null,
    rooms: layoutM ? parseInt(layoutM[1]) : null,
    halls: layoutM ? parseInt(layoutM[2]) : null,
    baths: layoutM?.[3] ? parseInt(layoutM[3]) : null,
    address: addrM ? addrM[1].trim() : '',
    url: urlM ? urlM[1].trim() : '',
    hasDealBreaker: !!dbM,
  };
}

const DIST_FROM_ADDR = (a) => (a.match(/(板橋區|中和區|三重區|中正區|大同區|中山區|松山區|大安區|萬華區|信義區|士林區|南港區|內湖區|北投區|文山區)/) || [null])[0] || '?';

function buildDailyData(scan, newReports) {
  const reportsData = newReports
    .map(f => extractReportScore(f))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const byDistrict = {};
  for (const l of scan.newItems) byDistrict[l.district] = (byDistrict[l.district] || 0) + 1;
  return { reportsData, byDistrict };
}

function writeDailyReport(scan, data) {
  const { reportsData, byDistrict } = data;
  const tag = s => s == null ? '⚪' : s >= 4.0 ? '🟢' : s >= 3.5 ? '🟡' : '🔴';

  const lines = [];
  lines.push(`# 每日推薦 — ${TODAY}`);
  lines.push('');
  lines.push('## 摘要');
  lines.push(`- 掃描 URL：${scan.searchUrls} 組`);
  lines.push(`- 物件找到：${scan.totalFound}`);
  lines.push(`- 快篩通過：${scan.qualified.length}`);
  lines.push(`- **今日新物件：${scan.newItems.length} 筆**（全數評估）`);
  lines.push(`- 既有仍在架：${scan.refreshed.length}`);
  lines.push(`- 價格變動：${scan.priceChanged.length}`);
  lines.push(`- 已下架：${scan.expired.length}`);
  lines.push('');

  if (reportsData.length) {
    lines.push(`## 🆕 今日新物件（${reportsData.length} 筆，依分數降序）`);
    lines.push('');
    lines.push('| 分 | 區 | 月租 | 坪數 | 格局 | ⚠️ | 報告 | 591 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of reportsData) {
      const district = DIST_FROM_ADDR(r.address);
      const layout = r.rooms != null ? `${r.rooms}房${r.halls}廳${r.baths ?? '?'}衛` : '—';
      const reportLink = `[→](../${r.file.replace(/\.md$/, '.html')})`;
      const urlLink = r.url ? `[591](${r.url})` : '—';
      const alert = r.hasDealBreaker ? '⚠️' : '';
      lines.push(`| ${tag(r.score)} ${(r.score ?? 0).toFixed(1)} | ${district} | ${r.rent?.toLocaleString() ?? '?'} | ${r.size ?? '?'} | ${layout} | ${alert} | ${reportLink} | ${urlLink} |`);
    }
    lines.push('');
  } else {
    lines.push('## 🆕 今日新物件');
    lines.push('');
    lines.push('_無新物件_');
    lines.push('');
  }

  if (scan.priceChanged.length) {
    lines.push('## 💰 價格變動警示');
    lines.push('');
    for (const p of scan.priceChanged) {
      const diff = p.price_num - p.prev_price;
      const pct = Math.round(diff / p.prev_price * 1000) / 10;
      const arrow = diff < 0 ? '⬇️' : '⬆️';
      lines.push(`- ${arrow} **[${p.district}]** ${p.prev_price.toLocaleString()} → ${p.price_num.toLocaleString()} 元（${diff > 0 ? '+' : ''}${diff.toLocaleString()} / ${pct > 0 ? '+' : ''}${pct}%）— ${p.title}  [591](${p.url})`);
    }
    lines.push('');
  }

  if (scan.expired.length) {
    lines.push(`## 💀 已下架 (${scan.expired.length} 筆)`);
    lines.push('');
    for (const e of scan.expired.slice(0, 30)) {
      const id = e.url.split('/').pop();
      lines.push(`- ${id} — ${e.address} ${e.price_raw}（上次見 ${e.last_seen}）`);
    }
    if (scan.expired.length > 30) lines.push(`- ...(+${scan.expired.length - 30} more, 詳見 data/scan-history.tsv)`);
    lines.push('');
  }

  if (scan.newItems.length) {
    lines.push('## 📊 各區新增');
    lines.push('');
    for (const [d, n] of Object.entries(byDistrict).sort((a, b) => b[1] - a[1])) lines.push(`- ${d}：${n} 筆`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`_Generated by \`scripts/run-daily.mjs\` at ${new Date().toISOString()}_`);

  const path = resolve(DAILY_DIR, `${TODAY}.md`);
  writeFileSync(path, lines.join('\n') + '\n');
  console.error(`\n✓ 日報寫入 ${path}`);
}

function writeDailyReportHtml(scan, data) {
  const html = renderDailyHtml(scan, data, TODAY);
  const path = resolve(DAILY_DIR, `${TODAY}.html`);
  writeFileSync(path, html);
  console.error(`✓ HTML 日報寫入 ${path}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  let scan, newReports;

  if (dryRun) {
    console.error(`[daily] === DRY RUN: re-render from cached scan + today's reports ===`);
    scan = loadCachedScan();
    newReports = findTodayReports();
    console.error(`[daily] found ${newReports.length} individual reports for ${TODAY}`);
  } else {
    scan = runScan();
    newReports = runEvalOnNewItems(scan.newItems);
  }

  const data = buildDailyData(scan, newReports);
  writeDailyReport(scan, data);
  writeDailyReportHtml(scan, data);

  console.error(`\n━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.error(`Daily Run — ${TODAY} 完成${dryRun ? ' (dry-run)' : ''}`);
  console.error(`━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.error(`新物件：${scan.newItems.length} 筆 → ${dryRun ? '重新渲染' : '產'} ${newReports.length} 份報告`);
  console.error(`價格變動：${scan.priceChanged.length} 筆`);
  console.error(`已下架：${scan.expired.length} 筆`);
  console.error(`日報：reports/daily/${TODAY}.md + .html`);
}

main().catch(e => { console.error(e); process.exit(1); });

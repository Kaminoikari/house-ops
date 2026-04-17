#!/usr/bin/env node
// eval-591.mjs — Phase 2 evaluator: pull 591 detail page, verify required features, score.
//
// Usage:
//   node scripts/eval-591.mjs <url> [<url> ...]
//   node scripts/eval-591.mjs --from-pipeline 3      // eval top 3 unchecked items in pipeline.md

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const REPORTS_DIR = resolve(ROOT, 'reports');
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

const run = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

const EXTRACT_JS = `
  (() => {
    const pick = (sel) => { const n = document.querySelector(sel); return n ? (n.innerText || '').trim() : ''; };
    const pickAll = (sel) => Array.from(document.querySelectorAll(sel)).map(n => (n.innerText || '').trim()).filter(Boolean);
    return JSON.stringify({
      url: location.href,
      title: document.title,
      h1: pick('h1'),
      price: pick('.house-price, [class*="price"]'),
      info: pick('.house-info, .detail-info, [class*="info-board"]'),
      facility: pickAll('.facility.service-facility, .facility, [class*="service-facility"]')[0] || '',
      description: pick('.house-condition-content, .introContent, [class*="introduction"], [class*="about"]'),
      location: pick('.location, [class*="location-map"]'),
      agent: pickAll('.info-agent, .agent-name, [class*="agent"], [class*="contact"]')[0] || '',
      allText: (document.body.innerText || '').slice(0, 6000)
    });
  })()
`.replace(/\s+/g, ' ');

function fetchDetail(url) {
  run(`agent-browser open "${url}"`);
  run(`agent-browser wait 2500`);
  const out = run(`agent-browser eval ${JSON.stringify(EXTRACT_JS)}`);
  const first = out.indexOf('"{');
  const last = out.lastIndexOf('}"');
  if (first < 0) throw new Error(`no JSON in output:\n${out.slice(0, 500)}`);
  return JSON.parse(JSON.parse(out.slice(first, last + 2)));
}

function parseInfo(info) {
  const layout = info.match(/(\d+)房(\d+)廳(\d+)?衛?/);
  const size = info.match(/(\d+(?:\.\d+)?)坪/);
  const floor = info.match(/(B?\d+)F\/(\d+)F(公寓|華廈|大樓|電梯大樓|透天|套房)?/);
  const rent = info.match(/([\d,]+)\s*元\/月/);
  const deposit = info.match(/押金([^\s]+)/);
  return {
    rooms: layout ? parseInt(layout[1]) : null,
    halls: layout ? parseInt(layout[2]) : null,
    baths: layout ? (layout[3] ? parseInt(layout[3]) : null) : null,
    size: size ? parseFloat(size[1]) : null,
    floor: floor ? floor[1] : '',
    total_floor: floor ? parseInt(floor[2]) : null,
    building_type: floor ? (floor[3] || '') : '',
    rent: rent ? parseInt(rent[1].replace(/,/g, '')) : null,
    deposit: deposit ? deposit[1] : '',
  };
}

function checkRequired(detail, parsed) {
  const { facility, description, allText, info } = detail;
  const corpus = [facility, description, allText, info].join('\n');
  const checks = {
    陽台: /陽台|露台/.test(corpus),
    廚房: /廚房|流理台|可開伙|可炊|可煮/.test(corpus),
    獨立衛浴: /獨立衛浴|衛浴|獨洗|獨立洗手間/.test(corpus) || (parsed.baths != null && parsed.baths >= 1),
    客廳: parsed.halls != null && parsed.halls >= 1,
  };
  return checks;
}

function checkDealBreakers(detail, parsed) {
  const { description, allText, title } = detail;
  const corpus = [title, description, allText].join('\n');
  const hits = [];
  if (/頂樓加蓋|違建加蓋/.test(corpus)) hits.push('頂樓加蓋');
  if (/地下室/.test(corpus) || /^B\d+$/.test(parsed.floor)) hits.push('地下室');
  if (/雅房/.test(corpus)) hits.push('雅房');
  if (/分租|合租/.test(corpus)) hits.push('分租/合租');
  if (parsed.floor === '1') hits.push('一樓');
  if (parsed.building_type === '公寓' && !/電梯/.test(detail.facility)) hits.push('公寓(無電梯)');
  return hits;
}

function scoreFiveDim(detail, parsed, required, dealBreakers) {
  const features = Object.values(required).filter(Boolean).length;
  const hasElevator = /電梯/.test(detail.facility);
  const hasBalcony = required.陽台;
  const isSocialHousing = /社會住宅|社宅|租金補貼/.test(detail.info);
  const pricePer坪 = parsed.rent && parsed.size ? parsed.rent / parsed.size : null;

  const score = (dim, s) => ({ dim, score: Math.max(0, Math.min(5, s)) });
  const scores = [];

  let price = 3;
  if (pricePer坪 != null) {
    if (pricePer坪 < 700) price = 4.5;
    else if (pricePer坪 < 900) price = 4;
    else if (pricePer坪 < 1100) price = 3.5;
    else if (pricePer坪 < 1400) price = 3;
    else price = 2;
  }
  if (isSocialHousing) price += 0.5;
  scores.push(score('價格合理性', price));

  let space = 3;
  if (parsed.size) {
    if (parsed.size >= 25) space = 4.5;
    else if (parsed.size >= 20) space = 4;
    else if (parsed.size >= 15) space = 3.5;
    else if (parsed.size >= 10) space = 3;
    else space = 2;
  }
  if (parsed.rooms && parsed.halls && parsed.rooms >= 2 && parsed.halls >= 1) space += 0.3;
  scores.push(score('空間與格局', space));

  let life = 3;
  const corpus = detail.allText;
  if (/捷運|捷運站/.test(corpus)) life += 0.7;
  if (/國小|學區/.test(corpus)) life += 0.2;
  if (/市場|夜市|商圈/.test(corpus)) life += 0.3;
  scores.push(score('區域生活機能', life));

  let cond = 3;
  if (hasElevator) cond += 0.5;
  if (hasBalcony) cond += 0.3;
  if (features === 4) cond += 0.5;
  if (parsed.total_floor && parsed.total_floor >= 7) cond += 0.3;
  if (/新裝潢|全新|裝潢|翻新/.test(corpus)) cond += 0.3;
  scores.push(score('物件條件', cond));

  let risk = 3;
  if (isSocialHousing) risk += 1;
  if (dealBreakers.length) risk -= dealBreakers.length * 0.8;
  if (parsed.building_type && parsed.building_type !== '公寓') risk += 0.3;
  scores.push(score('風險與潛力', risk));

  const weights = { '價格合理性': 0.30, '空間與格局': 0.20, '區域生活機能': 0.25, '物件條件': 0.15, '風險與潛力': 0.10 };
  const weighted = scores.reduce((a, s) => a + s.score * weights[s.dim], 0);
  return { scores, total: Math.round(weighted * 10) / 10 };
}

function slugify(addr) {
  return (addr || 'unknown')
    .replace(/板橋區-?/, '')
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'unknown';
}

function nextReportNum() {
  const existing = readdirSync(REPORTS_DIR).filter(f => /^\d{3}-/.test(f));
  if (!existing.length) return '001';
  const max = Math.max(...existing.map(f => parseInt(f.slice(0, 3))));
  return String(max + 1).padStart(3, '0');
}

function writeReport(detail, parsed, required, dealBreakers, scoring) {
  const num = nextReportNum();
  const corpus = `${detail.info}\n${detail.location}\n${detail.allText}`;
  const addrMatch = corpus.match(/板橋區[-\s]*[^\s\n|]{2,30}/);
  const addr = addrMatch ? addrMatch[0].replace(/\s+/g, '').replace(/^板橋區-?/, '板橋區-') : '板橋區';
  const slug = slugify(addr);
  const fname = `${num}-banqiao-${slug}-${TODAY}.md`;
  const fpath = resolve(REPORTS_DIR, fname);

  const passList = Object.entries(required).map(([k, v]) => `- ${v ? '✅' : '❌'} ${k}`).join('\n');
  const scoreLines = scoring.scores.map(s => `- ${s.dim}：**${s.score.toFixed(1)}**／5`).join('\n');
  const verdict = scoring.total >= 4.0 ? '✅ 推薦看屋'
    : scoring.total >= 3.5 ? '⚠️ 持保留態度'
    : '❌ 不建議追蹤';

  const body = `# ${num} — ${detail.h1 || detail.title.split(' - ')[0]}

**URL:** ${detail.url}
**Score:** ${scoring.total.toFixed(1)}/5
**Type:** rent
**Status:** Evaluated
**Verification:** confirmed
**評估日期:** ${TODAY}

---

## 基本資訊
- 地址：${addr}
- 月租：${parsed.rent ? parsed.rent.toLocaleString() + ' 元' : '?'}（押金 ${parsed.deposit || '?'}）
- 坪數：${parsed.size ?? '?'} 坪　·　單坪租金：${parsed.rent && parsed.size ? Math.round(parsed.rent / parsed.size) + ' 元/坪' : '?'}
- 格局：${parsed.rooms ?? '?'}房${parsed.halls ?? '?'}廳${parsed.baths ?? '?'}衛
- 樓層：${parsed.floor || '?'} / ${parsed.total_floor ?? '?'}F
- 建物類型：${parsed.building_type || '未標示'}

---

## 必要設備檢查
${passList}

${dealBreakers.length ? `## ⚠️ Deal-Breaker 命中\n${dealBreakers.map(d => `- ${d}`).join('\n')}\n\n---\n` : ''}
## 五維度評分
${scoreLines}

**總分：${scoring.total.toFixed(1)} / 5 → ${verdict}**

---

## 設備清單（591 原始）
\`\`\`
${detail.facility || '(無資料)'}
\`\`\`

## 屋況介紹
${detail.description || '_591 未提供屋況介紹_'}

---

## 疑點清單（看屋時必問）
- 總樓層 ${parsed.total_floor ?? '?'} 樓：${parsed.total_floor && parsed.total_floor <= 5 ? '確認是否公寓（無電梯）' : '確認電梯維護費與管委會規則'}
- ${required.陽台 ? '陽台對外可用性、是否外推' : '**詳情頁未提及陽台，實地確認**'}
- ${required.廚房 ? '廚房是否可開伙、油煙處理' : '**未確認可開伙，詢問房東**'}
- ${required.獨立衛浴 ? '衛浴乾濕分離、對外窗、排水' : '**獨立衛浴未確認**'}
- 管理費、水電費、第四台網路分擔方式
- 寵物條款、垃圾收取時間
- 合約年限、續約條件、提前解約違約金
- 押金返還條件

## 議價策略
- 社會住宅類：通常以政府定價，議價空間低，重點在審核速度
- 一般物件：可從單坪租金切入（本案 ${parsed.rent && parsed.size ? Math.round(parsed.rent / parsed.size) : '?'} 元/坪），板橋區 2024 均值約 900-1100 元/坪
- 缺陷切入點：${dealBreakers.join('、') || '無重大瑕疵可談'}

---

_此報告由 eval-591.mjs 自動產生，需搭配實地看屋驗證。_
`;

  writeFileSync(fpath, body);
  return fname;
}

async function evalOne(url) {
  console.log(`\n▸ 評估 ${url}`);
  const detail = fetchDetail(url);
  if (!detail.info || detail.info.length < 50) {
    console.log(`  ⚠️ 詳情頁內容過少，可能已下架或需登入：${detail.info?.slice(0, 100)}`);
    return null;
  }
  const parsed = parseInfo(detail.info);
  const required = checkRequired(detail, parsed);
  const dealBreakers = checkDealBreakers(detail, parsed);
  const scoring = scoreFiveDim(detail, parsed, required, dealBreakers);
  const fname = writeReport(detail, parsed, required, dealBreakers, scoring);

  const reqLine = Object.entries(required).map(([k, v]) => `${v ? '✅' : '❌'}${k}`).join(' ');
  console.log(`  ${parsed.rent?.toLocaleString()}元 ${parsed.size}坪 ${parsed.rooms}房${parsed.halls}廳${parsed.baths ?? '?'}衛 ${parsed.building_type}`);
  console.log(`  必要設備: ${reqLine}`);
  if (dealBreakers.length) console.log(`  ⚠️ deal-breaker: ${dealBreakers.join(', ')}`);
  console.log(`  分數: ${scoring.total.toFixed(1)}/5 → reports/${fname}`);
  return { url, fname, score: scoring.total, dealBreakers };
}

async function main() {
  const args = process.argv.slice(2);
  let urls = [];
  if (args[0] === '--from-pipeline') {
    const n = parseInt(args[1] || '3');
    const pipe = readFileSync(resolve(ROOT, 'data/pipeline.md'), 'utf8');
    urls = [...pipe.matchAll(/^- \[ \] (https:\/\/rent\.591\.com\.tw\/\d+)/gm)].map(m => m[1]).slice(0, n);
  } else {
    urls = args;
  }
  if (!urls.length) {
    console.error('Usage: node scripts/eval-591.mjs <url> [<url> ...] OR --from-pipeline <n>');
    process.exit(1);
  }
  const results = [];
  for (const u of urls) {
    try {
      const r = await evalOne(u);
      if (r) results.push(r);
    } catch (e) {
      console.error(`✗ ${u}: ${e.message}`);
    }
  }
  results.sort((a, b) => b.score - a.score);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('批次評估完成');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const r of results) {
    const tag = r.score >= 4.0 ? '🟢' : r.score >= 3.5 ? '🟡' : '🔴';
    console.log(`${tag} ${r.score.toFixed(1)}  ${r.fname}${r.dealBreakers.length ? '  ⚠️ ' + r.dealBreakers.join(',') : ''}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

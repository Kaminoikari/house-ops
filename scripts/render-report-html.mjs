// render-report-html.mjs — convert a single property evaluation report (.md) into a
// standalone, styled HTML page for human reading. Called from eval-591.mjs during
// evaluation, and from scripts/convert-reports-html.mjs for batch backfill.

import { marked } from 'marked';

function parseHeader(md) {
  const titleM = md.match(/^#\s+(.+)$/m);
  const title = titleM ? titleM[1].trim() : 'Untitled';
  const meta = {};
  for (const m of md.matchAll(/^\*\*([^:]+?):\*\*\s*(.+)$/gm)) {
    meta[m[1].trim()] = m[2].trim();
  }
  return { title, meta };
}

function splitSections(md) {
  const lines = md.split('\n');
  const sections = {};
  let current = null;
  let buffer = [];
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      if (current !== null) sections[current] = buffer.join('\n').trim();
      current = h2[1].trim();
      buffer = [];
    } else if (/^---+\s*$/.test(line)) {
      continue;
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  if (current !== null) sections[current] = buffer.join('\n').trim();
  return sections;
}

function parseInfoList(text) {
  const out = {};
  for (const m of text.matchAll(/^-\s+([^：]+)：(.+)$/gm)) {
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function parseDimScores(text) {
  const out = [];
  for (const m of text.matchAll(/^-\s+([^：]+)：\*\*([\d.]+)\*\*/gm)) {
    out.push({ dim: m[1].trim(), score: parseFloat(m[2]) });
  }
  return out;
}

function parseRequired(text) {
  const out = [];
  for (const m of text.matchAll(/^-\s+(✅|❌)\s+(.+)$/gm)) {
    out.push({ ok: m[1] === '✅', name: m[2].trim() });
  }
  return out;
}

function parseBullets(text) {
  const out = [];
  for (const m of text.matchAll(/^-\s+(.+)$/gm)) out.push(m[1].trim());
  return out;
}

function extractFacility(text) {
  const m = text.match(/```\s*\n([\s\S]*?)\n```/);
  return m ? m[1].trim() : '';
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderReportHtml(md) {
  const { title, meta } = parseHeader(md);
  const sections = splitSections(md);

  const score = parseFloat(meta['Score']?.match(/[\d.]+/)?.[0] || '0');
  const scoreBand = score >= 4.0 ? 'green' : score >= 3.5 ? 'yellow' : 'red';
  const verdict = score >= 4.0 ? '✅ 推薦看屋' : score >= 3.5 ? '⚠️ 持保留態度' : '❌ 不建議追蹤';

  const info = parseInfoList(sections['基本資訊'] || '');
  const dims = parseDimScores(sections['五維度評分'] || '');
  const required = parseRequired(sections['必要設備檢查'] || '');
  const dealBreakers = parseBullets(sections['⚠️ Deal-Breaker 命中'] || '');
  const dueDiligence = parseBullets(sections['疑點清單（看屋時必問）'] || '');
  const negotiation = parseBullets(sections['議價策略'] || '');
  const facility = extractFacility(sections['設備清單（591 原始）'] || '');
  const description = sections['屋況介紹'] || '';

  const url = meta['URL'] || '';
  const s591 = url ? url.split('/').pop() : '';
  const date = meta['評估日期'] || '';
  const dailyLink = date ? `daily/${date}.html` : '';

  const descHtml = description && description !== '_591 未提供屋household介紹_' && description !== '_591 未提供屋況介紹_'
    ? marked.parse(description, { breaks: true, gfm: true })
    : '<p class="muted">_591 未提供屋況介紹_</p>';

  const maxDim = Math.max(5, ...dims.map(d => d.score));

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="container">

<nav class="topnav">
  ${dailyLink ? `<a href="${dailyLink}" class="back">← 返回 ${date} 日報</a>` : '<span></span>'}
  ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="btn primary">591 原頁 ↗</a>` : ''}
</nav>

<header class="hero">
  <h1>${escapeHtml(title)}</h1>
  <div class="hero-meta">
    <div class="score-badge score-${scoreBand}">
      <div class="score-num">${score.toFixed(1)}</div>
      <div class="score-max">/ 5.0</div>
    </div>
    <div class="verdict">${escapeHtml(verdict)}</div>
    <div class="subtitle">${escapeHtml(meta['Type'] || '')} · ${escapeHtml(meta['Status'] || '')} · 評估日期 ${escapeHtml(date)}</div>
  </div>
</header>

${Object.keys(info).length ? `<section>
  <h2>基本資訊</h2>
  <div class="info-grid">
    ${Object.entries(info).map(([k, v]) => `
      <div class="info-card">
        <div class="info-label">${escapeHtml(k)}</div>
        <div class="info-value">${escapeHtml(v)}</div>
      </div>`).join('')}
  </div>
</section>` : ''}

${dims.length ? `<section>
  <h2>五維度評分</h2>
  <div class="dims">
    ${dims.map(d => `
      <div class="dim-row">
        <div class="dim-label">${escapeHtml(d.dim)}</div>
        <div class="dim-track"><div class="dim-fill" style="width:${(d.score / maxDim * 100).toFixed(0)}%"></div></div>
        <div class="dim-score">${d.score.toFixed(1)}</div>
      </div>`).join('')}
  </div>
</section>` : ''}

${required.length ? `<section>
  <h2>必要設備檢查</h2>
  <div class="checklist">
    ${required.map(r => `<span class="check ${r.ok ? 'ok' : 'no'}">${r.ok ? '✓' : '✗'} ${escapeHtml(r.name)}</span>`).join('')}
  </div>
</section>` : ''}

${dealBreakers.length ? `<section>
  <h2 class="warn">⚠️ Deal-Breaker</h2>
  <div class="alert-red">
    <ul>${dealBreakers.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
  </div>
</section>` : ''}

${description ? `<section>
  <h2>屋況介紹</h2>
  <div class="prose">${descHtml}</div>
</section>` : ''}

${facility ? `<section>
  <h2>591 設備清單</h2>
  <div class="facilities">${facility.split('\n').map(f => f.trim()).filter(Boolean).map(f => `<span class="facility">${escapeHtml(f)}</span>`).join('')}</div>
</section>` : ''}

${dueDiligence.length ? `<section>
  <h2>疑點清單（看屋時必問）</h2>
  <ul class="bullets">${dueDiligence.map(d => `<li>${marked.parseInline(d)}</li>`).join('')}</ul>
</section>` : ''}

${negotiation.length ? `<section>
  <h2>議價策略</h2>
  <ul class="bullets">${negotiation.map(d => `<li>${marked.parseInline(d)}</li>`).join('')}</ul>
</section>` : ''}

<footer>
  <div>此報告由 <code>eval-591.mjs</code> 自動產生，需搭配實地看屋驗證。</div>
  ${url ? `<div><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>` : ''}
</footer>

</div>
</body>
</html>
`;
}

const CSS = `
:root {
  --bg:#fafaf7;--panel:#fff;--ink:#1a1a1a;--muted:#6b7280;--border:#e5e7eb;
  --hover:#f3f4f6;--green:#16a34a;--green-bg:#dcfce7;--yellow:#ca8a04;
  --yellow-bg:#fef3c7;--red:#dc2626;--red-bg:#fee2e2;--blue:#2563eb;--accent:#0f172a;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Helvetica Neue",sans-serif;font-size:15px;line-height:1.65;color:var(--ink);background:var(--bg);margin:0;padding:20px 16px 80px}
.container{max-width:800px;margin:0 auto}
.topnav{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;font-size:14px}
.back{color:var(--muted);text-decoration:none}
.back:hover{color:var(--blue)}
.btn{display:inline-block;padding:5px 12px;font-size:13px;border:1px solid var(--border);border-radius:6px;color:var(--ink);text-decoration:none;background:#fff;transition:all .1s}
.btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn.primary{background:var(--blue);color:#fff;border-color:var(--blue)}
.btn.primary:hover{background:#1d4ed8}
.hero{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px 28px 24px;margin-bottom:24px}
.hero h1{font-size:22px;font-weight:600;margin:0 0 18px;letter-spacing:-0.01em;line-height:1.3}
.hero-meta{display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.score-badge{display:flex;align-items:baseline;gap:3px;padding:8px 16px;border-radius:10px;font-weight:700}
.score-badge.score-green{background:var(--green-bg);color:var(--green)}
.score-badge.score-yellow{background:var(--yellow-bg);color:var(--yellow)}
.score-badge.score-red{background:var(--red-bg);color:var(--red)}
.score-num{font-size:28px;font-variant-numeric:tabular-nums}
.score-max{font-size:14px;opacity:.7}
.verdict{font-size:16px;font-weight:600}
.subtitle{color:var(--muted);font-size:13px;width:100%;margin-top:4px}
section{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px 24px 20px;margin-bottom:16px}
h2{font-size:16px;font-weight:600;margin:0 0 14px;color:var(--accent)}
h2.warn{color:var(--red)}
.info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.info-card{padding:10px 14px;background:#f9fafb;border-radius:8px}
.info-label{font-size:11px;color:var(--muted);letter-spacing:0.03em;text-transform:uppercase;margin-bottom:3px}
.info-value{font-size:14px;font-weight:500}
.dims{display:grid;gap:10px}
.dim-row{display:grid;grid-template-columns:120px 1fr 40px;align-items:center;gap:12px;font-size:14px}
.dim-track{height:8px;background:#f3f4f6;border-radius:4px;overflow:hidden}
.dim-fill{height:100%;background:linear-gradient(90deg,var(--blue),#60a5fa);border-radius:4px}
.dim-score{font-variant-numeric:tabular-nums;font-weight:600;text-align:right}
.checklist{display:flex;flex-wrap:wrap;gap:8px}
.check{display:inline-block;padding:4px 10px;border-radius:6px;font-size:13px;font-weight:500}
.check.ok{background:var(--green-bg);color:var(--green)}
.check.no{background:var(--red-bg);color:var(--red)}
.alert-red{background:var(--red-bg);border-left:3px solid var(--red);padding:10px 16px;border-radius:6px}
.alert-red ul{margin:0;padding-left:20px;color:var(--red)}
.alert-red li{font-weight:500}
.prose{font-size:14px;line-height:1.8;color:#374151}
.prose p{margin:0.6em 0}
.prose strong{color:var(--ink)}
.prose h1,.prose h2,.prose h3{font-size:15px;font-weight:600;margin:1em 0 0.4em;color:var(--ink)}
.prose ul,.prose ol{padding-left:22px;margin:0.5em 0}
.prose li{margin:0.2em 0}
.prose a{color:var(--blue);text-decoration:none}
.prose a:hover{text-decoration:underline}
.prose code{background:#f3f4f6;padding:1px 5px;border-radius:3px;font-size:13px;font-family:"SF Mono",Menlo,monospace}
.prose pre{background:#1a1a1a;color:#e5e7eb;padding:12px 16px;border-radius:8px;overflow-x:auto;font-size:13px}
.prose hr{border:0;border-top:1px solid var(--border);margin:1.2em 0}
.facilities{display:flex;flex-wrap:wrap;gap:6px}
.facility{display:inline-block;padding:3px 10px;background:#f3f4f6;border-radius:12px;font-size:12px;color:var(--ink)}
.bullets{margin:0;padding-left:22px;font-size:14px;line-height:1.7}
.bullets li{margin:0.3em 0}
.bullets strong{color:var(--red)}
.muted{color:var(--muted);font-style:italic}
footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--border);font-size:12px;color:var(--muted);text-align:center}
footer code{font-family:"SF Mono",Menlo,monospace;font-size:11px}
footer a{color:var(--muted);text-decoration:none;word-break:break-all}
footer a:hover{color:var(--blue)}
@media (max-width:640px){
  body{padding:16px 12px 60px}
  .hero{padding:20px}
  .hero h1{font-size:18px}
  .score-num{font-size:24px}
  section{padding:16px 18px}
  .dim-row{grid-template-columns:90px 1fr 36px;font-size:13px}
}
`;

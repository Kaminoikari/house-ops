#!/usr/bin/env node
// convert-reports-html.mjs — one-shot: generate .html for every existing .md
// report in reports/. Safe to re-run; overwrites existing .html.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReportHtml } from './render-report-html.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS_DIR = resolve(ROOT, 'reports');

const force = process.argv.includes('--force');

const mds = readdirSync(REPORTS_DIR).filter(f => /^\d{3}-.*\.md$/.test(f));
console.log(`Found ${mds.length} .md reports`);

let converted = 0, skipped = 0, errored = 0;
for (const mdFile of mds) {
  const htmlFile = mdFile.replace(/\.md$/, '.html');
  const mdPath = resolve(REPORTS_DIR, mdFile);
  const htmlPath = resolve(REPORTS_DIR, htmlFile);

  if (!force) {
    try {
      const htmlStat = statSync(htmlPath);
      const mdStat = statSync(mdPath);
      if (htmlStat.mtimeMs >= mdStat.mtimeMs) { skipped++; continue; }
    } catch {}
  }

  try {
    const md = readFileSync(mdPath, 'utf8');
    const html = renderReportHtml(md);
    writeFileSync(htmlPath, html);
    converted++;
  } catch (e) {
    console.error(`✗ ${mdFile}: ${e.message}`);
    errored++;
  }
}

console.log(`Converted: ${converted}  Skipped (up-to-date): ${skipped}  Errored: ${errored}`);

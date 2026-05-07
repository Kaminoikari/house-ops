#!/usr/bin/env node
// migrate-history-add-source.mjs — one-shot: add source + external_id columns to scan-history.tsv.
// Idempotent: re-running on a migrated file is a no-op.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_PATH = resolve(ROOT, 'data/scan-history.tsv');
const BACKUP_PATH  = resolve(ROOT, 'data/scan-history.tsv.bak');

const NEW_HEADER = [
  'url', 'first_seen', 'last_seen', 'source', 'portal', 'external_id',
  'title', 'address', 'normalized_address', 'price', 'size', 'status', 'price_history',
];

function externalIdFromUrl(url) {
  const tail = url.split('/').filter(Boolean).pop() || '';
  return tail.split('?')[0];
}

function main() {
  if (!existsSync(HISTORY_PATH)) {
    console.error('[migrate] scan-history.tsv 不存在，無需遷移');
    return;
  }
  const raw = readFileSync(HISTORY_PATH, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) { console.error('[migrate] empty file, skip'); return; }

  const header = lines[0].split('\t');
  if (header.includes('source') && header.includes('external_id')) {
    console.error('[migrate] 已是新 schema，no-op');
    return;
  }

  copyFileSync(HISTORY_PATH, BACKUP_PATH);
  console.error(`[migrate] 已備份至 ${BACKUP_PATH}`);

  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out = [NEW_HEADER.join('\t')];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const url = cols[idx.url] || '';
    const row = {
      url,
      first_seen: cols[idx.first_seen] || '',
      last_seen:  cols[idx.last_seen]  || cols[idx.first_seen] || '',
      source:     '591',
      portal:     cols[idx.portal] || '591 租屋',
      external_id: externalIdFromUrl(url),
      title:      cols[idx.title] || '',
      address:    cols[idx.address] || '',
      normalized_address: cols[idx.normalized_address] || '',
      price:      cols[idx.price] || '',
      size:       cols[idx.size] || '',
      status:     cols[idx.status] || '',
      price_history: cols[idx.price_history] || '',
    };
    out.push(NEW_HEADER.map(k => String(row[k] ?? '')).join('\t'));
  }
  writeFileSync(HISTORY_PATH, out.join('\n') + '\n');
  console.error(`[migrate] 完成：${out.length - 1} 筆，新增 source + external_id 欄位`);
}

main();

// notify-email.mjs — send daily report via Gmail SMTP using nodemailer.
//
// Required environment variables:
//   GMAIL_USER          — Gmail address used as SMTP login & From header
//   GMAIL_APP_PASSWORD  — 16-char app password (https://myaccount.google.com/apppasswords)
//   NOTIFY_EMAIL_TO     — recipient address (can equal GMAIL_USER for self-send)
//
// If any of the three are missing, sendDailyEmail returns { ok: false, reason }
// without throwing — daily run must not fail because of email config.

import { readFileSync, existsSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { marked } from 'marked';

// Render markdown into static HTML with inline-style table, suitable for Gmail/Outlook
// (which strip <script> and aggressively sanitize <style>). Tables are rendered inline.
function renderEmailHtml(md, today) {
  const body = marked.parse(md);
  // Inject inline styles into common tags so Gmail keeps them.
  const styled = body
    .replace(/<table>/g, '<table style="border-collapse:collapse;width:100%;font-size:13px;margin:8px 0">')
    .replace(/<th>/g, '<th style="border:1px solid #ddd;padding:6px 10px;background:#f5f5f5;text-align:left;font-weight:600">')
    .replace(/<td>/g, '<td style="border:1px solid #ddd;padding:6px 10px;vertical-align:top">')
    .replace(/<a /g, '<a style="color:#2563eb;text-decoration:underline" ')
    .replace(/<h1>/g, '<h1 style="font-size:24px;margin:16px 0 8px">')
    .replace(/<h2>/g, '<h2 style="font-size:18px;margin:24px 0 10px;padding-bottom:4px;border-bottom:1px solid #eee">')
    .replace(/<h3>/g, '<h3 style="font-size:16px;margin:20px 0 8px;color:#0f172a">')
    .replace(/<h4>/g, '<h4 style="font-size:14px;margin:14px 0 6px;color:#374151">')
    .replace(/<li>/g, '<li style="margin:2px 0">');
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>每日推薦 · ${today}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'PingFang TC','Noto Sans TC','Helvetica Neue',sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;background:#fff;max-width:840px;margin:0 auto;padding:24px">
${styled}
</body></html>`;
}

// Drop the 7th column ("報告") from the listings markdown table so the email
// only shows columns the user can act on (591 link is the last column).
// Daily report markdown table is the only 8-column markdown table in the file.
function removeReportColumn(md) {
  return md.split('\n').map(line => {
    if (!line.startsWith('|') || !line.endsWith('|')) return line;
    const cells = line.slice(1, -1).split('|');
    if (cells.length !== 8) return line;
    cells.splice(6, 1);
    return '|' + cells.join('|') + '|';
  }).join('\n');
}

function maxScoreFromData(data) {
  const scores = (data?.reportsData ?? []).map(r => r.score).filter(s => typeof s === 'number');
  if (!scores.length) return null;
  return Math.max(...scores);
}

export async function sendDailyEmail({ scan, data, today, mdPath, htmlPath }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const to = process.env.NOTIFY_EMAIL_TO;

  if (!user || !pass || !to) {
    const missing = [
      !user && 'GMAIL_USER',
      !pass && 'GMAIL_APP_PASSWORD',
      !to && 'NOTIFY_EMAIL_TO',
    ].filter(Boolean).join(', ');
    return { ok: false, reason: `缺少環境變數：${missing}` };
  }

  if (!existsSync(mdPath)) {
    return { ok: false, reason: `日報 markdown 不存在：${mdPath}` };
  }

  const newCount = scan?.newItems?.length ?? 0;
  const priceChangedCount = scan?.priceChanged?.length ?? 0;
  const maxScore = maxScoreFromData(data);
  const scoreFragment = maxScore != null ? `，最高分 ${maxScore.toFixed(1)}` : '';
  const priceFragment = priceChangedCount ? `，${priceChangedCount} 筆價格變動` : '';
  const subject = `[house-ops] ${today} 日報：${newCount} 筆新物件${scoreFragment}${priceFragment}`;

  const text = readFileSync(mdPath, 'utf8');
  // Drop the "報告" column from the listings table — relative ../*.html links
  // don't resolve in Gmail. 591 column with absolute URLs is preserved.
  const emailMd = removeReportColumn(text);
  const html = renderEmailHtml(emailMd, today);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });

  try {
    await transporter.sendMail({
      from: `house-ops <${user}>`,
      to,
      subject,
      text,
      html,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

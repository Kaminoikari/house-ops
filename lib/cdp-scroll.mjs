// cdp-scroll.mjs — bypass FB anti-automation via CDP Input.synthesizeScrollGesture
// FB 偵測 JS scroll / dispatchKeyEvent，但 synthesizeScrollGesture 模擬實體 trackpad 觸控
// 直接連到 Chrome DevTools Protocol WebSocket（agent-browser 的 connect 9222 不暴露這層）

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

async function fetchTargets() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
  if (!res.ok) throw new Error(`CDP /json HTTP ${res.status}`);
  return await res.json();
}

let cachedWs = null;
let cachedUrl = null;
let msgId = 0;

async function getWs(targetUrlSubstr = 'facebook.com') {
  const targets = await fetchTargets();
  const t = targets.find(x => x.type === 'page' && (x.url || '').includes(targetUrlSubstr))
         || targets.find(x => x.type === 'page');
  if (!t) throw new Error('沒有可用的 page target');
  const wsUrl = t.webSocketDebuggerUrl;
  if (cachedWs && cachedUrl === wsUrl && cachedWs.readyState === 1) return cachedWs;
  if (cachedWs) { try { cachedWs.close(); } catch {} cachedWs = null; }
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (e) => reject(new Error('WS error: ' + (e.message || 'unknown'))), { once: true });
  });
  cachedWs = ws; cachedUrl = wsUrl;
  return ws;
}

function cdpSend(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const onMsg = (event) => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error(`CDP ${method} timeout`));
    }, 10000);
  });
}

/**
 * 用合成觸控手勢往下滾動 (yDistance px)。
 * @param {number} yDistance px to scroll down (positive value)
 * @param {object} opts { x, y, speed }
 */
export async function syntheticScrollDown(yDistance, opts = {}) {
  const { x = 500, y = 400, speed = 800 } = opts;
  const ws = await getWs();
  await cdpSend(ws, 'Input.synthesizeScrollGesture', {
    x, y,
    xDistance: 0,
    yDistance: -Math.abs(yDistance),
    gestureSourceType: 'touch',
    speed,
  });
}

export async function closeCdp() {
  if (cachedWs) { try { cachedWs.close(); } catch {} cachedWs = null; cachedUrl = null; }
}

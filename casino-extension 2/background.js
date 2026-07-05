const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

// ── Toolbar icon (drawn via OffscreenCanvas) ──────────────────────────────────

function drawIcon(size) {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext('2d');
  const s = size;

  // Rounded blue background
  const r = s * 0.18;
  ctx.fillStyle = '#1a73e8';
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(s - r, 0); ctx.quadraticCurveTo(s, 0, s, r);
  ctx.lineTo(s, s - r); ctx.quadraticCurveTo(s, s, s - r, s);
  ctx.lineTo(r, s); ctx.quadraticCurveTo(0, s, 0, s - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // White person: head
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.34, s * 0.17, 0, Math.PI * 2);
  ctx.fill();

  // White person: shoulders
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.9, s * 0.3, Math.PI, 0);
  ctx.fill();

  return ctx.getImageData(0, 0, s, s);
}

function applyIcon() {
  chrome.action.setIcon({
    imageData: { 16: drawIcon(16), 32: drawIcon(32), 48: drawIcon(48), 128: drawIcon(128) }
  });
}

chrome.runtime.onInstalled.addListener(applyIcon);
chrome.runtime.onStartup.addListener(applyIcon);

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  // Сериализуем создание: при нескольких параллельных вызовах Chrome
  // разрешает только один offscreen-документ, остальные упали бы с ошибкой.
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_PARSER'],
      justification: 'Parse HTML pages from admin panel'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

// ── TON address conversion: raw "0:hex" → user-friendly "EQ..." ──────────────
function rawTonToFriendly(raw) {
  const parts = (raw || '').split(':');
  if (parts.length !== 2 || parts[1].length !== 64) return raw;
  const workchain = parseInt(parts[0], 10);
  const hex = parts[1];

  const hashBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) hashBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

  const payload = new Uint8Array(34);
  payload[0] = 0x51; // non-bounceable, mainnet (UQ... format)
  payload[1] = workchain & 0xff;
  payload.set(hashBytes, 2);

  // CRC16-CCITT (XModem, poly 0x1021)
  let crc = 0;
  for (const b of payload) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }

  const full = new Uint8Array(36);
  full.set(payload);
  full[34] = (crc >> 8) & 0xff;
  full[35] = crc & 0xff;

  return btoa(String.fromCharCode(...full)).replace(/\+/g, '-').replace(/\//g, '_');
}

// ── TON sender lookup via tonapi.io ──────────────────────────────────────────
async function fetchTonSenderAddress(txHash) {
  try {
    const resp = await fetch(`https://tonapi.io/v2/blockchain/transactions/${encodeURIComponent(txHash)}`);
    if (!resp.ok) { console.log('[Background] TON: API error', resp.status); return ''; }
    const data = await resp.json();
    // For Jetton (USDT/USDC) transfers the real sender is in decoded_body.from,
    // not in_msg.source (which is only the intermediate Jetton wallet contract).
    let rawAddr = data?.in_msg?.decoded_body?.from ?? data?.in_msg?.source?.address;
    if (rawAddr) {
      const addr = rawTonToFriendly(rawAddr);
      console.log('[Background] TON: адрес найден', addr);
      return addr;
    }
    console.log('[Background] TON: адрес не найден в ответе API');
    return '';
  } catch (e) {
    console.log('[Background] TON: ошибка', e.message);
    return '';
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_TON_SENDER') {
    fetchTonSenderAddress(msg.txHash)
      .then(addr => sendResponse({ addr }))
      .catch(e => sendResponse({ error: e.message }));
    return true; // async response
  }

  // Open tabs in batches from background so popup stays alive
  if (msg.type === 'OPEN_TABS') {
    const urls = msg.urls || [];
    const delay = msg.delay ?? 400;
    const total = urls.length;
    let done = 0;
    const open = () => {
      if (done >= total) return;
      chrome.tabs.create({ url: urls[done], active: false });
      done++;
      chrome.runtime.sendMessage({ type: 'OPEN_TABS_PROGRESS', done, total }).catch(() => {});
      if (done < total) setTimeout(open, delay);
    };
    open();
    return false;
  }

  if (msg.type === 'COLLECT_PLAYER') {
    const reqId = msg.reqId;
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage({ type: 'DO_COLLECT', reqId, email: msg.email });
    });
    return false;
  }

  // Relay from offscreen to popup (translate OFFSCREEN_* → plain types).
  // reqId is threaded through so the popup can correlate concurrent results.
  if (msg.type === 'OFFSCREEN_RESULT') {
    chrome.runtime.sendMessage({ type: 'COLLECTION_RESULT', reqId: msg.reqId, data: msg.data }).catch(() => {});
    return false;
  }
  if (msg.type === 'OFFSCREEN_ERROR') {
    chrome.runtime.sendMessage({ type: 'COLLECTION_ERROR', reqId: msg.reqId, error: msg.error }).catch(() => {});
    return false;
  }
  if (msg.type === 'OFFSCREEN_PROGRESS') {
    chrome.runtime.sendMessage({ type: 'PROGRESS', reqId: msg.reqId, text: msg.text }).catch(() => {});
    return false;
  }
});

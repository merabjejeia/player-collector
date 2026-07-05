const BASE = 'https://lixog.com/ru/admin';

// Бесплатно: tronscan.org → My Account → API Keys
const TRON_API_KEY = '5271d8b9-e878-4842-8a0a-4ec807f574b9';


chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DO_COLLECT') {
    const reqId = msg.reqId;
    collectPlayer(msg.email)
      .then(data => chrome.runtime.sendMessage({ type: 'OFFSCREEN_RESULT', reqId, data }))
      .catch(e => chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', reqId, error: e.message }));
  }
});

function notifyProgress(text) {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROGRESS', text }).catch(() => {});
}

// Logs to the offscreen.html DevTools console (chrome://extensions →
// "Просмотреть представления" → offscreen.html) and mirrors short status
// text to the popup's progress line.
function log(label, detail) {
  if (detail !== undefined) console.log(`[Collector] ${label}`, detail);
  else console.log(`[Collector] ${label}`);
}

async function fetchDoc(url) {
  log('GET', url);
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} при загрузке ${url}`);
  const text = await resp.text();
  return new DOMParser().parseFromString(text, 'text/html');
}

async function collectPlayer(email) {
  console.group(`[Collector] collectPlayer(${email})`);
  try {
    notifyProgress('Поиск игрока...');
    log('Шаг 1/7: поиск игрока по email', email);

    // 1. Find player
    const listDoc = await fetchDoc(`${BASE}/app/user/list?filter[user_guess][value]=${encodeURIComponent(email)}`);
    const showLink = listDoc.querySelector('tbody tr a.view_link');
    if (!showLink) { log('Игрок не найден'); throw new Error('Игрок не найден: ' + email); }

    const showHref = showLink.getAttribute('href');
    const userIdMatch = showHref.match(/\/app\/user\/(\d+)\/show/);
    if (!userIdMatch) throw new Error('Не удалось извлечь ID игрока');
    const userId = userIdMatch[1];
    log('Найден userId', userId);

    notifyProgress(`Загрузка профиля игрока (ID: ${userId})...`);
    log('Шаг 2/7: загрузка страницы профиля', showHref);

    // 2. Player show page — extracts most fields including sums and withdrawal wallet
    const showDoc = await fetchDoc(`https://lixog.com${showHref}`);
    const row = extractShowPageData(showDoc, `https://lixog.com${showHref}`);
    row['ПП'] = extractFirstDepositBonusStatus(showDoc);
    log('Данные со страницы профиля', row);

    // 3. Deposit list → TX hash → deposit wallet
    notifyProgress('Загрузка депозитов...');
    log('Шаг 3/7: поиск 3 последних депозитов и кошельков отправителя');
    let кошелекДепа = '';
    try {
      const depositListDoc = await fetchDoc(
        `${BASE}/app/invoice-depositinvoice/list?filter[wallet__user][value]=${userId}&filter[_per_page]=250`
      );
      const depositLinks = [...depositListDoc.querySelectorAll('tbody tr a.view_link')].slice(0, 3);

      if (depositLinks.length) {
        const wallets = [];
        for (let index = 0; index < depositLinks.length; index++) {
          notifyProgress(`Загрузка инвойса депозита ${index + 1}/${depositLinks.length}...`);
          const invoiceDoc = await fetchDoc(`https://lixog.com${depositLinks[index].getAttribute('href')}`);
          const methodHint = buildDepositHint(invoiceDoc, row);
          log(`Депозит ${index + 1}: Метод/валюта`, methodHint);

          if (isCryptoMethod(methodHint)) {
            // Крипто-депозит: ищем TX hash → кошелек отправителя
            const txHash = extractTxHash(invoiceDoc, methodHint);
            log(`Депозит ${index + 1}: TX hash`, txHash || '(не найден)');
            if (!txHash) continue;
            notifyProgress(`Поиск кошелька по депозиту ${index + 1}/${depositLinks.length}...`);
            const pageHint = invoiceDoc.body?.textContent.slice(0, 4000) ?? '';
            const chains = detectChains([methodHint, pageHint].join(' '), txHash);
            log(`Депозит ${index + 1}: Порядок проверки сетей`, chains);
            const wallet = await fetchFromAddress(txHash, methodHint, pageHint);
            log(`Депозит ${index + 1}: Кошелек депа`, wallet || '(не найден)');
            if (wallet && !wallets.includes(wallet)) wallets.push(wallet);
          } else {
            // Не крипто: берём номер платёжного счёта напрямую
            const paymentAccount = findInvoiceFieldValue(invoiceDoc, /Номер платёжного счёта/i)
                                || findInvoiceFieldValue(invoiceDoc, /Платёжный счёт/i);
            log(`Депозит ${index + 1}: Номер платёжного счёта`, paymentAccount || '(не найден)');
            if (paymentAccount && !wallets.includes(paymentAccount)) wallets.push(paymentAccount);
          }
        }
        кошелекДепа = wallets.join(', ');
      } else {
        log('У игрока нет депозитов');
      }
    } catch (e) {
      log('Ошибка при поиске кошелька депа', e.message);
    }
    row['Кошелек депа'] = кошелекДепа;

    // 4. Logins → unique ASN, IP, Country, Device
    notifyProgress('Загрузка логинов...');
    log('Шаг 4/7: загрузка логинов (ASN/IP/страна/устройство)');
    const loginsDoc = await fetchDoc(
      `${BASE}/app/userauthentication/list?filter[user][value]=${userId}&filter[_per_page]=250&filter[_sort_by]=createdAt&filter[_sort_order]=DESC`
    );
    const { asns, ips, countries, devices } = extractLoginsData(loginsDoc);
    row['ASN'] = [...asns].join(', ');
    row['IP'] = [...ips].join(', ');
    row['Страна'] = [...countries].join(', ');
    row['Устройство'] = [...devices].join('\n');
    log('ASN/IP/Страна/Устройство', { asn: row['ASN'], ip: row['IP'], страна: row['Страна'], устройство: row['Устройство'] });

    // 5. Game transactions → все уникальные игры (все страницы)
    notifyProgress('Загрузка игровых транзакций...');
    log('Шаг 5/7: загрузка игровых транзакций (все страницы)');
    row['Игра'] = await fetchAllGames(userId);
    log('Игры', row['Игра']);

    // 6. External account ID
    notifyProgress('Загрузка внешнего ID счета...');
    log('Шаг 6/7: внешний ID счета');
    const externalId = await fetchExternalAccountId(showDoc, userId);
    log('Внешний ID счета', externalId || '(не найден, используем userId)');
    row['Внешний ID'] = externalId;

    // 7. Altenar: restriction + sport types
    log('Шаг 7/7: поиск игрока в Altenar → ограничения/спорт');
    notifyProgress('Поиск ограничений в Altenar...');
    const altenarPlayerId = await fetchAltenarPlayerId(externalId || userId);
    if (altenarPlayerId) {
      row['Ограничение'] = await fetchAltenarRestriction(altenarPlayerId);
      log('Ограничение (Altenar)', row['Ограничение'] || '(нет)');
      const { sports, champs } = await fetchAltenarSportTypes(altenarPlayerId);
      row['Спорт'] = sports;
      row['Чемпионат'] = champs;
      log('Спорт/Чемпионат (Altenar)', { sports, champs });
    } else {
      row['Ограничение'] = '';
      row['Спорт'] = '';
      row['Чемпионат'] = '';
    }

    notifyProgress('Готово!');
    log('Готово, итоговая строка', row);
    return row;
  } finally {
    console.groupEnd();
  }
}

// ── Show page ────────────────────────────────────────────────────────────────

function extractShowPageData(doc, pageUrl) {
  const row = {};

  // Пользователь
  const nameEl = doc.querySelector('div.js-default-view[data-userwholename]');
  row['Пользователь'] = nameEl ? nameEl.getAttribute('data-userwholename') : '';

  // Страна (from show page th/td pairs — overwritten later by logins)
  row['_СтранаПрофиль'] = findThNextTdText(doc, 'Страна');

  // Метод — из блока Пополнения, первая строка (col 1)
  const depositsBox = findBoxByTitle(doc, 'Пополнения');
  row['Метод'] = depositsBox
    ? (depositsBox.querySelectorAll('tbody tr:first-child td')[2]?.textContent.trim() ?? '')
    : '';

  // Кошелек вывода — из блока Выводы, col 3 (.js-default-view span)
  const withdrawalsBox = findBoxByTitle(doc, 'Выводы');
  row['Кошелек вывода'] = '';
  if (withdrawalsBox) {
    for (const tr of withdrawalsBox.querySelectorAll('tbody tr')) {
      const tds = tr.querySelectorAll('td');
      const span = tds[3]?.querySelector('.js-default-view span');
      if (span) { row['Кошелек вывода'] = extractTextMaybeCfEmail(span); break; }
    }
  }

  // Сумма депа + Сумма вывода — из Highcharts JSON на show page
  // Highcharts embeds series names as Unicode escapes (\uXXXX); JSON.parse decodes them.
  const { депа, вывода } = extractHighchartsAmounts(doc);
  row['Сумма депа'] = депа;
  row['Сумма вывода'] = вывода;

  // Валюта + Создан — из блока Счета
  // Берём счёт с наибольшим балансом (= активно используемый), а не последний созданный
  const accountsBox = findBoxByTitle(doc, 'Счета');
  row['Валюта'] = '';
  row['Создан'] = '';
  if (accountsBox) {
    let bestCurrency = '';
    let bestBalance = -1;
    for (const tr of accountsBox.querySelectorAll('tbody tr')) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 2) continue;
      const currency = tds[1].textContent.trim();
      if (!currency) continue;
      const balanceRaw = (tds[2]?.textContent ?? '').replace(/[^\d.,-]/g, '').replace(',', '.');
      const balance = parseFloat(balanceRaw) || 0;
      if (balance > bestBalance) { bestBalance = balance; bestCurrency = currency; }
    }
    row['Валюта'] = bestCurrency || (accountsBox.querySelector('tbody tr td:nth-child(2)')?.textContent.trim() ?? '');
    for (const td of accountsBox.querySelectorAll('tbody tr:first-child td')) {
      const text = td.textContent.trim();
      if (/\d{4}/.test(text) && text.length > 8) { row['Создан'] = text; break; }
    }
  }

  row['Ссылка'] = pageUrl;
  return row;
}

// Блок «Бонусы» на странице профиля: берём Статус у строки где Тип === «Первое пополнение»
function extractFirstDepositBonusStatus(doc) {
  const box = findBoxByTitle(doc, 'Бонусы');
  if (!box) { log('ПП: блок «Бонусы» не найден на странице профиля'); return ''; }
  const rows = [...box.querySelectorAll('tbody tr')];
  log('ПП: строк в блоке «Бонусы»', rows.length);
  for (const tr of rows) {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 6) continue;
    const type = tds[4].textContent.trim();
    log('ПП: строка бонуса', { type, status: tds[3].textContent.trim() });
    if (/первое пополнение/i.test(type)) {
      return tds[3].textContent.trim();
    }
  }
  log('ПП: строка с типом «Первое пополнение» не найдена');
  return '';
}

// Cloudflare XOR-декодирование email
function decodeCfEmail(encoded) {
  try {
    const r = parseInt(encoded.substr(0, 2), 16);
    let email = '';
    for (let n = 2; n < encoded.length; n += 2) {
      email += String.fromCharCode(parseInt(encoded.substr(n, 2), 16) ^ r);
    }
    return email;
  } catch (_) {
    return '';
  }
}

function extractTextMaybeCfEmail(el) {
  if (!el) return '';
  const cfEl = el.hasAttribute?.('data-cfemail') ? el : el.querySelector('[data-cfemail]');
  if (cfEl) {
    const decoded = decodeCfEmail(cfEl.getAttribute('data-cfemail'));
    if (decoded) return decoded;
  }
  return el.textContent.trim();
}

function buildDepositHint(invoiceDoc, row) {
  const parts = [
    findThNextTdText(invoiceDoc, 'Платёжный метод'),
    findThNextTdText(invoiceDoc, 'Провайдер'),
    row['Валюта'],
  ].filter(Boolean);
  return parts.join(' ');
}

function readSeriesValue(data) {
  if (!Array.isArray(data) || !data.length) return null;
  const first = data[0];
  let num;
  if (typeof first === 'number') num = first;
  else if (Array.isArray(first)) num = Number(first[first.length - 1]);
  else if (first && typeof first === 'object') num = Number(first.y ?? first.value ?? NaN);
  return Number.isFinite(num) ? num : null;
}

function extractHighchartsAmounts(doc) {
  let депа = '', вывода = '';
  for (const s of doc.querySelectorAll('script')) {
    const text = s.textContent;
    const callIdx = text.indexOf('Highcharts.chart(');
    if (callIdx < 0) continue;

    const braceStart = text.indexOf('{', callIdx);
    if (braceStart < 0) continue;

    let depth = 0, braceEnd = -1;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
    }
    if (braceEnd < 0) continue;

    let config;
    try { config = JSON.parse(text.slice(braceStart, braceEnd + 1)); } catch (_) { continue; }

    const series = config?.series;
    if (!Array.isArray(series)) continue;

    for (const serie of series) {
      const name = String(serie.name ?? '');
      const num = readSeriesValue(serie.data);
      if (num == null) continue;
      if (name.includes('опол')) депа = String(num);
      if (name.includes('ывод')) вывода = String(num);
    }
  }
  return { депа, вывода };
}

function findBoxByTitle(doc, title) {
  for (const box of doc.querySelectorAll('.box')) {
    const header = box.querySelector('.box-title, .box-header h3, .box-header .box-title');
    if (header && header.textContent.trim() === title) return box;
  }
  return null;
}

function findThNextTdText(doc, label) {
  for (const th of doc.querySelectorAll('th')) {
    if (th.textContent.trim() === label) return th.nextElementSibling?.textContent.trim() ?? '';
  }
  return '';
}

// ── Deposit invoice ──────────────────────────────────────────────────────────

function extractTxHash(doc, hint = '') {
  const networkId = findInvoiceFieldValue(doc, /ID\s+Транзакции\s+в\s+сети/i);
  const externalId = findInvoiceFieldValue(doc, /Внешний\s+ID/i);
  const selected = chooseBestTxHash({ networkId, externalId, hint });
  log('Кандидаты txHash', { networkId, externalId, selected, hint });
  return selected;
}

function findInvoiceFieldValue(doc, labelRe) {
  for (const th of doc.querySelectorAll('th')) {
    const label = th.textContent.replace(/\s+/g, ' ').trim();
    if (labelRe.test(label)) {
      const td = th.nextElementSibling;
      if (!td) return '';
      const defaultView = td.querySelector('.js-default-view');
      return extractTextMaybeCfEmail(defaultView ?? td);
    }
  }
  return '';
}

function normalizeTxHash(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const trimmed = raw.replace(/\/\d+$/, '');
  const evm = trimmed.match(/0x[0-9a-fA-F]{64}/);
  if (evm) return evm[0];

  const bare64 = trimmed.match(/\b[0-9a-fA-F]{64}\b/);
  if (bare64) return bare64[0];

  return trimmed;
}

function normalizeEvmTxHash(txHash) {
  const normalized = normalizeTxHash(txHash);
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) return `0x${normalized}`;
  return normalized;
}

function chooseBestTxHash({ networkId = '', externalId = '', hint = '' }) {
  const ranked = [
    rankTxHashCandidate(networkId, 'network', hint),
    rankTxHashCandidate(externalId, 'external', hint)
  ].filter(item => item.normalized);

  ranked.sort((a, b) => b.score - a.score || (a.source === 'network' ? -1 : 1));
  return ranked[0]?.normalized || '';
}

function rankTxHashCandidate(raw, source, hint) {
  const normalized = normalizeTxHash(raw);
  const lowerHint = String(hint || '').toLowerCase();
  let score = source === 'network' ? 2 : 1;

  if (!normalized) return { raw, normalized: '', source, score: -1 };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    return { raw, normalized: '', source, score: -10 };
  }

  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) score += 8;
  else if (/^[0-9a-fA-F]{64}$/.test(normalized)) score += 7;
  else score -= 5;

  if (raw && raw !== normalized) score += 1;

  if (/\berc[\s-]?20\b|\beth\b|ethereum/.test(lowerHint)) {
    if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) score += 6;
    else if (/^[0-9a-fA-F]{64}$/.test(normalized)) score += 4;
  }
  if (/\bbep[\s-]?20\b|\bbsc\b|binance|bnb/.test(lowerHint)) {
    if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) score += 5;
  }
  if (/\btrc[\s-]?20\b|\btrx\b|tron/.test(lowerHint)) {
    if (/^[0-9a-fA-F]{64}$/.test(normalized)) score += 4;
  }
  if (/\bbtc\b|bitcoin|\bltc\b|litecoin/.test(lowerHint)) {
    if (/^[0-9a-fA-F]{64}$/.test(normalized)) score += 3;
  }

  return { raw, normalized, source, score };
}

// Сопоставление метода депозита → слаг сети на OKLink.
// Порядок важен: первое совпадение даёт основную сеть-кандидата.
const CHAIN_HINTS = [
  { re: /trc[\s-]?20|tron|trx/i,          chain: 'trx' },
  { re: /\bton\b|toncoin/i,               chain: 'ton' },
  { re: /erc[\s-]?20|ethereum|\beth\b/i,  chain: 'eth' },
  { re: /\bbase\b|coinbase/i,             chain: 'base' },
  { re: /arbitrum|\barb\b/i,              chain: 'arbitrum' },
  { re: /optimism|\bop\b/i,               chain: 'optimism' },
  { re: /avalanche|\bavax\b/i,            chain: 'avalanche' },
  { re: /bitcoin|\bbtc\b/i,               chain: 'btc' },
  { re: /litecoin|\bltc\b/i,              chain: 'ltc' },
  { re: /bep[\s-]?20|bsc|binance|bnb/i,   chain: 'bsc' },
  { re: /polygon|matic/i,                 chain: 'polygon' },
];

// Публичные JSON-RPC для EVM-цепей (без API-ключа)
const EVM_RPC = {
  eth: [
    'https://ethereum-rpc.publicnode.com',
    'https://rpc.ankr.com/eth',
  ],
  base: [
    'https://mainnet.base.org',
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
  ],
  optimism: [
    'https://mainnet.optimism.io',
  ],
  avalanche: [
    'https://api.avax.network/ext/bc/C/rpc',
  ],
  bsc: [
    'https://bsc-dataseed.binance.org/',
    'https://bsc-rpc.publicnode.com',
  ],
  polygon: [
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon-rpc.com/',
  ],
};

// OKLink слаг → формат адреса отправителя
const CHAIN_ADDR = {
  trx:     /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  ton:     /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/,
  eth:     /^0x[0-9a-fA-F]{40}$/,
  base:    /^0x[0-9a-fA-F]{40}$/,
  arbitrum:/^0x[0-9a-fA-F]{40}$/,
  optimism:/^0x[0-9a-fA-F]{40}$/,
  avalanche:/^0x[0-9a-fA-F]{40}$/,
  bsc:     /^0x[0-9a-fA-F]{40}$/,
  polygon: /^0x[0-9a-fA-F]{40}$/,
  btc:     /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  ltc:     /^(ltc1[a-z0-9]{25,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
};

function isCryptoMethod(hint) {
  return CHAIN_HINTS.some(({ re }) => re.test(hint));
}

// Порядок сетей для проверки: сперва по тексту метода/валюты,
// затем по форме хэша, затем остальные — как запасной вариант.
// Если hint уже идентифицировал UTXO-цепь (BTC/LTC), EVM-fallback не добавляем —
// LTC-хэши bare-hex64 совпадают по форме с TRX/EVM, но реально это другие сети.
function detectChains(hint, txHash) {
  const order = [];
  const add = c => { if (c && CHAIN_ADDR[c] && !order.includes(c)) order.push(c); };
  const isEvmHash = /^0x[0-9a-fA-F]{64}$/.test(txHash);
  const isBareHex64 = /^[0-9a-fA-F]{64}$/.test(txHash);
  const evmFallback = ['eth', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon', 'avalanche'];
  const nonEvmFallback = ['trx', 'btc', 'ltc'];

  for (const { re, chain } of CHAIN_HINTS) {
    if (re.test(hint || '')) add(chain);
  }

  const hasUtxo = order.some(c => c === 'btc' || c === 'ltc');
  if (hasUtxo) return order; // UTXO-цепь точно определена — лишних попыток не нужно

  if (/usdt|usdc|tether/i.test(hint || '')) {
    if (isEvmHash) evmFallback.forEach(add);
    else if (isBareHex64) ['trx', ...evmFallback, 'btc', 'ltc'].forEach(add);
    else { add('trx'); evmFallback.forEach(add); }
  }

  if (isEvmHash) evmFallback.forEach(add);
  else if (isBareHex64) [...evmFallback, ...nonEvmFallback].forEach(add);
  else nonEvmFallback.forEach(add);

  return order;
}

// Рекурсивный поиск адреса нужного формата в JSON OKLink.
// Приоритет — значения под ключами from/sender/input (отправитель),
// иначе первое совпадение. Важно для UTXO-сетей (BTC/LTC), где у
// транзакции несколько входов и нет одного поля `from`.
function deepFindAddress(root, re) {
  const PREF = /from|sender|input|vin|payer|source/i;
  let fallback = '';
  const stack = [{ node: root, key: '' }];
  while (stack.length) {
    const { node, key } = stack.pop();
    if (typeof node === 'string') {
      const v = node.trim();
      if (re.test(v)) {
        if (PREF.test(key)) return v;     // лучший вариант — под ключом отправителя
        if (!fallback) fallback = v;
      }
    } else if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, key });
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) stack.push({ node: node[k], key: k });
    }
  }
  return fallback;
}

// EVM-цепи (ETH, BSC, Polygon): публичный JSON-RPC, не требует ключа.
async function fetchSenderEVM(txHash, chain) {
  txHash = normalizeEvmTxHash(txHash);
  const rpcs = EVM_RPC[chain];
  if (!rpcs?.length) return '';
  for (const rpc of rpcs) {
    log(`EVM RPC (${chain})`, rpc);
    try {
      const resp = await fetchWithTimeout(rpc, 8000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionByHash', params: [txHash], id: 1 })
      });
      if (!resp.ok) {
        log(`EVM RPC (${chain}) HTTP`, resp.status);
        if (resp.status >= 500 || resp.status === 401 || resp.status === 403 || resp.status === 429) continue;
        return '';
      }
      const json = await resp.json();
      if (json.error) {
        log(`EVM RPC (${chain}) error`, json.error);
        continue;
      }
      const addr = json.result?.from || '';
      log(`EVM RPC (${chain}) адрес`, addr || '(не найден)');
      return addr;
    } catch (e) {
      log(`EVM RPC (${chain}) исключение`, e.message);
    }
  }
  return '';
}

// TRON: TronScan API. С июня 2025 требует TRON-PRO-API-KEY (бесплатный ключ).
async function fetchSenderTRX(txHash) {
  txHash = normalizeTxHash(txHash);
  log('TronScan API', txHash);
  try {
    const headers = TRON_API_KEY ? { 'TRON-PRO-API-KEY': TRON_API_KEY } : {};
    const resp = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txHash}`, { headers });
    log('TronScan HTTP статус', resp.status);
    if (!resp.ok) return '';
    const json = await resp.json();
    console.log('[Collector] TronScan raw response', JSON.stringify(json).slice(0, 500));
    const addr = json.ownerAddress || '';
    log('TronScan адрес', addr || '(не найден)');
    return addr;
  } catch (e) { log('TronScan исключение', e.message); return ''; }
}

async function fetchWithTimeout(url, ms, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

// BTC: Blockstream (с таймаутом)
async function fetchSenderBTC(txHash) {
  log('BTC Blockstream', txHash);
  try {
    const resp = await fetchWithTimeout(`https://blockstream.info/api/tx/${txHash}`, 10000);
    if (!resp.ok) { log('BTC Blockstream HTTP', resp.status); return ''; }
    const json = await resp.json();
    const addr = json.vin?.[0]?.prevout?.scriptpubkey_address || '';
    log('BTC адрес', addr || '(не найден)');
    return addr;
  } catch (e) { log('BTC Blockstream исключение', e.message); return ''; }
}

// LTC: несколько источников с таймаутом
async function fetchSenderLTC(txHash) {
  const sources = [
    {
      name: 'BlockCypher',
      url: `https://api.blockcypher.com/v1/ltc/main/txs/${txHash}`,
      extract: json => json.inputs?.[0]?.addresses?.[0] || '',
    },
    {
      name: 'Blockchair',
      url: `https://api.blockchair.com/litecoin/dashboards/transaction/${txHash}`,
      extract: json => {
        const entry = json.data && !Array.isArray(json.data) ? Object.values(json.data)[0] : null;
        return entry?.inputs?.[0]?.recipient || '';
      },
    },
    {
      name: 'litecoinspace',
      url: `https://litecoinspace.org/api/tx/${txHash}`,
      extract: json => json.vin?.[0]?.prevout?.scriptpubkey_address || '',
    },
  ];
  for (const { name, url, extract } of sources) {
    log(`LTC ${name} запрос`, url);
    try {
      const resp = await fetchWithTimeout(url, 8000);
      const text = await resp.text();
      console.log(`[LTC ${name}] HTTP ${resp.status} | body: ${text.slice(0, 400)}`);
      if (!resp.ok) { log(`LTC ${name} HTTP ошибка`, resp.status); continue; }
      let json;
      try { json = JSON.parse(text); } catch { log(`LTC ${name} JSON ошибка`); continue; }
      const addr = extract(json);
      log(`LTC ${name} адрес`, addr || '(не найден)');
      if (addr) return addr;
    } catch (e) {
      console.log(`[LTC ${name}] исключение: ${e.message}`);
      log(`LTC ${name} исключение`, e.message);
    }
  }
  return '';
}

async function fetchSenderUTXO(txHash, chain) {
  txHash = normalizeTxHash(txHash);
  if (chain === 'btc') return fetchSenderBTC(txHash);
  if (chain === 'ltc') return fetchSenderLTC(txHash);
  return '';
}

// Роутер: выбирает нужный API по цепи.
async function fetchSenderByChain(txHash, chain) {
  if (EVM_RPC[chain]) return fetchSenderEVM(txHash, chain);
  if (chain === 'trx')  return fetchSenderTRX(txHash);
  if (chain === 'btc' || chain === 'ltc') return fetchSenderUTXO(txHash, chain);
  return '';
}

// TON: tonviewer.com рендерит страницу транзакции на клиенте (React),
// поэтому fetch() видит только пустой SPA-каркас. Открываем реальную
// вкладку через background и читаем адрес из готового DOM.
function fetchTonSender(txHash) {
  txHash = normalizeTxHash(txHash);
  log('TON: запрос адреса через tonviewer (background tab)', txHash);
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'FETCH_TON_SENDER', txHash }, response => {
      log('TON: ответ от background', response);
      resolve(response?.addr || '');
    });
  });
}

// Перебираем сети-кандидаты, пока не найдём корректный адрес отправителя.
async function fetchFromAddress(txHash, methodHint, pageHint) {
  txHash = normalizeTxHash(txHash);
  const chains = detectChains([methodHint, pageHint].join(' '), txHash);
  for (const chain of chains) {
    log(`Проверка сети «${chain}»`);
    if (chain === 'ton') {
      const addr = await fetchTonSender(txHash);
      if (addr) return addr;
      continue;
    }
    const addr = await fetchSenderByChain(txHash, chain);
    if (addr) return addr;
  }
  return '';
}

// ── Logins ───────────────────────────────────────────────────────────────────

// Оставляем только базовую часть User-Agent: "Mozilla/5.0 (платформа)",
// отрезаем хвост вида "AppleWebKit/... Chrome/... Safari/...".
function trimUserAgent(ua) {
  const m = ua.match(/^[^()]*\([^)]*\)/);
  return m ? m[0].trim() : ua;
}

function extractLoginsData(doc) {
  const asns = new Set(), ips = new Set(), countries = new Set(), devices = new Set();

  for (const row of doc.querySelectorAll('tbody tr')) {
    const tds = row.querySelectorAll('td');
    if (tds.length < 6) continue;

    const ip = tds[1]?.textContent.trim();
    const asn = tds[2]?.textContent.trim();
    const country = tds[3]?.textContent.trim();
    const ua = tds[5]?.textContent.trim();

    if (ip) ips.add(ip);
    if (asn) asns.add(asn);
    if (country) countries.add(country);
    if (ua) devices.add(trimUserAgent(ua));
  }

  return { asns, ips, countries, devices };
}

// ── Game transactions ─────────────────────────────────────────────────────────

async function fetchAllGames(userId) {
  const games = new Map(); // name -> hasBonus
  const now = new Date();
  const dateEnd   = now.toISOString().slice(0, 10);
  const dateStart = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).toISOString().slice(0, 10);
  const BASE_URL = `${BASE}/app/externalgametransaction/externalgametransaction/list?filter[user][value]=${userId}&filter[_per_page]=250&filter[createdAt][value][start]=${dateStart}&filter[createdAt][value][end]=${dateEnd}`;
  for (let page = 1; page <= 100; page++) {
    notifyProgress(`Загрузка игр — страница ${page}...`);
    const doc = await fetchDoc(`${BASE_URL}&filter[_page]=${page}`);
    const trs = doc.querySelectorAll('tbody tr');
    for (const tr of trs) {
      const a = tr.querySelector('.js-default-view-column a');
      if (!a) continue;
      const name = a.textContent.trim();
      if (!name) continue;
      const tds = tr.querySelectorAll('td');
      const isBonus = tds[1] ? tds[1].textContent.includes('bonus') : false;
      if (!games.has(name)) {
        games.set(name, isBonus);
      } else if (isBonus) {
        games.set(name, true);
      }
    }
    if (trs.length < 250) break; // последняя страница
  }
  return [...games.entries()].map(([name, bonus]) => bonus ? `${name} (бонус)` : name).join(', ');
}

function extractGames(doc) {
  const games = new Set();
  for (const row of doc.querySelectorAll('tbody tr')) {
    const a = row.querySelector('.js-default-view-column a');
    if (a) {
      const name = a.textContent.trim();
      if (name) games.add(name);
    }
  }
  return [...games].join(', ');
}

// ── External account ID ───────────────────────────────────────────────────────

async function fetchExternalAccountId(showDoc, userId) {
  try {
    // Find "Показать все" link inside the Счета box
    const accountsBox = findBoxByTitle(showDoc, 'Счета');
    let accountsUrl;
    if (accountsBox) {
      const allLink = accountsBox.querySelector('a');
      if (allLink) accountsUrl = `https://lixog.com${allLink.getAttribute('href')}`;
    }
    // Fallback: construct URL directly
    if (!accountsUrl) {
      accountsUrl = `${BASE}/app/account/list?filter[user][value]=${userId}`;
    }

    const doc = await fetchDoc(accountsUrl);

    // Find column index of "Внешний айди счета"
    const headers = doc.querySelectorAll('thead th');
    let extIdColIdx = -1;
    headers.forEach((th, i) => {
      if (th.textContent.trim().toLowerCase().includes('внешний')) extIdColIdx = i;
    });
    if (extIdColIdx < 0) { log('Колонка «Внешний айди счета» не найдена'); return ''; }

    const firstRow = doc.querySelector('tbody tr');
    if (!firstRow) return '';
    const tds = firstRow.querySelectorAll('td');
    const extId = tds[extIdColIdx]?.textContent.trim() ?? '';
    log('Внешний ID счета найден', extId);
    return extId;
  } catch (e) {
    log('Ошибка fetchExternalAccountId', e.message);
    return '';
  }
}

// ── Altenar player lookup ─────────────────────────────────────────────────────

const ALTENAR = 'https://sb2admin-altenar2.biahosted.com';

async function fetchAltenarPlayerId(userId) {
  const extId = String(userId);
  try {
    notifyProgress('Поиск игрока в Altenar...');
    log('Altenar GetPlayers, ExtPlayerId', extId);
    const playersResp = await fetch(
      `${ALTENAR}/Api/PlayerList/GetPlayers`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Filters: {
            IntPlayerId: null, ExtPlayerId: extId, SearchName: '',
            DateFrom: '', DateTo: '', ColorIds: [], AffiliatesIds: [],
            BrandsIds: [], LicensesIds: [], LimitGroupIds: [],
            Site: 1, SortDesc: false, WithTotals: false
          }
        })
      }
    );
    if (!playersResp.ok) { log('Altenar GetPlayers HTTP', playersResp.status); return null; }
    const playersJson = await playersResp.json();
    if (!playersJson.Success) { log('Altenar GetPlayers Success=false', playersJson); return null; }

    const player = playersJson?.Data?.Rows?.[0];
    if (!player) { log('Altenar: игрок не найден по ExtPlayerId', extId); return null; }
    log('Altenar PlayerId найден', player.PlayerId);
    return player.PlayerId;
  } catch (e) {
    log('Ошибка fetchAltenarPlayerId', e.message);
    return null;
  }
}

// ── Altenar restriction ───────────────────────────────────────────────────────

async function fetchAltenarRestriction(playerId) {
  try {
    const commentsResp = await fetch(
      `${ALTENAR}/api/PlayerManager/GetComments?PlayerId=${playerId}&Site=1`,
      { credentials: 'include' }
    );
    if (!commentsResp.ok) { log('Altenar GetComments HTTP', commentsResp.status); return ''; }
    const commentsJson = await commentsResp.json();
    if (!commentsJson.Success) return '';

    const comments = commentsJson?.Data;
    if (!Array.isArray(comments) || comments.length === 0) { log('Altenar: комментариев нет'); return ''; }

    log('Altenar комментарий (ограничение)', comments[0]?.Text);
    return comments[0]?.Text ?? '';
  } catch (e) {
    log('Ошибка fetchAltenarRestriction', e.message);
    return '';
  }
}

// ── Altenar sport / championship ──────────────────────────────────────────────

async function fetchAltenarSportTypes(playerId) {
  try {
    notifyProgress('Загрузка ставок в Altenar...');
    log('Altenar: загрузка страницы ставок игрока', playerId);
    const pageResp = await fetch(
      `${ALTENAR}/ManagePlayersProfile/PlayerBetList?playerId=${playerId}&site=1`,
      { credentials: 'include' }
    );
    if (!pageResp.ok) { log('Altenar PlayerBetList HTTP', pageResp.status); return { sports: '', champs: '' }; }
    const html = await pageResp.text();

    const betListIdMatch = html.match(/BetListId:\s*'([0-9a-fA-F-]{36})'/);
    const betListId = betListIdMatch ? betListIdMatch[1] : '';
    if (!betListId) { log('Altenar: не найден BetListId на странице ставок'); return { sports: '', champs: '' }; }

    const columnsMatch = html.match(/var betlistParams\s*=\s*(\[[^;]*?\]);/);
    const betListColumns = columnsMatch ? JSON.parse(columnsMatch[1]) : [];

    const playerSettings = {
      PageSizeNum: 100, InBaseCurrency: true, BetDetailsInBaseCurrency: 'False',
      InBaseLanguage: true, PlayerId: playerId, UserAccessType: '',
      BetListId: betListId, ParentBetListId: '', IsPendingBetList: false,
      isPlayerBetsPage: true
    };

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmtDate = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
    const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    const fromDate = `${fmtDate(monthAgo)} 00:00:00`;
    const toDate = `${fmtDate(now)} 23:59:59`;

    const requestData = {
      GridParams: {
        Filters: {
          PlayerId: String(playerId), LicenseeIds: [], CreatedFromDate: fromDate,
          RelativeCreatedFromDate: '5', RelativeSettledFromDate: '5',
          SettledFromDate: fromDate, CreatedToDate: toDate, SettledToDate: toDate,
          BetId: '', BetStatuses: [], CurrencyIds: [],
          SkinIds: [], AffiliateIds: [], SportIds: [], CategoryIds: [], ChampIds: [],
          UseSettledFilter: false, UseCreatedFilter: true,
          UseRelativeSettledFilter: false, UseRelativeCreatedFilter: false,
          EventId: '', BetProducts: [], BetTypes: [], Colors: [], MarketTypeIds: [],
          IsBetBuilder: false, ReSettled: false, ManuallySettled: false, IsLocked: false,
          BetIds: null, UseStakeFilter: false, StakeFrom: '', StakeTo: '',
          EditManually: false, PlayerLimitGroupIds: [], IsPotWin: null,
          WinningsFrom: '', WinningsTo: '', FrontendTypes: [],
          SelectionsLowBound: null, SelectionsTopBound: null,
          OddsFrom: null, OddsTo: null, StreamingBets: false, BonusModes: [],
          LimitTypes: [], IsVip: false, ExtUserId: '',
          BonusCampaignId: '', HasPartialCashout: false, isAamsConfirm: false,
          FeedSelectionId: '', ProfileId: 0, IsLoadOnlyTotals: false,
          ShowTotals: true, UseReportDb: true, OnlyFavorites: false, IsBoosted: false,
          NeedTotals: true
        },
        Settings: playerSettings,
        BetListColumns: betListColumns,
        LastKnownTotal: null
      },
      Request: {
        page: 1, pageSize: 100,
        sorts: [{ Member: 'BetId', SortDirection: 'Descending' }]
      }
    };

    const betsResp = await fetch(`${ALTENAR}/BetList/GetBetList?region=1`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestData)
    });
    if (!betsResp.ok) { log('Altenar GetBetList HTTP', betsResp.status); return { sports: '', champs: '' }; }
    const betsJson = await betsResp.json();
    const rows = betsJson?.Data ?? [];

    const sports = new Set();
    const champs = new Set();
    rows.forEach(bet => {
      (bet?.BetFeedInfo?.BetSportsString || '').split(/(?:<\/?br\s*\/?>|[\n,])+/i).forEach(s => { const t = s.trim(); if (t) sports.add(t); });
      (bet?.BetFeedInfo?.BetsChampsString || '').split(/(?:<\/?br\s*\/?>|[\n,])+/i).forEach(c => { const t = c.trim(); if (t) champs.add(t); });
    });

    return { sports: [...sports].join(', '), champs: [...champs].join(', ') };
  } catch (e) {
    log('Ошибка fetchAltenarSportTypes', e.message);
    return { sports: '', champs: '' };
  }
}

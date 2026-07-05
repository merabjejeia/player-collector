// ── Tab navigation ────────────────────────────────────────────────────────────

document.getElementById('tabCollector').addEventListener('click', () => switchTab('collector'));
document.getElementById('tabPairs').addEventListener('click',    () => switchTab('pairs'));
document.getElementById('tabFind').addEventListener('click',     () => switchTab('find'));
document.getElementById('tabLogs').addEventListener('click',     () => switchTab('logs'));

function switchTab(tab) {
  ['Collector','Find','Pairs','Logs'].forEach(t => {
    document.getElementById('page' + t).classList.toggle('active', t.toLowerCase() === tab);
    document.getElementById('tab'  + t).classList.toggle('active', t.toLowerCase() === tab);
  });
}

// ── Role ──────────────────────────────────────────────────────────────────────

function getActiveColumns() {
  const cfg = ROLE_CONFIG[currentRole];
  if (!cfg?.toggleFields) return COLUMNS;
  return COLUMNS.filter(c => !cfg.toggleFields.includes(c) || selectedToggleFields.has(c));
}

function renderFieldToggles(toggleFields) {
  const el = document.getElementById('fieldToggles');
  el.innerHTML = '';
  toggleFields.forEach(field => {
    const label = document.createElement('label');
    label.className = 'field-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedToggleFields.has(field);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedToggleFields.add(field);
      else selectedToggleFields.delete(field);
      chrome.storage.local.set({ selectedToggleFields: [...selectedToggleFields] });
      if (rows.length) renderTable();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(field));
    el.appendChild(label);
  });
}

function applyRole(role) {
  currentRole = role;
  const cfg = ROLE_CONFIG[role];
  COLUMNS = cfg.columns;

  // Badge
  const badge = document.getElementById('roleBadge');
  badge.textContent = cfg.label;
  badge.style.background = cfg.color;

  // Tabs — show only allowed
  ['Collector', 'Find', 'Pairs', 'Logs'].forEach(t => {
    document.getElementById('tab' + t).style.display =
      cfg.tabs.includes(t) ? '' : 'none';
  });

  // Toggle fields (fraud only)
  const togglesEl = document.getElementById('fieldToggles');
  if (cfg.toggleFields) {
    if (selectedToggleFields.size === 0) cfg.toggleFields.forEach(f => selectedToggleFields.add(f));
    togglesEl.style.display = '';
    renderFieldToggles(cfg.toggleFields);
  } else {
    togglesEl.style.display = 'none';
  }

  if (rows.length) renderTable();
}

function initRole() {
  chrome.storage.local.get(['role', 'selectedToggleFields'], res => {
    if (res.selectedToggleFields?.length) {
      res.selectedToggleFields.forEach(f => selectedToggleFields.add(f));
    }
    if (res.role) {
      document.getElementById('roleOverlay').style.display = 'none';
      applyRole(res.role);
    } else {
      document.getElementById('roleOverlay').style.display = 'flex';
    }
  });
}

document.getElementById('roleSportBtn').addEventListener('click', () => {
  chrome.storage.local.set({ role: 'sport' }, () => {
    document.getElementById('roleOverlay').style.display = 'none';
    applyRole('sport');
  });
});
document.getElementById('roleFraudBtn').addEventListener('click', () => {
  chrome.storage.local.set({ role: 'fraud' }, () => {
    document.getElementById('roleOverlay').style.display = 'none';
    applyRole('fraud');
  });
});
document.getElementById('roleSwitchBtn').addEventListener('click', () => {
  if (confirm('Сменить отдел?\nТекущие собранные данные сохранятся.')) {
    selectedToggleFields.clear();
    chrome.storage.local.remove(['role', 'selectedToggleFields'], () => {
      document.getElementById('roleOverlay').style.display = 'flex';
    });
  }
});

// ── Collector ─────────────────────────────────────────────────────────────────

const ROLE_CONFIG = {
  sport: {
    label: 'Спорт', color: '#1a73e8',
    tabs: ['Collector', 'Find', 'Pairs', 'Logs'],
    columns: [
      'Внешний ID', 'Пользователь', 'Метод', 'Кошелек депа', 'Кошелек вывода',
      'Сумма депа', 'Сумма вывода', 'Валюта', 'IP', 'ASN', 'Страна',
      'Устройство', 'Примечание', 'ПП', 'Ограничение', 'Спорт', 'Чемпионат',
      'Создан', 'Ссылка', 'Игра'
    ],
    toggleFields: null
  },
  fraud: {
    label: 'Фрод', color: '#dc2626',
    tabs: ['Collector', 'Find', 'Pairs'],
    columns: [
      'Пользователь', 'Метод', 'Кошелек депа', 'Кошелек вывода',
      'Сумма депа', 'Сумма вывода', 'Валюта', 'IP', 'ASN', 'Страна',
      'Устройство', 'Примечание', 'ПП', 'Создан', 'Ссылка', 'Игра'
    ],
    toggleFields: ['Кошелек депа', 'IP', 'ASN', 'Страна', 'Устройство', 'ПП', 'Игра']
  }
};

let currentRole = null;
let COLUMNS = [];
let selectedToggleFields = new Set();

let rows = [];
let collecting = false;
let pending = [];                 // emails ещё не взятые в работу
let inFlight = new Map();         // reqId → { email, attempts }
let reqSeq = 0;
let totalCount = 0;
let failCount = 0;
const collectConcurrency = 1;     // последовательный сбор (по одному игроку)
const MAX_RETRY = 2;              // авто-повтор упавших запросов

const emailInput    = document.getElementById('emailInput');
const startBtn      = document.getElementById('startBtn');
const copyBtn       = document.getElementById('copyBtn');
const clearBtn      = document.getElementById('clearBtn');
const statusEl      = document.getElementById('status');
const progressEl    = document.getElementById('progress');
const tableContainer = document.getElementById('tableContainer');

chrome.storage.local.get(['rows'], res => {
  if (res.rows?.length) {
    rows = res.rows;
    copyBtn.disabled = false;
    // renderTable() will be called by initRole() → applyRole()
  }
});

initRole();

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'PROGRESS') {
    if (collecting) updateCollectProgress(msg.text);
    return;
  }
  if (msg.type === 'COLLECTION_RESULT') {
    const item = inFlight.get(msg.reqId);
    if (!item) return;                      // чужой/устаревший ответ — игнор
    inFlight.delete(msg.reqId);
    rows.push(msg.data);
    chrome.storage.local.set({ rows });
    renderTable();
    copyBtn.disabled = false;
    appendStatus(`✓ ${msg.data['Пользователь'] || item.email}`, 'ok');
    pump();
    return;
  }
  if (msg.type === 'COLLECTION_ERROR') {
    const item = inFlight.get(msg.reqId);
    if (!item) return;
    inFlight.delete(msg.reqId);
    // «Игрок не найден» — постоянная ошибка, повторять бессмысленно
    const permanent = /не найден/i.test(msg.error || '');
    if (!permanent && item.attempts < MAX_RETRY) {
      appendStatus(`↻ ${item.email} — повтор ${item.attempts + 1}/${MAX_RETRY}`, 'retry');
      sendCollect(item.email, item.attempts + 1);
    } else {
      failCount++;
      appendStatus(`✗ ${item.email}: ${msg.error}`, 'err');
    }
    pump();
  }
});

startBtn.addEventListener('click', () => {
  const seen = new Set();
  const emails = emailInput.value
    .split('\n')
    .map(extractEmail)
    .filter(e => e.length > 0 && !seen.has(e) && seen.add(e));   // отсев пустых и дублей

  if (!emails.length) { appendStatus('Введите email игроков', 'err'); return; }

  pending = emails;
  totalCount = emails.length;
  failCount = 0;
  inFlight.clear();
  emailInput.value = '';
  startBtn.disabled = true;
  statusEl.innerHTML = '';
  collecting = true;
  pump();
});

function extractEmail(line) {
  const emailMatch = line.match(/[\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) return emailMatch[0].toLowerCase();

  // Номер телефона — может быть как отдельной строкой, так и в формате
  // «Имя (+380...)». Поиск в админке не находит игрока с "+" в начале —
  // нужны только цифры.
  const phoneMatch = line.match(/\+?\d[\d\s()-]{5,}\d/);
  if (phoneMatch) return phoneMatch[0].replace(/\D/g, '');

  return line.trim();
}

// Параллельный пул: держим в работе до collectConcurrency запросов одновременно
function pump() {
  while (collecting && inFlight.size < collectConcurrency && pending.length) {
    sendCollect(pending.shift(), 0);
  }
  if (collecting && !pending.length && inFlight.size === 0) {
    collecting = false;
    startBtn.disabled = false;
    progressEl.textContent = `Готово · собрано ${rows.length}` + (failCount ? ` · ошибок ${failCount}` : '');
    return;
  }
  updateCollectProgress();
}

function sendCollect(email, attempts) {
  const reqId = ++reqSeq;
  inFlight.set(reqId, { email, attempts });
  chrome.runtime.sendMessage({ type: 'COLLECT_PLAYER', reqId, email });
}

function updateCollectProgress(activity) {
  let line = `Собрано ${rows.length}/${totalCount} · в работе ${inFlight.size} · осталось ${pending.length}`;
  if (failCount) line += ` · ошибок ${failCount}`;
  if (activity) line += ` — ${activity}`;
  progressEl.textContent = line;
}

function appendStatus(text, type) {
  const line = document.createElement('div');
  line.textContent = text;
  line.className = type;
  statusEl.appendChild(line);
}

const NUMERIC_COLS = new Set(['Сумма депа', 'Сумма вывода']);
function formatCell(col, val) {
  let s = (val || '').replace(/\t/g, ' ').replace(/\n/g, ' ');
  if (NUMERIC_COLS.has(col)) s = s.replace('.', ',');
  return s;
}

copyBtn.addEventListener('click', () => {
  const cols = getActiveColumns();
  const tsvRows = rows.map(row =>
    cols.map(col => formatCell(col, row[col])).join('\t')
  );
  navigator.clipboard.writeText(tsvRows.join('\n')).then(() => {
    const orig = copyBtn.textContent;
    copyBtn.textContent = 'Скопировано!';
    setTimeout(() => { copyBtn.textContent = orig; }, 1500);
  });
});

clearBtn.addEventListener('click', () => {
  rows = [];
  chrome.storage.local.set({ rows: [] });
  tableContainer.innerHTML = '';
  statusEl.innerHTML = '';
  progressEl.textContent = '';
  copyBtn.disabled = true;
});

// ── Pairs section ─────────────────────────────────────────────────────────────

const BTECH_BASE   = 'https://backoffice.paynomicpay.com/0b37f21a-43bf-41f7-a534-35ae9ce507da/transactions';
const BTECH_FIELDS = ['customerAddress','foreignId','merchantAccountId','merchantUserId','paymentAddress','txid'];
const PP_DEPOSITS  = 'https://crm.payplay.io/transactions/deposits';
const PP_WITHDRAW  = 'https://crm.payplay.io/transactions/withdrawals';

function buildBtechUrl(addr) {
  const p = new URLSearchParams();
  BTECH_FIELDS.forEach(f => p.append('table', `${f},${addr}`));
  return `${BTECH_BASE}?${p}`;
}

function buildPayPlayUrl(base, addr) {
  return `${base}?${new URLSearchParams({ search: addr })}`;
}

function parsePairs(raw, exclude) {
  const ex = exclude.trim().toLowerCase();
  const addrs = new Set();
  raw.split('\n').forEach(line => {
    const parts = line.trim().split(/[\t,\s]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return;
    [parts[0], parts[1]].forEach(a => {
      if (a && (!ex || a.toLowerCase() !== ex)) addrs.add(a);
    });
  });
  return [...addrs];
}

function buildPairsUrls(addrs, service) {
  const urls = [];
  addrs.forEach(addr => {
    if (service === 'btech') {
      urls.push({ label: `BTech · ${addr.slice(0,8)}…${addr.slice(-6)}`, url: buildBtechUrl(addr), addr });
    } else {
      urls.push({ label: `PayPlay Деп · ${addr.slice(0,8)}…${addr.slice(-6)}`, url: buildPayPlayUrl(PP_DEPOSITS, addr), addr });
      urls.push({ label: `PayPlay Выв · ${addr.slice(0,8)}…${addr.slice(-6)}`, url: buildPayPlayUrl(PP_WITHDRAW, addr), addr });
    }
  });
  return urls;
}

// pairsUrls: array of {label, url, addr, opened}
let pairsUrls = [];

const pairsGenBtn      = document.getElementById('pairsGenBtn');
const pairsOpen20Btn   = document.getElementById('pairsOpen20Btn');
const pairsOpenBtn     = document.getElementById('pairsOpenBtn');
const pairsCopyBtn     = document.getElementById('pairsCopyBtn');
const pairsLinks       = document.getElementById('pairsLinks');
const pairsMeta        = document.getElementById('pairsMeta');
const pairsProgressWrap= document.getElementById('pairsProgressWrap');
const pairsProgressBar = document.getElementById('pairsProgressBar');
const pairsProgressText= document.getElementById('pairsProgressText');

// ── Persist pairs state ───────────────────────────────────────────────────────

function savePairsState() {
  chrome.storage.local.set({
    pairsInput:   document.getElementById('pairsInput').value,
    pairsExclude: document.getElementById('pairsExclude').value,
    pairsService: document.getElementById('pairsService').value,
    pairsUrls:    pairsUrls
  });
}

function renderPairsLinks() {
  pairsLinks.innerHTML = '';
  if (!pairsUrls.length) return;

  pairsUrls.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'link-row';

    const a = document.createElement('a');
    a.href = entry.url;
    a.textContent = entry.label;
    a.title = entry.addr;
    a.target = '_blank';
    if (entry.opened) a.classList.add('visited');
    a.addEventListener('click', () => {
      a.classList.add('visited');
      pairsUrls[idx].opened = true;
      savePairsState();
      updatePairsMeta();
    });

    const cpBtn = document.createElement('button');
    cpBtn.className = 'icn-btn';
    cpBtn.title = 'Копировать';
    cpBtn.textContent = '⎘';
    cpBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(entry.url).then(() => {
        cpBtn.textContent = '✓';
        setTimeout(() => { cpBtn.textContent = '⎘'; }, 1200);
      });
    });

    row.appendChild(a);
    row.appendChild(cpBtn);
    pairsLinks.appendChild(row);
  });
}

function updatePairsMeta() {
  const total   = pairsUrls.length;
  const opened  = pairsUrls.filter(u => u.opened).length;
  const unopened = total - opened;
  const addrsCount = new Set(pairsUrls.map(u => u.addr)).size;
  pairsMeta.textContent = `Адресов: ${addrsCount} · Ссылок: ${total} · Открыто: ${opened} · Осталось: ${unopened}`;
  pairsMeta.style.display = '';
  const hasLinks = total > 0;
  const hasUnopenedLinks = unopened > 0;
  pairsOpenBtn.disabled  = !hasUnopenedLinks;
  pairsCopyBtn.disabled  = !hasLinks;
  pairsOpen20Btn.disabled = !hasUnopenedLinks;
}

// Restore state on popup open
chrome.storage.local.get(['pairsInput','pairsExclude','pairsService','pairsUrls'], res => {
  if (res.pairsInput   !== undefined) document.getElementById('pairsInput').value   = res.pairsInput;
  if (res.pairsExclude !== undefined) document.getElementById('pairsExclude').value = res.pairsExclude;
  if (res.pairsService !== undefined) document.getElementById('pairsService').value = res.pairsService;
  if (res.pairsUrls?.length) {
    pairsUrls = res.pairsUrls;
    renderPairsLinks();
    updatePairsMeta();
    pairsProgressWrap.style.display = 'none';
  }
});

// Auto-save form fields on change
['pairsInput','pairsExclude','pairsService'].forEach(id => {
  document.getElementById(id).addEventListener('input', savePairsState);
  document.getElementById(id).addEventListener('change', savePairsState);
});

// ── Generate ──────────────────────────────────────────────────────────────────

pairsGenBtn.addEventListener('click', () => {
  const raw     = document.getElementById('pairsInput').value;
  const exclude = document.getElementById('pairsExclude').value;
  const service = document.getElementById('pairsService').value;

  const addrs = parsePairs(raw, exclude);
  pairsUrls = buildPairsUrls(addrs, service).map(u => ({ ...u, opened: false }));

  pairsProgressWrap.style.display = 'none';
  pairsProgressBar.style.width = '0%';

  if (!pairsUrls.length) {
    pairsMeta.textContent = 'Нет адресов для генерации (проверьте ввод).';
    pairsMeta.style.display = '';
    pairsOpenBtn.disabled  = true;
    pairsCopyBtn.disabled  = true;
    pairsOpen20Btn.disabled = true;
    pairsLinks.innerHTML = '';
    savePairsState();
    return;
  }

  renderPairsLinks();
  updatePairsMeta();
  savePairsState();
});

// ── Open 20 ───────────────────────────────────────────────────────────────────

pairsOpen20Btn.addEventListener('click', () => {
  const unopened = pairsUrls.filter(u => !u.opened);
  const batch = unopened.slice(0, 20);
  if (!batch.length) return;

  // Mark as opened
  batch.forEach(entry => { entry.opened = true; });
  savePairsState();

  // Re-render to update visited state
  renderPairsLinks();
  updatePairsMeta();

  pairsProgressWrap.style.display = '';
  pairsProgressBar.style.width = '0%';
  pairsProgressText.textContent = `Открываем 0 из ${batch.length}…`;

  chrome.runtime.sendMessage({
    type: 'OPEN_TABS',
    urls: batch.map(u => u.url),
    delay: 2000
  });
});

// ── Open all ──────────────────────────────────────────────────────────────────

pairsOpenBtn.addEventListener('click', () => {
  const unopened = pairsUrls.filter(u => !u.opened);
  if (!unopened.length) return;

  unopened.forEach(entry => { entry.opened = true; });
  savePairsState();
  renderPairsLinks();
  updatePairsMeta();

  pairsProgressWrap.style.display = '';
  pairsProgressBar.style.width = '0%';
  pairsProgressText.textContent = `Открываем 0 из ${unopened.length}…`;

  chrome.runtime.sendMessage({
    type: 'OPEN_TABS',
    urls: unopened.map(u => u.url),
    delay: 2000
  });
});

// ── Progress from background ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'OPEN_TABS_PROGRESS') {
    const pct = Math.round((msg.done / msg.total) * 100);
    pairsProgressBar.style.width = pct + '%';
    pairsProgressText.textContent = `Открыто ${msg.done} из ${msg.total}`;
  }
});

// Clear pairs section
document.getElementById('pairsClearBtn').addEventListener('click', () => {
  document.getElementById('pairsInput').value   = '';
  document.getElementById('pairsExclude').value = '';
  document.getElementById('pairsService').value = 'btech';
  pairsUrls = [];
  pairsLinks.innerHTML = '';
  pairsMeta.style.display = 'none';
  pairsProgressWrap.style.display = 'none';
  pairsProgressBar.style.width = '0%';
  pairsOpenBtn.disabled   = true;
  pairsOpen20Btn.disabled = true;
  pairsCopyBtn.disabled   = true;
  chrome.storage.local.remove(['pairsInput','pairsExclude','pairsService','pairsUrls']);
});

// ── Copy all links ────────────────────────────────────────────────────────────

pairsCopyBtn.addEventListener('click', () => {
  const text = pairsUrls.map(u => u.url).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const orig = pairsCopyBtn.textContent.trim();
    pairsCopyBtn.textContent = 'Скопировано!';
    setTimeout(() => { pairsCopyBtn.textContent = orig; }, 1500);
  });
});

// ── Find in text ──────────────────────────────────────────────────────────────

const ADMIN_SEARCH = 'https://lixog.com/ru/admin/app/user/list?filter[user_guess][value]=';

// Regex: captures "Username (email@domain.com)" или "Username (+380...)" —
// username может содержать пробелы, идентификатор — email либо телефон.
const ACCOUNT_RE = /([\w][\w\s.-]{0,40}?)\s*\((([\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,})|(\+?\d[\d\s()-]{5,}\d))\)/g;

// Email — как есть (lowercase); телефон — только цифры, без "+"
// (поиск в админке lixog не находит игрока с "+" в начале).
function normalizeIdentifier(raw) {
  const v = raw.trim();
  if (/@/.test(v)) return v.toLowerCase();
  return v.replace(/\D/g, '');
}

let foundAccounts = []; // [{name, value, searchValue}]

const findInput      = document.getElementById('findInput');
const findExtractBtn = document.getElementById('findExtractBtn');
const findOpenAllBtn = document.getElementById('findOpenAllBtn');
const findCollectBtn = document.getElementById('findCollectBtn');
const findResults    = document.getElementById('findResults');
const findMeta       = document.getElementById('findMeta');

// Restore saved text on popup open
chrome.storage.local.get(['findInput'], res => {
  if (res.findInput) findInput.value = res.findInput;
});
findInput.addEventListener('input', () => {
  chrome.storage.local.set({ findInput: findInput.value });
});

findExtractBtn.addEventListener('click', () => {
  const text = findInput.value;
  foundAccounts = [];

  let m;
  ACCOUNT_RE.lastIndex = 0;
  const seen = new Set();
  while ((m = ACCOUNT_RE.exec(text)) !== null) {
    const name = m[1].trim().replace(/\s+/g, ' ');
    const value = m[2].trim();
    const searchValue = normalizeIdentifier(value);
    if (!seen.has(searchValue)) {
      seen.add(searchValue);
      foundAccounts.push({ name, value, searchValue });
    }
  }

  renderFindResults();
});

function renderFindResults() {
  findResults.innerHTML = '';

  if (!foundAccounts.length) {
    findMeta.style.display = 'none';
    findOpenAllBtn.disabled = true;
    findCollectBtn.disabled = true;
    const msg = document.createElement('div');
    msg.className = 'find-empty';
    msg.textContent = 'Аккаунты не найдены. Проверьте формат: «Имя (email@domain.com)» или «Имя (+380...)»';
    findResults.appendChild(msg);
    return;
  }

  findMeta.textContent = `Найдено аккаунтов: ${foundAccounts.length}`;
  findMeta.style.display = '';
  findOpenAllBtn.disabled = false;
  findCollectBtn.disabled = false;

  foundAccounts.forEach(({ name, value, searchValue }) => {
    const adminUrl = ADMIN_SEARCH + encodeURIComponent(searchValue);

    const card = document.createElement('div');
    card.className = 'find-card';

    // Avatar: first letter of name
    const avatar = document.createElement('div');
    avatar.className = 'find-avatar';
    avatar.textContent = name.charAt(0).toUpperCase();

    const info = document.createElement('div');
    info.className = 'find-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'find-name';
    nameEl.textContent = name;

    const emailEl = document.createElement('div');
    emailEl.className = 'find-email';
    emailEl.textContent = value;

    info.appendChild(nameEl);
    info.appendChild(emailEl);

    const actions = document.createElement('div');
    actions.className = 'find-actions';

    card.appendChild(avatar);

    // Copy email/phone
    const cpBtn = document.createElement('button');
    cpBtn.textContent = '⎘';
    cpBtn.title = 'Копировать';
    cpBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(value).then(() => {
        cpBtn.textContent = '✓';
        setTimeout(() => { cpBtn.textContent = '⎘'; }, 1200);
      });
    });

    // Open in admin
    const openLink = document.createElement('a');
    openLink.href = adminUrl;
    openLink.target = '_blank';
    openLink.textContent = 'Открыть';

    actions.appendChild(cpBtn);
    actions.appendChild(openLink);

    card.appendChild(info);
    card.appendChild(actions);
    findResults.appendChild(card);

  });
}

// Open all admin pages via background (popup stays alive)
findOpenAllBtn.addEventListener('click', () => {
  const urls = foundAccounts.map(({ searchValue }) => ADMIN_SEARCH + encodeURIComponent(searchValue));
  chrome.runtime.sendMessage({ type: 'OPEN_TABS', urls });
});

// Clear find section
document.getElementById('findClearBtn').addEventListener('click', () => {
  findInput.value = '';
  foundAccounts = [];
  findResults.innerHTML = '';
  findMeta.style.display = 'none';
  findOpenAllBtn.disabled = true;
  findCollectBtn.disabled = true;
  chrome.storage.local.remove('findInput');
});

// Send extracted emails/phones to collector tab
findCollectBtn.addEventListener('click', () => {
  const emails = foundAccounts.map(a => a.searchValue).join('\n');
  const current = emailInput.value.trim();
  emailInput.value = current ? current + '\n' + emails : emails;
  switchTab('collector');
});

// ── Logs (Analyst break parser) ───────────────────────────────────────────────

var ANALYSTS = [
  {id:"120544",name:"Дарья Щиенко"},{id:"125978",name:"Аникушина Марина"},
  {id:"172904",name:"Добра Светлана"},{id:"178556",name:"Симаненко Екатерина"},
  {id:"288157",name:"Трубицына Наталья"},{id:"300051",name:"Вахромова Татьяна"},
  {id:"352367",name:"Гарифуллина Юлия"},{id:"380914",name:"Объедкова Мария"},
  {id:"595941",name:"Скороходова Ангелина"},{id:"1554648",name:"Загритдинова Юлия"},
  {id:"1649091",name:"Воронцова Мария"},{id:"1795732",name:"Бахтиярова Анна"},
  {id:"2634198",name:"Чхаидзе Инга"},{id:"2648235",name:"Натия Беридзе"},
  {id:"2673950",name:"Богданова Лина"},{id:"2717706",name:"Гогоберидзе Нино"},
  {id:"4015310",name:"Ефименко Ксения"},{id:"4519217",name:"Мария Камолова"},
  {id:"4695152",name:"Виолетта Калукова"},{id:"4772685",name:"Константин Юматов"},
  {id:"6042179",name:"Владислав Мухин"},{id:"6598399",name:"Ринкавой Мариам"},
  {id:"6876268",name:"Жикол Александр"},{id:"7232070",name:"Ксения Мухина"},
  {id:"8489434",name:"Валерий Хливненко"},{id:"9577100",name:"Лиана Адзумба"},
  {id:"10035239",name:"Элина Ширлинг"},{id:"10208862",name:"Мари Иакобадзе"},
  {id:"11840725",name:"Дореули Кристина"},{id:"13334483",name:"Григорук Ирина"},
  {id:"13594745",name:"Никита Благодырь"},{id:"14819151",name:"Татьяна Масько"},
  {id:"15589301",name:"Алексей Сычев"},{id:"15721837",name:"Сергей Глухов"},
  {id:"15964313",name:"Давид Верулидзе"},{id:"16020971",name:"Гурджян Сергей"},
  {id:"16388820",name:"Далила Адзумба"},{id:"16713434",name:"Михаил Шумивода"},
  {id:"17018430",name:"Саба Ардзенадзе"},{id:"17018435",name:"Владимир Савченко"},
  {id:"17231598",name:"Анастасия Епишева"},{id:"17243697",name:"Косякова Екатерина"},
  {id:"17387848",name:"Ермаков Алихан"},{id:"17387971",name:"Мирабян Татьяна"},
  {id:"17530506",name:"Анна Макартычян"},{id:"17731228",name:"Лазарева Валерия"},
  {id:"18355927",name:"Кирилл Комнацкий"},{id:"18690400",name:"Винарская Ирина"},
  {id:"18691147",name:"Гузеев Никита"},{id:"19343913",name:"Павел Менахин"},
  {id:"19344395",name:"Зарина Жунусова"},{id:"19457012",name:"Кудрявцев Никита"},
  {id:"21438270",name:"Спиркин Данила"},{id:"21438303",name:"Якупова Диана"},
  {id:"21438522",name:"Соколов Денис"},{id:"21439229",name:"Пилинога Сергей"},
  {id:"22057609",name:"Герасименко Артем"},{id:"22063163",name:"Бортников Евгений"},
  {id:"22063565",name:"Татьяна Стреха"},{id:"22055956",name:"Битюцкая Алиса"},
  {id:"11314328",name:"Данила Снигирев"},{id:"14562557",name:"Денисов Александр"},
  {id:"6042120",name:"Юлия Фарленкова"}
];

var RU_MONTHS = ['янв.','февр.','мар.','апр.','мая','июн.','июл.','авг.','сент.','окт.','нояб.','дек.'];

function logsFormatDate(dateStr, timeStr, isEnd) {
  var d = new Date(dateStr + 'T' + timeStr + ':00');
  var sec = isEnd ? '59' : '00';
  return d.getDate() + ' ' + RU_MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ' г., ' +
    String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + sec;
}

function logsBuildUrl(userId, page, dfmt, dtfmt) {
  return 'https://lixog.com/ru/admin/app/actionrecord/list?' +
    'filter%5B_page%5D=' + page +
    '&filter%5B_per_page%5D=250' +
    '&filter%5B_sort_by%5D=createdAt' +
    '&filter%5B_sort_order%5D=ASC' +
    '&filter%5Buser__id%5D%5Bvalue%5D=' + userId +
    '&filter%5BcreatedAt%5D%5Bvalue%5D%5Bstart%5D=' + encodeURIComponent(dfmt) +
    '&filter%5BcreatedAt%5D%5Bvalue%5D%5Bend%5D=' + encodeURIComponent(dtfmt);
}

function logsFetchPage(url) {
  return fetch(url, { credentials: 'include' }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }).then(function(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  });
}

function logsParseDatetimes(doc) {
  var res = [];
  doc.querySelectorAll('table.sonata-ba-list td.sonata-ba-list-field-datetime time[datetime]').forEach(function(el) {
    var d = new Date(el.getAttribute('datetime'));
    if (!isNaN(d.getTime())) res.push(d);
  });
  return res;
}

function logsGetShiftStart(dt) {
  var h = dt.getUTCHours(), d = new Date(dt.getTime());
  if (h >= 4 && h < 16) { d.setUTCHours(4,0,0,0); return d; }
  if (h >= 16) { d.setUTCHours(16,0,0,0); return d; }
  d.setUTCDate(d.getUTCDate()-1); d.setUTCHours(16,0,0,0); return d;
}

function logsAnalyzeBreaks(records, minGap, lateThreshold) {
  var byEmp = {};
  records.forEach(function(r) {
    if (!byEmp[r.employee]) byEmp[r.employee] = [];
    byEmp[r.employee].push(r.datetime);
  });
  var breaks = [];
  Object.keys(byEmp).forEach(function(emp) {
    var times = byEmp[emp].sort(function(a,b) { return a-b; });
    for (var i = 1; i < times.length; i++) {
      var gap = Math.round((times[i] - times[i-1]) / 60000);
      if (gap < minGap) continue;
      var isLate = false;
      if (gap > lateThreshold) {
        var ss = logsGetShiftStart(times[i]);
        if (times[i-1] <= ss && ss < times[i]) isLate = true;
      }
      breaks.push({ employee: emp, from: times[i-1], to: times[i], gapMin: gap, isLate: isLate });
    }
  });
  return breaks;
}

function logsFmtDt(d) {
  if (!d) return '';
  return String(d.getUTCDate()).padStart(2,'0') + '.' + String(d.getUTCMonth()+1).padStart(2,'0') + ' ' +
    String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
}

function logsFmtTime(d) {
  if (!d) return '';
  return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
}

function logsExportXls(allBreaks, dateFrom) {
  var byEmp = {};
  ANALYSTS.forEach(function(a) { byEmp[a.name] = []; });
  allBreaks.forEach(function(b) {
    if (!byEmp[b.employee]) byEmp[b.employee] = [];
    byEmp[b.employee].push(b);
  });

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    '  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    '<Styles>\n' +
    '  <Style ss:ID="w"><Alignment ss:WrapText="1" ss:Vertical="Top"/></Style>\n' +
    '  <Style ss:ID="h"><Font ss:Bold="1"/></Style>\n' +
    '</Styles>\n' +
    '<Worksheet ss:Name="Перерывы"><Table>\n' +
    '<Column ss:Width="180"/><Column ss:Width="420"/>\n' +
    '<Row><Cell ss:StyleID="h"><Data ss:Type="String">Сотрудник</Data></Cell>' +
    '<Cell ss:StyleID="h"><Data ss:Type="String">Перерывы</Data></Cell></Row>\n';

  Object.keys(byEmp).sort().forEach(function(emp) {
    var items = byEmp[emp];
    if (!items.length) return;
    var text = items.map(function(b) {
      var line = logsFmtDt(b.from) + ' - ' + logsFmtTime(b.to) + ' = ' + b.gapMin + ' мин';
      if (b.isLate) line += ' (опоздание)';
      return line;
    }).join('&#10;');
    xml += '<Row><Cell><Data ss:Type="String">' + esc(emp) + '</Data></Cell>' +
      '<Cell ss:StyleID="w"><Data ss:Type="String">' + esc(text).replace(/&amp;#10;/g,'&#10;') + '</Data></Cell></Row>\n';
  });

  xml += '</Table></Worksheet></Workbook>';

  var blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'перерывы_' + dateFrom + '.xls'; a.click();
  URL.revokeObjectURL(url);
}

// ── Logs UI ───────────────────────────────────────────────────────────────────

var logsAllBreaks = [];
var logsListEl = document.getElementById('logsAnalystList');
var logsSelectedIds = new Set(); // persists selections across search re-renders

function logsRenderList(filter) {
  filter = (filter || '').toLowerCase();
  logsListEl.innerHTML = '';
  ANALYSTS.forEach(function(a) {
    if (filter && a.name.toLowerCase().indexOf(filter) === -1 && a.id.indexOf(filter) === -1) return;
    var div = document.createElement('div');
    div.className = 'logs-item';
    var isChecked = logsSelectedIds.has(a.id);
    div.innerHTML = '<input type="checkbox" data-id="' + a.id + '"' + (isChecked ? ' checked' : '') + '><span class="li-name">' + a.name + '</span><span class="li-id">' + a.id + '</span>';
    var cb = div.querySelector('input');
    cb.addEventListener('change', function() {
      if (cb.checked) logsSelectedIds.add(a.id);
      else logsSelectedIds.delete(a.id);
    });
    div.addEventListener('click', function(e) {
      if (e.target.tagName !== 'INPUT') {
        cb.checked = !cb.checked;
        if (cb.checked) logsSelectedIds.add(a.id);
        else logsSelectedIds.delete(a.id);
      }
    });
    logsListEl.appendChild(div);
  });
}

(function() {
  var today = new Date().toISOString().slice(0,10);
  document.getElementById('logsDateFrom').value = today;
  document.getElementById('logsDateTo').value   = today;
  logsRenderList('');

  var logsSearchEl = document.getElementById('logsSearch');
  logsSearchEl.addEventListener('input', function(e) { logsRenderList(e.target.value); });
  logsSearchEl.addEventListener('keyup',  function(e) { logsRenderList(e.target.value); });

  document.getElementById('logsSelectAll').addEventListener('click', function() {
    logsListEl.querySelectorAll('input').forEach(function(cb) {
      cb.checked = true;
      logsSelectedIds.add(cb.dataset.id);
    });
  });
  document.getElementById('logsSelectNone').addEventListener('click', function() {
    logsListEl.querySelectorAll('input').forEach(function(cb) { cb.checked = false; });
    logsSelectedIds.clear();
  });

  document.getElementById('logsExportBtn').addEventListener('click', function() {
    if (logsAllBreaks.length) logsExportXls(logsAllBreaks, document.getElementById('logsDateFrom').value);
  });

  document.getElementById('logsStartBtn').addEventListener('click', logsStartParsing);
})();

function logsShowError(msg) {
  var el = document.getElementById('logsError');
  el.textContent = msg; el.style.display = msg ? 'block' : 'none';
}

function logsStartParsing() {
  logsShowError('');

  var selected = [...logsSelectedIds];

  var manualRaw = document.getElementById('logsManualId').value.trim();
  if (manualRaw) {
    manualRaw.split(/[\s,;]+/).forEach(function(id) {
      id = id.trim();
      if (/^\d+$/.test(id) && selected.indexOf(id) === -1) selected.push(id);
    });
  }

  if (!selected.length) { logsShowError('Выберите хотя бы одного аналитика или введите ID'); return; }

  var dateFrom = document.getElementById('logsDateFrom').value;
  var dateTo   = document.getElementById('logsDateTo').value;
  if (!dateFrom || !dateTo) { logsShowError('Укажите даты'); return; }

  var dfmt  = logsFormatDate(dateFrom, document.getElementById('logsTimeFrom').value || '00:00', false);
  var dtfmt = logsFormatDate(dateTo,   document.getElementById('logsTimeTo').value   || '23:59', true);
  var minGap        = parseInt(document.getElementById('logsMinGap').value)        || 30;
  var lateThreshold = parseInt(document.getElementById('logsLateThreshold').value) || 300;

  var startBtn  = document.getElementById('logsStartBtn');
  var exportBtn = document.getElementById('logsExportBtn');
  var progDiv   = document.getElementById('logsProgress');
  var progText  = document.getElementById('logsProgressText');
  var progFill  = document.getElementById('logsProgressFill');
  var resDiv    = document.getElementById('logsResults');

  startBtn.disabled = true; exportBtn.disabled = true;
  progDiv.style.display = 'block'; resDiv.style.display = 'none';
  logsAllBreaks = [];

  var allRecords = [], errors = [], idx = 0;

  function next() {
    if (idx >= selected.length) {
      logsAllBreaks = logsAnalyzeBreaks(allRecords, minGap, lateThreshold);
      progDiv.style.display = 'none'; resDiv.style.display = 'block';

      var lc = logsAllBreaks.filter(function(b){ return b.isLate; }).length;
      var html =
        '<span class="logs-chip">Записей: <b>' + allRecords.length + '</b></span>' +
        '<span class="logs-chip accent">Перерывов ≥' + minGap + ' мин: <b>' + logsAllBreaks.length + '</b></span>' +
        (lc ? '<span class="logs-chip warn">Опозданий: <b>' + lc + '</b></span>' : '') +
        (errors.length ? '<span class="logs-chip err">Ошибки: ' + errors.join('; ') + '</span>' : '');
      document.getElementById('logsResultSummary').innerHTML = html;

      startBtn.disabled = false;
      if (logsAllBreaks.length) { exportBtn.disabled = false; logsExportXls(logsAllBreaks, dateFrom); }
      return;
    }

    var uid  = selected[idx];
    var a    = ANALYSTS.find(function(x){ return x.id === uid; });
    var name = a ? a.name : ('ID:' + uid);
    progText.textContent = name + ' — загрузка...';
    progFill.style.width = (idx / selected.length * 100) + '%';

    (function() {
      var page = 1, MAX = 200;
      function go() {
        if (page > MAX) return Promise.resolve();
        progText.textContent = name + ' — стр. ' + page;
        return logsFetchPage(logsBuildUrl(uid, page, dfmt, dtfmt)).then(function(doc) {
          var dts = logsParseDatetimes(doc);
          dts.forEach(function(dt){ allRecords.push({ employee: name, datetime: dt }); });
          if (!dts.length) return;
          page++;
          return new Promise(function(r){ setTimeout(r, 200); }).then(go);
        });
      }
      return go();
    })().then(function() {
      idx++; progFill.style.width = (idx / selected.length * 100) + '%'; next();
    }).catch(function(err) {
      errors.push(name + ': ' + err.message); idx++; next();
    });
  }

  next();
}

// ── Table render ──────────────────────────────────────────────────────────────

function renderTable() {
  if (!rows.length) { tableContainer.innerHTML = ''; return; }

  const cols = getActiveColumns();
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const thCopy = document.createElement('th');
  thCopy.textContent = '';
  headerRow.appendChild(thCopy);
  cols.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach(row => {
    const tr = document.createElement('tr');

    // Copy button cell
    const tdCopy = document.createElement('td');
    const cpBtn = document.createElement('button');
    cpBtn.textContent = '⎘';
    cpBtn.title = 'Копировать строку';
    cpBtn.className = 'row-copy-btn';
    cpBtn.addEventListener('click', () => {
      const tsv = cols.map(col => formatCell(col, row[col])).join('\t');
      navigator.clipboard.writeText(tsv).then(() => {
        cpBtn.textContent = '✓';
        setTimeout(() => { cpBtn.textContent = '⎘'; }, 1200);
      });
    });
    tdCopy.appendChild(cpBtn);
    tr.appendChild(tdCopy);

    cols.forEach(col => {
      const td = document.createElement('td');
      const val = row[col] || '';
      if (col === 'Ссылка' && val) {
        const a = document.createElement('a');
        a.href = val;
        a.textContent = 'Открыть';
        a.target = '_blank';
        td.appendChild(a);
      } else {
        const inner = document.createElement('div');
        inner.className = 'cell-inner';
        inner.textContent = val;
        td.appendChild(inner);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  tableContainer.innerHTML = '';
  tableContainer.appendChild(wrap);
}

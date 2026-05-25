/* drum.ai — frontend (API unchanged) */

let bots = [];
let currentBot = null;
let chatId = Date.now();
let sending = false;
let typingEl = null;
let currentView = 'discover';

const messages = document.getElementById('messages');
const chatPage = document.getElementById('chatPage');
const appShell = document.getElementById('appShell');
const messagesLimitPopup = document.getElementById('messagesLimitPopup');
const loginScreen = document.getElementById('loginScreen');

const STORAGE_KEY = 'drumai_storage_v1';
const WALLPAPER_KEY = 'drumai_live_wallpaper';
const USER_KEY = 'drumai_user_v1';
const MESSAGE_BALANCE_KEY = 'drumai_message_balance_v1';
const PURCHASE_BACKUP_KEY = 'drumai_purchase_backup_v1';

const INITIAL_MESSAGE_BALANCE = 100;
const AD_REWARD_MESSAGES = 50;
const AD_VIEW_MIN_MS = 8000;
const ADSENSE_CLIENT = 'ca-pub-3098007197721707';
const AD_SLOT_MIN_WIDTH = 300;
const AD_SLOT_MIN_HEIGHT = 90;
const AD_LAYOUT_DELAY_MS = 450;
const AD_SIZE_WAIT_MS = 4000;

let serverBalance = 0;

const PURCHASE_PACKS = {
  pack1000: { messages: 1000, label: '1000 сообщений за 0.99$' },
  pack5000: { messages: 5000, label: '5000 сообщений за 2.99$' },
  pack10000: { messages: 10000, label: '10000 сообщений за 3.99$' },
  premiumWeek: { messages: 0, label: 'Премиум на неделю', premium: true },
  premiumMonth: { messages: 0, label: 'Премиум на месяц', premium: true },
};

let rewardAdTimer = null;
let rewardAdStartedAt = 0;
let rewardAdViewing = false;
let rewardAdCompleted = false;
let rewardAdLoaded = false;

let currentUser = null;
const MEMORY_LIMIT = 30;
const TYPEWRITER_MIN_MS = 10;
const TYPEWRITER_MAX_MS = 28;

const BOT_TYPES = [
  'Романтика',
  'Свидание',
  'Гей',
  'Демон',
  'Аниме',
  'Фэнтези',
  'Хоррор',
  'Драма',
  'Комедия',
  'Мистика',
];

const SEARCH_TAGS = [...BOT_TYPES, 'Другое'];

/* ========================= NAVIGATION ========================= */
function navigateTo(view) {
  if (!view) return;
  currentView = view;

  document.querySelectorAll('.view').forEach((el) => {
    const isActive = el.id === `view-${view}`;
    el.classList.toggle('view-active', isActive);
    el.hidden = !isActive;
  });

  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach((btn) => {
    const match = btn.dataset.view === view;
    btn.classList.toggle('active', match);
  });

  if (view === 'chats') renderChatsList();
  if (view === 'search') initSearchView();
  if (view === 'discover') refreshBotList();
  if (view === 'create') updateCreateAccess();
  if (view === 'balance') {
    fetchBalance().then(() => updateMessageBalanceUI());
  }
}

function initNavigation() {
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'settings' && window.innerWidth < 768) {
        navigateTo('settings');
        return;
      }
      navigateTo(view);
    });
  });
}

function showAppShell() {
  if (appShell) appShell.removeAttribute('hidden');
  if (chatPage) {
    chatPage.setAttribute('hidden', '');
    chatPage.style.display = '';
  }
}

function hideAppShell() {
  if (appShell) appShell.setAttribute('hidden', '');
}

/* ========================= STORAGE ========================= */
function getDefaultStorage() {
  return { bots: [], sessions: [], messages: {} };
}

function loadStorageData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultStorage();
    const data = JSON.parse(raw);
    return {
      bots: Array.isArray(data.bots) ? data.bots : [],
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      messages: data.messages && typeof data.messages === 'object' ? data.messages : {},
    };
  } catch (err) {
    console.error('loadStorageData', err);
    return getDefaultStorage();
  }
}

function saveStorageData(data) {
  try {
    const payload = {
      bots: Array.isArray(data.bots) ? data.bots : [],
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      messages: data.messages && typeof data.messages === 'object' ? data.messages : {},
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error('saveStorageData', err);
    return false;
  }
}

function normalizeBot(bot) {
  if (!bot) return null;
  return {
    id: bot.id,
    name: bot.name || 'Персонаж',
    personality: bot.personality || '',
    scenario: bot.scenario || '',
    avatar: bot.avatar || 'https://i.imgur.com/8Km9tLL.png',
    genre: bot.genre || 'Другое',
    gender: bot.gender || 'female',
    greeting: bot.greeting || '',
    exampleDialogue: bot.exampleDialogue || '',
    mood: bot.mood || 'neutral',
    authorId: bot.authorId != null ? String(bot.authorId) : '',
    authorName: bot.authorName || '',
    authorEmail: bot.authorEmail || '',
    authorAvatar: bot.authorAvatar || '',
  };
}

function getAuthorPayload() {
  if (!currentUser) return {};
  return {
    authorId: currentUser.id != null ? String(currentUser.id) : '',
    authorName: currentUser.name || '',
    authorEmail: currentUser.email || '',
    authorAvatar: currentUser.avatar || '',
  };
}

function getAuthorDisplayName(b) {
  const name = (b.authorName || '').trim();
  if (name) return name;
  const email = (b.authorEmail || '').trim();
  if (email) return email.split('@')[0];
  const id = (b.authorId || '').trim();
  if (id) return id;
  return 'Unknown';
}

function buildCreatedByHTML(b) {
  const display = escapeHtml(getAuthorDisplayName(b));
  return `<p class="bot-created-by">Created by: ${display}</p>`;
}

function isCurrentUserAdmin() {
  return !!(currentUser && currentUser.isAdmin);
}

function canDeleteBot(bot) {
  if (!bot || !currentUser || !currentUser.email) return false;
  if (isCurrentUserAdmin()) return true;

  const userEmail = String(currentUser.email).trim().toLowerCase();
  const authorEmail = String(bot.authorEmail || '').trim().toLowerCase();
  if (authorEmail && authorEmail === userEmail) return true;

  const userId = currentUser.id != null ? String(currentUser.id) : '';
  const authorId = bot.authorId != null ? String(bot.authorId) : '';
  if (authorId && userId && authorId === userId) return true;

  return false;
}

function mergeBots(serverBots, localBots) {
  const map = new Map();
  (localBots || []).forEach((b) => {
    const n = normalizeBot(b);
    if (n) map.set(String(n.id), n);
  });
  (serverBots || []).forEach((b) => {
    const key = String(b.id);
    const prev = map.get(key) || {};
    map.set(key, normalizeBot({ ...prev, ...b }));
  });
  return Array.from(map.values());
}

function saveBotsToStorage(list) {
  const data = loadStorageData();
  data.bots = list || [];
  saveStorageData(data);
}

function saveBotToStorage(bot) {
  if (!bot) return;
  const data = loadStorageData();
  const idx = data.bots.findIndex((b) => String(b.id) === String(bot.id));
  if (idx >= 0) data.bots[idx] = { ...data.bots[idx], ...bot };
  else data.bots.push(bot);
  saveStorageData(data);
}

function removeBotFromStorage(botId) {
  const data = loadStorageData();
  data.bots = data.bots.filter((b) => String(b.id) !== String(botId));
  const removed = data.sessions.filter((s) => String(s.botId) === String(botId));
  removed.forEach((s) => {
    delete data.messages[String(s.chatId)];
  });
  data.sessions = data.sessions.filter((s) => String(s.botId) !== String(botId));
  saveStorageData(data);
}

function registerChatSession(bot, cid) {
  if (!bot || !cid) return;
  const data = loadStorageData();
  const key = String(cid);
  let exists = data.sessions.find((s) => String(s.chatId) === key);
  if (!exists) {
    data.sessions.unshift({
      chatId: cid,
      botId: bot.id,
      botName: bot.name || 'Бот',
      botAvatar: bot.avatar || '',
      title: bot.name || 'Чат',
      lastMessage: '',
      updatedAt: Date.now(),
      createdAt: Date.now(),
    });
  } else {
    exists.botName = bot.name || exists.botName;
    exists.botAvatar = bot.avatar || exists.botAvatar;
    exists.title = bot.name || exists.title;
  }
  saveStorageData(data);
}

function getChatMessages(cid) {
  const data = loadStorageData();
  const list = data.messages[String(cid)];
  return Array.isArray(list) ? list : [];
}

function persistChatMessage(cid, text, isUser, opts = {}) {
  if (!cid) return;
  const data = loadStorageData();
  const key = String(cid);
  if (!data.messages[key]) data.messages[key] = [];
  data.messages[key].push({
    role: isUser ? 'user' : 'assistant',
    text: String(text || ''),
    ts: Date.now(),
    scenario: !!opts.scenario,
    opening: !!opts.opening,
  });
  const session = data.sessions.find((s) => String(s.chatId) === key);
  if (session) {
    session.lastMessage = String(text || '').slice(0, 120);
    session.updatedAt = Date.now();
    data.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  saveStorageData(data);
}

function findLatestSessionForBot(botId) {
  const data = loadStorageData();
  return (
    data.sessions
      .filter((s) => String(s.botId) === String(botId))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null
  );
}

/* ========================= HELPERS ========================= */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}

function getSearchQuery() {
  const el = document.getElementById('searchInput');
  return el ? el.value.trim() : '';
}

function resolveBot(botId, session) {
  if (botId == null) return null;
  let bot = bots.find((b) => String(b.id) === String(botId));
  if (bot) return bot;
  const data = loadStorageData();
  bot = (data.bots || []).find((b) => String(b.id) === String(botId));
  if (bot) {
    bots.push(bot);
    saveBotsToStorage(bots);
    return bot;
  }
  if (session) {
    return normalizeBot({
      id: session.botId,
      name: session.botName || 'Бот',
      avatar: session.botAvatar || '',
      personality: '',
      scenario: '',
      genre: '',
      gender: 'female',
      greeting: '',
      exampleDialogue: '',
      mood: 'neutral',
    });
  }
  return null;
}

function truncateSnippet(text, max = 72) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + '…';
}

function buildBotCardHTML(b) {
  const personality = truncateSnippet(b.personality, 64);
  const scenario = truncateSnippet(b.scenario, 80);
  const genre = escapeHtml(b.genre || 'Другое');
  const deleteBtn = canDeleteBot(b)
    ? `<button type="button" class="delete-btn" onclick="event.stopPropagation(); deleteBot(${b.id})" aria-label="Удалить">✕</button>`
    : '';

  return `
    <article class="bot-card" onclick="openChat(${b.id})" style="animation-delay:${Math.random() * 0.15}s">
      <div class="bot-card-media">
        <img src="${escapeAttr(b.avatar)}" alt="${escapeAttr(b.name)}" loading="lazy">
        <div class="bot-card-shade" aria-hidden="true"></div>
        ${deleteBtn}
        ${buildCreatedByHTML(b)}
        <div class="bot-card-overlay">
          <div class="bot-card-meta-row">
            <span class="bot-type-badge">${genre}</span>
          </div>
          <h3 class="bot-name">${escapeHtml(b.name)}</h3>
          ${personality ? `<p class="bot-snippet bot-snippet-trait">${escapeHtml(personality)}</p>` : ''}
          ${scenario ? `<p class="bot-snippet bot-snippet-plot">${escapeHtml(scenario)}</p>` : ''}
        </div>
      </div>
    </article>`;
}

function scrollMessages() {
  if (!messages) return;
  messages.scrollTop = messages.scrollHeight;
}

function appendMessage(text, isUser, opts = {}) {
  if (!messages) return null;
  const el = document.createElement('div');
  el.className = 'msg' + (isUser ? ' user' : '');
  el.textContent = text;
  messages.appendChild(el);
  scrollMessages();
  if (opts.persist !== false && chatId && currentBot) {
    persistChatMessage(chatId, text, isUser, {
      scenario: !!opts.scenario,
      opening: !!opts.opening,
    });
  }
  return el;
}

function buildApiHistory(cid) {
  if (!cid) return [];
  return getChatMessages(cid)
    .filter((m) => m && m.text && !m.scenario && !m.opening)
    .slice(-MEMORY_LIMIT)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: String(m.text || '').trim(),
    }))
    .filter((m) => m.content);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function appendMessageTypewriter(text, opts = {}) {
  opts = opts || {};
  hideTyping();
  if (!messages) return null;
  let fullText = String(text || '').trim();
  if (!fullText) fullText = '…';
  const el = document.createElement('div');
  el.className = 'msg';
  messages.appendChild(el);
  let built = '';
  for (let i = 0; i < fullText.length; i++) {
    built += fullText[i];
    el.textContent = built;
    scrollMessages();
    await delay(TYPEWRITER_MIN_MS + Math.random() * (TYPEWRITER_MAX_MS - TYPEWRITER_MIN_MS));
  }
  if (opts.persist !== false && chatId && currentBot) {
    persistChatMessage(chatId, fullText, false, opts);
  }
  return el;
}

function showOpeningMessages() {
  if (!currentBot || !chatId) return;
  const history = getChatMessages(chatId);
  if (history.length) return;
  currentBot = normalizeBot(currentBot);
  const greeting = (currentBot.greeting || '').trim();
  const scenario = (currentBot.scenario || '').trim();
  if (greeting) appendMessage(greeting, false, { opening: true });
  if (scenario) appendMessage('📖 ' + scenario, false, { scenario: true });
}

function showTyping() {
  if (!messages) return;
  hideTyping();
  typingEl = document.createElement('div');
  typingEl.className = 'msg typing';
  typingEl.id = 'typingIndicator';
  typingEl.textContent = 'печатает...';
  messages.appendChild(typingEl);
  scrollMessages();
}

function hideTyping() {
  if (typingEl && typingEl.parentNode) typingEl.remove();
  typingEl = null;
  const stuck = document.getElementById('typingIndicator');
  if (stuck) stuck.remove();
}

function sanitizeReply(reply, bot) {
  if (!reply || typeof reply !== 'string') return '';
  let out = reply.trim();
  if (!bot) return out;
  const scenario = (bot.scenario || '').trim();
  if (scenario) out = out.split(scenario).join('').trim();
  out = out.replace(/📖\s*Сюжет\s*:\s*/gi, '');
  out = out.replace(/^Сюжет\s*:\s*/gim, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function renderChatHistoryFromStorage(cid) {
  if (!messages || !cid) return;
  const history = getChatMessages(cid);
  messages.innerHTML = '';
  history.forEach((m) => {
    if (m) appendMessage(m.text, m.role === 'user', { persist: false });
  });
  scrollMessages();
}

/* ========================= BOTS LIST ========================= */
async function loadBots() {
  const localData = loadStorageData();
  const localBots = Array.isArray(localData.bots) ? localData.bots : [];
  bots = localBots.slice();
  refreshBotList();
  try {
    const r = await fetch('/bots');
    const serverBots = await r.json();
    bots = mergeBots(Array.isArray(serverBots) ? serverBots : [], localBots);
  } catch (err) {
    console.error(err);
    bots = localBots.slice();
  }
  if (!Array.isArray(bots)) bots = [];
  saveBotsToStorage(bots);
  refreshBotList();
}

function renderBotList(list, containerId = 'botList') {
  const box = document.getElementById(containerId);
  if (!box) return;
  const items = Array.isArray(list) ? list : [];
  box.innerHTML = '';
  items.forEach((b) => {
    if (!b || b.id == null) return;
    box.insertAdjacentHTML('beforeend', buildBotCardHTML(b));
  });
  const empty = document.getElementById('discoverEmpty');
  if (empty && containerId === 'botList') {
    empty.classList.toggle('hidden', items.length > 0);
  }
}

function render() {
  if (!Array.isArray(bots)) bots = [];
  renderBotList(bots);
}

function refreshBotList() {
  if (!Array.isArray(bots)) bots = [];
  if (currentView === 'search') {
    searchBots(getSearchQuery());
  } else {
    render();
  }
}

function searchBots(value) {
  if (!Array.isArray(bots)) bots = [];
  const q = (value || '').trim().toLowerCase();
  const filtered = !q
    ? bots
    : bots.filter(
        (b) =>
          b &&
          (String(b.name || '').toLowerCase().includes(q) ||
            String(b.genre || '').toLowerCase().includes(q) ||
            String(b.personality || '').toLowerCase().includes(q))
      );
  renderBotList(filtered, 'botList');
  const results = document.getElementById('searchResults');
  if (results) renderBotList(filtered, 'searchResults');
}

function initSearchView() {
  const input = document.getElementById('searchInput');
  const tags = document.getElementById('searchSuggestions');
  if (tags && !tags.dataset.ready) {
    tags.dataset.ready = '1';
    tags.innerHTML = SEARCH_TAGS.map(
      (t, i) =>
        `<button type="button" class="search-tag" style="animation-delay:${i * 0.06}s" data-tag="${escapeAttr(t)}">${escapeHtml(t)}</button>`
    ).join('');
    tags.querySelectorAll('.search-tag').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (input) {
          input.value = btn.dataset.tag || '';
          searchBots(input.value);
        }
      });
    });
  }
  if (input && !input.dataset.bound) {
    input.dataset.bound = '1';
    input.addEventListener('input', () => searchBots(input.value));
  }
  searchBots(input ? input.value : '');
}

/* ========================= CREATE BOT ========================= */
function isLoggedIn() {
  return !!(currentUser && currentUser.email);
}

function updateCreateAccess() {
  const gate = document.getElementById('createLoginGate');
  const formWrap = document.getElementById('createFormWrap');
  const loggedIn = isLoggedIn();

  if (gate) gate.classList.toggle('hidden', loggedIn);
  if (formWrap) formWrap.classList.toggle('hidden', !loggedIn);

  document.querySelectorAll('[data-view="create"]').forEach((btn) => {
    btn.classList.toggle('nav-locked', !loggedIn);
    btn.title = loggedIn ? '' : 'Сначала войди в drum.ai';
  });
}

function getSelectedGenre() {
  const genreEl = document.getElementById('genre');
  const otherEl = document.getElementById('genreOther');
  if (!genreEl) return 'Другое';
  if (genreEl.value === 'Другое') {
    const custom = otherEl ? otherEl.value.trim() : '';
    return custom || 'Другое';
  }
  return genreEl.value;
}

function initCreateForm() {
  const nameInput = document.getElementById('name');
  const nameCount = document.getElementById('nameCount');
  if (nameInput && nameCount) {
    const updateCount = () => {
      nameCount.textContent = `${nameInput.value.length}/20`;
    };
    nameInput.addEventListener('input', updateCount);
    updateCount();
  }

  const genreEl = document.getElementById('genre');
  const genreOtherWrap = document.getElementById('genreOtherWrap');
  if (genreEl && genreOtherWrap) {
    const syncGenreOther = () => {
      const show = genreEl.value === 'Другое';
      genreOtherWrap.classList.toggle('hidden', !show);
    };
    genreEl.addEventListener('change', syncGenreOther);
    syncGenreOther();
  }

  document.querySelectorAll('.gender-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.gender-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const hidden = document.getElementById('gender');
      if (hidden) hidden.value = btn.dataset.gender || 'female';
    });
  });
}

async function createBot() {
  if (!isLoggedIn()) {
    alert('Сначала войди в drum.ai через Google');
    navigateTo('settings');
    return;
  }

  const name = document.getElementById('name').value.trim();
  const personality = document.getElementById('personality').value.trim();
  const genre = getSelectedGenre();

  if (!name || !personality) {
    alert('Заполни имя и характер бота');
    return;
  }

  const genreSelectVal = document.getElementById('genre')?.value;
  if (genreSelectVal === 'Другое' && !document.getElementById('genreOther')?.value.trim()) {
    alert('Укажи свой тип в поле «Свой тип» или выбери другой из списка');
    return;
  }

  try {
    const res = await fetch('/create-bot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        name,
        personality,
        scenario: document.getElementById('scenario').value,
        avatar: document.getElementById('avatar').value,
        genre,
        gender: document.getElementById('gender').value,
        ...getAuthorPayload(),
      }),
    });
    const data = await res.json();
    if (data && data.success === false) {
      alert(data.error || 'Не удалось создать бота');
      return;
    }
    if (data && data.bot) saveBotToStorage(normalizeBot(data.bot));
    document.getElementById('name').value = '';
    document.getElementById('personality').value = '';
    document.getElementById('scenario').value = '';
    document.getElementById('avatar').value = '';
    const genreSelect = document.getElementById('genre');
    if (genreSelect) genreSelect.value = 'Романтика';
    const genreOther = document.getElementById('genreOther');
    if (genreOther) genreOther.value = '';
    document.getElementById('genreOtherWrap')?.classList.add('hidden');
    await loadBots();
    navigateTo('discover');
  } catch (err) {
    console.error(err);
    const fallbackBot = normalizeBot({
      id: Date.now(),
      name,
      personality,
      scenario: document.getElementById('scenario').value,
      avatar: document.getElementById('avatar').value || 'https://i.imgur.com/8Km9tLL.png',
      genre,
      gender: document.getElementById('gender').value,
      greeting: '',
      exampleDialogue: '',
      mood: 'neutral',
      ...getAuthorPayload(),
    });
    saveBotToStorage(fallbackBot);
    bots = loadStorageData().bots || [];
    navigateTo('discover');
    refreshBotList();
    alert('Сервер недоступен — бот сохранён локально');
  }
}

async function deleteBot(id) {
  const bot =
    bots.find((b) => String(b.id) === String(id)) ||
    loadStorageData().bots.find((b) => String(b.id) === String(id));

  if (!canDeleteBot(bot)) {
    alert('You do not have permission to delete this bot.');
    return;
  }

  if (!confirm('Точно удалить этого бота?')) return;

  try {
    const res = await fetch('/delete-bot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      alert(data.error || 'You do not have permission to delete this bot.');
      return;
    }
    removeBotFromStorage(id);
    await loadBots();
  } catch (err) {
    console.error(err);
    alert('Не удалось удалить бота. Проверь подключение к серверу.');
  }
}

/* ========================= CHATS ========================= */
function formatChatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderChatsList() {
  const box = document.getElementById('chatsList');
  const empty = document.getElementById('chatsEmpty');
  if (!box) return;
  const data = loadStorageData();
  const sessions = (data.sessions || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  box.innerHTML = '';
  if (!sessions.length) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  sessions.forEach((s, i) => {
    const bot = bots.find((b) => String(b.id) === String(s.botId));
    const avatar = s.botAvatar || (bot && bot.avatar) || '';
    const name = s.botName || (bot && bot.name) || 'Чат';
    const preview = s.lastMessage || 'Нет сообщений';
    const time = formatChatDate(s.updatedAt);
    box.insertAdjacentHTML(
      'beforeend',
      `
      <div class="chat-session-item" style="animation-delay:${i * 0.05}s" onclick="resumeChatSession(${s.chatId})">
        <img src="${escapeAttr(avatar)}" alt="">
        <div class="chat-session-meta">
          <div class="chat-session-name">${escapeHtml(name)}</div>
          <div class="chat-session-preview">${escapeHtml(preview)}</div>
        </div>
        <div class="chat-session-date">${escapeHtml(time)}</div>
      </div>`
    );
  });
}

function openChatUI() {
  if (!currentBot) return;
  hideAppShell();
  if (chatPage) {
    chatPage.removeAttribute('hidden');
    chatPage.style.display = 'flex';
  }
  const chatAvatar = document.getElementById('chatAvatar');
  const chatName = document.getElementById('chatName');
  if (chatAvatar) chatAvatar.src = currentBot.avatar || '';
  if (chatName) chatName.textContent = currentBot.name || '';
  updateMessageBalanceUI();
  applyChatInputLock();
  if (getMessageBalance() <= 0) openMessagesLimitPopup();
}

function resumeChatSession(cid) {
  if (cid == null) return;
  const data = loadStorageData();
  const session = (data.sessions || []).find((s) => String(s.chatId) === String(cid));
  if (!session) {
    alert('Чат не найден');
    return;
  }
  currentBot = resolveBot(session.botId, session);
  if (!currentBot) {
    alert('Бот для этого чата не найден');
    return;
  }
  currentBot = normalizeBot(currentBot);
  chatId = session.chatId;
  openChatUI();
  const history = getChatMessages(chatId);
  if (history.length) renderChatHistoryFromStorage(chatId);
  else {
    if (messages) messages.innerHTML = '';
    showOpeningMessages();
  }
}

function startNewChatSession() {
  if (!currentBot) return;
  chatId = Date.now();
  registerChatSession(currentBot, chatId);
  if (messages) messages.innerHTML = '';
  showOpeningMessages();
}

function openChat(id) {
  if (id == null) return;
  currentBot = resolveBot(id, null);
  if (!currentBot) {
    alert('Бот не найден');
    return;
  }
  currentBot = normalizeBot(currentBot);
  const latest = findLatestSessionForBot(id);
  openChatUI();
  if (latest && latest.chatId != null) {
    chatId = latest.chatId;
    const history = getChatMessages(chatId);
    if (history.length) {
      renderChatHistoryFromStorage(chatId);
      return;
    }
    if (messages) messages.innerHTML = '';
    showOpeningMessages();
    return;
  }
  startNewChatSession();
}

function resetChat() {
  if (!confirm('Новый чат?')) return;
  if (!currentBot) return;
  startNewChatSession();
}

function back() {
  showAppShell();
  navigateTo(currentView === 'chats' ? 'chats' : 'discover');
}

/* ========================= AI ========================= */
function getBotPayload() {
  if (!currentBot) return null;
  const b = normalizeBot(currentBot);
  return {
    name: b.name,
    personality: b.personality,
    scenario: b.scenario,
    gender: b.gender,
    genre: b.genre,
    greeting: b.greeting,
    exampleDialogue: b.exampleDialogue,
    mood: b.mood,
  };
}

async function fetchAIReply(userText) {
  if (!currentBot || !chatId) return '';
  const history = buildApiHistory(chatId);
  const res = await fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      botId: currentBot.id,
      chatId,
      message: userText,
      history,
      bot: getBotPayload(),
    }),
  });
  const data = await res.json();
  if (!data || data.error) {
    if (data.requireLogin) {
      throw new Error('requireLogin');
    }
    if (data.outOfMessages) {
      throw new Error('outOfMessages');
    }
    throw new Error((data && data.message) || 'AI error');
  }
  return sanitizeReply(data.reply, currentBot);
}

function generateReply(text, bot) {
  const t = (text || '').toLowerCase();
  const isFemale = bot.gender === 'female';
  const name = bot.name || 'персонаж';
  if (bot.greeting && t.includes('привет')) return bot.greeting;
  if (t.includes('привет')) {
    return isFemale ? `*улыбается* Привет. Я ${name}.` : `*кивает* Привет. Я ${name}.`;
  }
  if (t.includes('люблю')) {
    return isFemale
      ? `*смотрит с интересом*\n\nНе ожидала услышать такое.`
      : `*усмехнулся*\n\nИнтересное заявление.`;
  }
  if (t.includes('грустно') || t.includes('плохо')) {
    return isFemale
      ? `*садится рядом*\n\nСегодня явно не лучший день…`
      : `*вздохнул*\n\nБывают тяжёлые дни.`;
  }
  const trait = (bot.personality || '').trim();
  if (trait) {
    return [
      `*задумался*\n\n${trait}`,
      `*усмехнулся*\n\nНу это уже ближе к делу.`,
      `*посмотрел внимательно*\n\nНе всё так очевидно.`,
      `*слегка улыбнулся*\n\nЛюбопытно получилось.`,
      `*наклонил голову*\n\nУ меня есть мысли по этому поводу.`,
    ][Math.floor(Math.random() * 5)];
  }
  const randomReplies = [
    `*усмехнулся*\n\nНеожиданный ход.`,
    `*посмотрел внимательно*\n\nВот это уже интереснее.`,
    `*задумался*\n\nНе уверен что всё настолько просто.`,
    `*слегка кивнул*\n\nПродолжим.`,
    `*вздохнул*\n\nМир странная штука.`,
    `*прищурился*\n\nЕсть ощущение что это ещё не конец.`,
    `*улыбнулся уголком губ*\n\nМне нравится куда всё идёт.`,
    `*отвёл взгляд*\n\nХм. Любопытно.`,
  ];
  return randomReplies[Math.floor(Math.random() * randomReplies.length)];
}

async function send() {
  if (sending) return;
  if (!currentBot) {
    alert('Сначала выбери бота из списка');
    return;
  }
  if (!canSendMessage()) {
    openMessagesLimitPopup();
    return;
  }
  currentBot = normalizeBot(currentBot);
  if (!chatId) chatId = Date.now();
  registerChatSession(currentBot, chatId);
  const input = document.getElementById('msgInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!consumeMessage()) {
    applyChatInputLock();
    openMessagesLimitPopup();
    return;
  }
  updateMessageBalanceUI();
  input.value = '';
  sending = true;
  let reply = '';
  try {
    appendMessage(text, true);
    showTyping();
    reply = await fetchAIReply(text);
    if (!reply) reply = generateReply(text, currentBot);
  } catch (err) {
    console.error(err);
    hideTyping();
    if (err.message === 'requireLogin') {
      alert('Войдите через Google для использования чата');
      navigateTo('settings');
      sending = false;
      return;
    }
    if (err.message === 'outOfMessages') {
      fetchBalance().then(() => {
        updateMessageBalanceUI();
        applyChatInputLock();
        openMessagesLimitPopup();
      });
      sending = false;
      return;
    }
    reply = generateReply(text, currentBot);
    if (!reply) reply = 'Не удалось получить ответ. Проверь сервер и API ключ.';
  }
  hideTyping();
  if (!reply) reply = '…';
  try {
    await appendMessageTypewriter(reply, { persist: true });
  } catch (err) {
    console.error(err);
    appendMessage(reply, false);
  } finally {
    sending = false;
  }
}

/* ========================= AUTH ========================= */
function saveUserLocal(user) {
  if (!user) {
    localStorage.removeItem(USER_KEY);
    return;
  }
  localStorage.setItem(
    USER_KEY,
    JSON.stringify({
      id: user.id != null ? String(user.id) : '',
      name: user.name || '',
      email: user.email || '',
      avatar: user.avatar || '',
      isAdmin: !!user.isAdmin,
    })
  );
}

function loadUserLocal() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchBalance() {
  try {
    const res = await fetch('/api/balance', { credentials: 'same-origin' });
    const data = await res.json();
    serverBalance = data.balance || 0;
    return serverBalance;
  } catch (err) {
    console.error('fetchBalance', err);
    return 0;
  }
}

async function addBalance(amount) {
  try {
    const res = await fetch('/api/balance/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ amount }),
    });
    const data = await res.json();
    if (data.success) {
      serverBalance = data.balance;
      return serverBalance;
    }
    return null;
  } catch (err) {
    console.error('addBalance', err);
    return null;
  }
}

function getMessageBalance() {
  return serverBalance;
}

function canSendMessage() {
  return getMessageBalance() > 0;
}

function consumeMessage() {
  if (serverBalance <= 0) return false;
  serverBalance--;
  return true;
}

function updateMessageBalanceUI() {
  const balanceEl = document.getElementById('msgBalance');
  const chatBalanceEl = document.getElementById('chatMsgBalance');
  if (balanceEl) balanceEl.textContent = serverBalance;
  if (chatBalanceEl) chatBalanceEl.textContent = serverBalance;
}

function applyChatInputLock() {
  const input = document.getElementById('msgInput');
  const sendBtn = document.getElementById('btnSend');
  const locked = !canSendMessage();
  if (input) {
    input.disabled = locked;
    input.placeholder = locked ? 'Сообщения закончились' : 'Напиши что нибудь.....';
  }
  if (sendBtn) {
    sendBtn.disabled = locked;
    sendBtn.style.opacity = locked ? '0.5' : '1';
  }
}

function openMessagesLimitPopup() {
  if (!messagesLimitPopup) return;
  messagesLimitPopup.hidden = false;
  hideRewardAdSection();
  if (rewardAdTimer) {
    clearInterval(rewardAdTimer);
    rewardAdTimer = null;
  }
  rewardAdViewing = false;
}

function closeMessagesLimitPopup() {
  if (rewardAdTimer) {
    clearInterval(rewardAdTimer);
    rewardAdTimer = null;
  }
  if (rewardAdViewing && !rewardAdCompleted) {
    rewardAdViewing = false;
    rewardAdLoaded = false;
  }
  hideRewardAdSection();
  if (messagesLimitPopup) messagesLimitPopup.hidden = true;
}

function goToPurchaseMessages() {
  closeMessagesLimitPopup();
  navigateTo('balance');
}

function showRewardAdSection() {
  const choices = document.getElementById('limitPopupChoices');
  const adSection = document.getElementById('limitPopupAd');
  if (choices) choices.classList.add('hidden');
  if (adSection) {
    adSection.hidden = false;
    adSection.classList.remove('hidden');
  }
  if (messagesLimitPopup) messagesLimitPopup.hidden = false;
}

function hideRewardAdSection() {
  const choices = document.getElementById('limitPopupChoices');
  const adSection = document.getElementById('limitPopupAd');
  const adSlot = document.getElementById('rewardAdSlot');
  if (choices) choices.classList.remove('hidden');
  if (adSection) {
    adSection.hidden = true;
    adSection.classList.add('hidden');
  }
  if (adSlot) adSlot.innerHTML = '';
}

function waitForNextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitForAdSlotSize(container, timeoutMs = AD_SIZE_WAIT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width > 0 && height >= AD_SLOT_MIN_HEIGHT) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

function waitForAdsenseReady() {
  return new Promise((resolve) => {
    if (window.adsbygoogle) {
      resolve(true);
      return;
    }
    const onReady = () => resolve(!!window.adsbygoogle);
    if (document.readyState === 'complete') {
      setTimeout(onReady, 50);
      return;
    }
    window.addEventListener('load', () => setTimeout(onReady, 50), { once: true });
  });
}

function pushAdsenseSlot(insEl) {
  if (!insEl || insEl.dataset.adInitialized === '1') return false;
  if (!window.adsbygoogle) return false;
  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
    insEl.dataset.adInitialized = '1';
    return true;
  } catch (err) {
    console.error('AdSense push error', err);
    return false;
  }
}

async function mountRewardAdSlot() {
  const adSlot = document.getElementById('rewardAdSlot');
  if (!adSlot) return false;

  adSlot.innerHTML = '';
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.style.display = 'block';
  ins.style.width = '100%';
  ins.style.minHeight = `${AD_SLOT_MIN_HEIGHT}px`;
  ins.setAttribute('data-ad-client', ADSENSE_CLIENT);
  ins.setAttribute('data-ad-format', 'auto');
  ins.setAttribute('data-full-width-responsive', 'true');
  adSlot.appendChild(ins);

  await waitForNextFrame();
  await waitForNextFrame();
  await new Promise((r) => setTimeout(r, AD_LAYOUT_DELAY_MS));

  const hasSize = await waitForAdSlotSize(adSlot);
  if (!hasSize) {
    console.warn('Ad slot has no measurable size yet', adSlot.getBoundingClientRect());
    return false;
  }

  await waitForAdsenseReady();
  return pushAdsenseSlot(ins);
}

function startRewardAdCountdown() {
  if (rewardAdTimer) clearInterval(rewardAdTimer);

  let countdown = Math.ceil(AD_VIEW_MIN_MS / 1000);
  const countdownEl = document.getElementById('adCountdown');
  if (countdownEl) countdownEl.textContent = `Осталось: ${countdown} сек`;

  rewardAdTimer = setInterval(() => {
    countdown--;
    if (countdownEl) {
      countdownEl.textContent =
        countdown > 0 ? `Осталось: ${countdown} сек` : 'Реклама просмотрена!';
    }
    if (countdown > 0) return;

    clearInterval(rewardAdTimer);
    rewardAdTimer = null;
    rewardAdCompleted = true;

    addBalance(AD_REWARD_MESSAGES).then(() => {
      updateMessageBalanceUI();
      applyChatInputLock();
      setTimeout(() => {
        closeMessagesLimitPopup();
        rewardAdViewing = false;
      }, 1500);
    });
  }, 1000);
}

function failRewardAd(message) {
  const countdownEl = document.getElementById('adCountdown');
  if (countdownEl) countdownEl.textContent = message || 'Реклама не загрузилась';
  setTimeout(() => {
    hideRewardAdSection();
    rewardAdViewing = false;
    rewardAdLoaded = false;
  }, 2000);
}

async function startRewardAd() {
  if (rewardAdViewing) return;
  rewardAdViewing = true;
  rewardAdCompleted = false;
  rewardAdLoaded = false;

  if (!messagesLimitPopup) {
    rewardAdViewing = false;
    return;
  }

  messagesLimitPopup.hidden = false;
  showRewardAdSection();

  const countdownEl = document.getElementById('adCountdown');
  if (countdownEl) countdownEl.textContent = 'Загрузка рекламы…';

  rewardAdLoaded = await mountRewardAdSlot();

  if (rewardAdLoaded) {
    startRewardAdCountdown();
  } else {
    failRewardAd('Реклама не загрузилась');
  }
}

document.getElementById('messagesLimitClose')?.addEventListener('click', closeMessagesLimitPopup);

function updateAuthUI(user) {
  currentUser = user || null;

  const guest = document.getElementById('authGuest');
  const authUser = document.getElementById('authUser');
  const settingsName = document.getElementById('settingsName');
  const settingsEmail = document.getElementById('settingsEmail');
  const settingsAvatar = document.getElementById('settingsAvatar');
  const sidebarAvatar = document.getElementById('sidebarAvatar');
  const sidebarPlaceholder = document.getElementById('sidebarAvatarPlaceholder');
  const sidebarHandle = document.getElementById('sidebarHandle');

  if (user && user.email) {
    if (guest) guest.classList.add('hidden');
    if (authUser) authUser.classList.remove('hidden');
    if (settingsName) settingsName.textContent = user.name || 'Пользователь';
    if (settingsEmail) settingsEmail.textContent = user.email;
    if (settingsAvatar) {
      settingsAvatar.src = user.avatar || '';
      settingsAvatar.hidden = !user.avatar;
    }
    if (sidebarHandle) {
      const handle = (user.email || '').split('@')[0];
      sidebarHandle.textContent = handle ? `@${handle}` : user.name;
    }
    if (sidebarAvatar && user.avatar) {
      sidebarAvatar.src = user.avatar;
      sidebarAvatar.classList.remove('hidden');
      if (sidebarPlaceholder) sidebarPlaceholder.classList.add('hidden');
    } else {
      if (sidebarAvatar) sidebarAvatar.classList.add('hidden');
      if (sidebarPlaceholder) sidebarPlaceholder.classList.remove('hidden');
    }
    saveUserLocal(user);
    
    // Show app shell, hide login screen
    if (loginScreen) loginScreen.classList.add('hidden');
    if (appShell) appShell.classList.remove('hidden');
    
    // Fetch balance
    fetchBalance().then(() => updateMessageBalanceUI());
  } else {
    if (guest) guest.classList.remove('hidden');
    if (authUser) authUser.classList.add('hidden');
    if (sidebarHandle) sidebarHandle.textContent = '@guest';
    if (sidebarAvatar) sidebarAvatar.classList.add('hidden');
    if (sidebarPlaceholder) sidebarPlaceholder.classList.remove('hidden');
    saveUserLocal(null);
    
    // Hide app shell, show login screen
    if (loginScreen) loginScreen.classList.remove('hidden');
    if (appShell) appShell.classList.add('hidden');
  }
  updateCreateAccess();
  refreshBotList();
}

async function fetchAuth() {
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin' });
    const data = await res.json();
    if (data && data.loggedIn && data.user) {
      updateAuthUI(data.user);
      return data.user;
    }
    updateAuthUI(null);
    return null;
  } catch (err) {
    console.error('fetchAuth', err);
    updateAuthUI(null);
    return null;
  }
}

async function logout() {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (err) {
    console.error('logout', err);
  }
  updateAuthUI(null);
}

const AUTH_ERRORS = {
  not_configured: 'Google OAuth не настроен в .env',
  deleted_client:
    'OAuth-клиент удалён в Google Cloud. Создай новый Client ID в Console и вставь новые GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET в .env, затем перезапусти сервер (npm start).',
  invalid_client:
    'Неверный Client ID или Secret. Скопируй заново из Google Console → Credentials → OAuth 2.0 Client.',
  invalid_state: 'Сессия входа устарела — попробуй ещё раз',
  token: 'Ошибка токена Google — проверь CLIENT_ID и SECRET в .env',
  profile: 'Не удалось получить профиль Google',
  server: 'Ошибка сервера при входе',
  redirect_uri_mismatch:
    'Неверный redirect URI — добавь в Google Console и в .env GOOGLE_REDIRECT_URI',
};

function handleAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('auth') === 'success') {
    navigateTo('settings');
    window.history.replaceState({}, '', window.location.pathname);
    fetchAuth();
    return;
  }
  const err = params.get('auth_error');
  if (err) {
    const msg = AUTH_ERRORS[err] || `Ошибка входа: ${err}`;
    alert(msg);
    window.history.replaceState({}, '', window.location.pathname);
  }
}

/* ========================= SETTINGS / AD ========================= */
function openAd() {
  if (adPopup) adPopup.hidden = false;
}

function closeAd() {
  if (adPopup) adPopup.hidden = true;
}

function initLiveWallpaper() {
  const toggle = document.getElementById('liveWallpaperToggle');
  const videoWallpaper = document.getElementById('videoWallpaper');
  const videoOverlay = document.querySelector('.video-overlay');
  const saved = localStorage.getItem(WALLPAPER_KEY);
  const on = saved !== 'off';
  
  document.body.classList.toggle('wallpaper-off', !on);
  
  if (videoWallpaper) {
    if (on) {
      videoWallpaper.play().catch(() => {});
    } else {
      videoWallpaper.pause();
    }
  }
  
  if (toggle) {
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    toggle.addEventListener('click', () => {
      document.body.classList.toggle('wallpaper-off');
      const enabled = !document.body.classList.contains('wallpaper-off');
      localStorage.setItem(WALLPAPER_KEY, enabled ? 'on' : 'off');
      toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      
      if (videoWallpaper) {
        if (enabled) {
          videoWallpaper.play().catch(() => {});
        } else {
          videoWallpaper.pause();
        }
      }
    });
  }
}

/* ========================= INIT ========================= */
function initChatInput() {
  const input = document.getElementById('msgInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
  }
}

function initPurchaseButtons() {
  document.querySelectorAll('[data-purchase-pack]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pack = btn.dataset.purchasePack;
      if (pack === 'pack1000' || pack === 'pack5000') {
        alert('Coming Soon');
      } else {
        alert('Оплата будет доступна позже');
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initCreateForm();
  initLiveWallpaper();
  initChatInput();
  initPurchaseButtons();
  handleAuthRedirect();
  fetchAuth().then(() => updateCreateAccess());
  loadBots();
});

// Legacy aliases for inline handlers
function openCreate() {
  navigateTo('create');
  if (!isLoggedIn()) updateCreateAccess();
}
function openChats() {
  navigateTo('chats');
}
function openSettings() {
  navigateTo('settings');
}
function closeCreate() {}
function closeChats() {}
function closeSettings() {}

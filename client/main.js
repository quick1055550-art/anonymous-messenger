import { io } from "socket.io-client";

/**
 * main.js (clean + telegram-like voice + speed + listened)
 * - Voice (hold-to-record, swipe left cancel, swipe up lock)
 * - Playback speed (1x/1.5x/2x)
 * - Listened marker for incoming voice (localStorage)
 */

// ============================
// Socket
// ============================
// В dev через Vite мы используем PROXY (vite.config.mjs), поэтому достаточно относительного подключения io().
// Если хочется подключаться к другому бэкенду (например, к удалённому) — задай VITE_BACKEND_ORIGIN.
// Если хочется подключаться к другому бэкенду (например, к удалённому) — задай VITE_BACKEND_ORIGIN.
// ВАЖНО: если ты по ошибке собрал прод с VITE_BACKEND_ORIGIN="http://localhost:4000",
// браузер на https://... не сможет подключиться (будет "websocket error").
// Поэтому ниже есть защита: localhost-адрес в проде игнорируем, а http -> https автоматически апгрейдим.
function resolveBackendOrigin() {
  const raw = (import.meta?.env?.VITE_BACKEND_ORIGIN || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const isLocal =
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "0.0.0.0";

    // Если сайт открыт не на localhost, но в билде задан localhost — игнорируем (иначе всё ломается на проде)
    if (isLocal && window.location.hostname !== u.hostname) return "";

    // Если сайт https, а бэкенд http — пытаемся апгрейдить до https (если домен внешний)
    if (window.location.protocol === "https:" && u.protocol === "http:" && !isLocal) {
      u.protocol = "https:";
    }

    return u.origin;
  } catch {
    return "";
  }
}

const backendOrigin = resolveBackendOrigin();

const socketOpts = {
  path: "/socket.io",
  transports: ["websocket", "polling"],
  timeout: 10_000,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
  withCredentials: true,
  autoConnect: false,
};

const socket = backendOrigin ? io(backendOrigin, socketOpts) : io(socketOpts);

// База для <audio src>. В обычном режиме оставляем относительный URL ("/audio/...").
// Если задан backendOrigin — используем абсолютный.
const audioBase = backendOrigin || "";

// ============================
// Auth bootstrap
// ============================
const appLayout = document.getElementById("appLayout");
const authModal = document.getElementById("authModal");
const authTabLogin = document.getElementById("authTabLogin");
const authTabRegister = document.getElementById("authTabRegister");
const authError = document.getElementById("authError");

const authLoginForm = document.getElementById("authLoginForm");
const authRegisterForm = document.getElementById("authRegisterForm");

const authLoginNick = document.getElementById("authLoginNick");
const authLoginPass = document.getElementById("authLoginPass");
const authLoginBtn = document.getElementById("authLoginBtn");

const authRegNick = document.getElementById("authRegNick");
const authRegPass = document.getElementById("authRegPass");
const authRegisterBtn = document.getElementById("authRegisterBtn");
const authAvatarGrid = document.getElementById("authAvatarGrid");

let selectedAvatarId = 0;

function showAuthError(msg) {
  if (!authError) return;
  if (!msg) {
    authError.style.display = "none";
    authError.textContent = "";
    return;
  }
  authError.style.display = "block";
  authError.textContent = msg;
}

function setAuthMode(mode) {
  const isLogin = mode === "login";
  if (authTabLogin) authTabLogin.classList.toggle("btnPrimary", isLogin);
  if (authTabRegister) authTabRegister.classList.toggle("btnPrimary", !isLogin);
  if (authLoginForm) authLoginForm.style.display = isLogin ? "" : "none";
  if (authRegisterForm) authRegisterForm.style.display = isLogin ? "none" : "";
  showAuthError("");
}

function renderAuthAvatars() {
  if (!authAvatarGrid) return;
  authAvatarGrid.innerHTML = "";
  for (let i = 0; i < AVATAR_COUNT; i++) {
    const btn = document.createElement("button");
    btn.className = "authAvatarBtn" + (i === selectedAvatarId ? " selected" : "");
    btn.type = "button";
    btn.title = `Аватар ${i + 1}`;
    btn.onclick = () => {
      selectedAvatarId = i;
      renderAuthAvatars();
    };
    const img = document.createElement("img");
    img.src = getAvatarUrl(i);
    img.alt = "avatar";
    btn.appendChild(img);
    authAvatarGrid.appendChild(btn);
  }
}

function showAuthPage() {
  if (appLayout) appLayout.style.display = "none";
  if (authModal) authModal.style.display = "flex";
  setAuthMode("login");
  renderAuthAvatars();
  setTimeout(() => authLoginNick?.focus(), 0);
}

function hideAuthPage() {
  if (authModal) authModal.style.display = "none";
  if (appLayout) appLayout.style.display = "";
}

async function apiJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || "error");
  }
  return data;
}

async function fetchMe() {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data?.ok) return null;
  return data.user || null;
}

async function afterAuth(user) {
  currentUser = user;
  senderId = String(user?.id || "");
  hideAuthPage();

  // обновим UI профиля (ищем элементы по id, чтобы не ловить TDZ)
  try {
    const nickInputEl = document.getElementById("nickInput");
    const saveNickBtnEl = document.getElementById("saveNickBtn");
    const randomNickBtnEl = document.getElementById("randomNickBtn");
    const profileAvatarImgEl = document.getElementById("profileAvatarImg");

    if (nickInputEl) {
      nickInputEl.value = user.nick;
      nickInputEl.setAttribute("disabled", "disabled");
    }
    if (saveNickBtnEl) saveNickBtnEl.style.display = "none";
    if (randomNickBtnEl) randomNickBtnEl.style.display = "none";
    if (profileAvatarImgEl) profileAvatarImgEl.src = getAvatarUrl(getMyAvatarId());
  } catch {}

  // подключаем сокет только после успешной авторизации
  try { socket.connect(); } catch {}
}

async function bootstrapAuth() {
  const me = await fetchMe();
  if (me) {
    await afterAuth(me);
    return;
  }
  showAuthPage();
}

if (authTabLogin) authTabLogin.onclick = () => setAuthMode("login");
if (authTabRegister) authTabRegister.onclick = () => setAuthMode("register");

if (authLoginBtn) authLoginBtn.onclick = async () => {
  try {
    showAuthError("");
    const nick = String(authLoginNick?.value || "").trim();
    const password = String(authLoginPass?.value || "");
    const data = await apiJson("/api/auth/login", { nick, password });
    await afterAuth(data.user);
  } catch (e) {
    showAuthError(e?.message || "Ошибка входа");
  }
};

if (authRegisterBtn) authRegisterBtn.onclick = async () => {
  try {
    showAuthError("");
    const nick = String(authRegNick?.value || "").trim();
    const password = String(authRegPass?.value || "");
    const data = await apiJson("/api/auth/register", { nick, password, avatarId: selectedAvatarId });
    await afterAuth(data.user);
  } catch (e) {
    showAuthError(e?.message || "Ошибка регистрации");
  }
};

// запускаем проверку авторизации (не ждём загрузки сокета)
bootstrapAuth().catch(() => showAuthPage());

const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) logoutBtn.onclick = async () => {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  } catch {}
  // перезагрузим страницу, чтобы всё очистилось
  window.location.reload();
};


let currentUser = null;
let senderId = "";

// ============================
// Avatar (10 минималистичных дефолтных)
// ============================
const AVATAR_KEY = "am_avatar_id_v1";
const AVATAR_COUNT = 10;

function getAvatarBaseUrl() {
  // Vite base is "./" in this project, BASE_URL respects it.
  const b = (import.meta?.env?.BASE_URL || "/").toString();
  return b.endsWith("/") ? b : b + "/";
}

function getAvatarUrl(id) {
  const n = Number(id);
  const safe = Number.isFinite(n) ? Math.max(0, Math.min(AVATAR_COUNT - 1, n)) : 0;
  return `${getAvatarBaseUrl()}avatars/a${safe}.svg`;
}

function getMyAvatarId() {
  return Number.isFinite(currentUser?.avatarId) ? currentUser.avatarId : 0;
}

function setMyAvatarId(_id) {
  // аватар задаётся при регистрации, менять можно будет позже через отдельную фичу
  return getMyAvatarId();
}

// Очередь отправки: если сокет временно отвалился — сохраняем события и отправляем после reconnect.
const pendingEmits = [];
let pendingJoin = null;
let disconnectedBannerShown = false;
let lastConnectErrorAt = 0;

function emitOrQueue(event, payload, humanErrorText) {
  if (socket.connected) {
    socket.emit(event, payload);
    return true;
  }

  // попытаться переподключиться
  try { socket.connect(); } catch {}

  // показать предупреждение один раз за разрыв соединения
  if (!disconnectedBannerShown) {
    disconnectedBannerShown = true;
    addLine(`⚠️ Нет соединения с сервером. Пытаюсь переподключиться…`, "", "system");
  }

  // не теряем сообщение: кладём в очередь (ограничим, чтобы не жрать память)
  if (pendingEmits.length < 10) {
    pendingEmits.push({ event, payload, ts: Date.now() });
  } else if (humanErrorText) {
    addLine(`❌ ${humanErrorText}`, "", "system");
  }

  return false;
}

// ============================
// DOM
// ============================
const roomIdEl = document.getElementById("roomId");
const joinBtn = document.getElementById("joinBtn");
const chatEl = document.getElementById("chat");
const msgInput = document.getElementById("msgInput");
const sendBtn = document.getElementById("sendBtn");
const createBtn = document.getElementById("createBtn");
const inviteEl = document.getElementById("invite");

const nickInput = document.getElementById("nickInput");
const saveNickBtn = document.getElementById("saveNickBtn");
const randomNickBtn = document.getElementById("randomNickBtn");
const nickStatus = document.getElementById("nickStatus");

const typingLine = document.getElementById("typingLine");
const onlineList = document.getElementById("onlineList");

const soundBtn = document.getElementById("soundBtn");
const notifyBtn = document.getElementById("notifyBtn");

const recBtn = document.getElementById("recBtn");
const stopBtn = document.getElementById("stopBtn");
const recStatus = document.getElementById("recStatus");

// chats UI
const chatSearchEl = document.getElementById("chatSearch");
const chatSortEl = document.getElementById("chatSort");
const chatListEl = document.getElementById("chatList");
const joinedListEl = document.getElementById("joinedList");
const activeChatTitleEl = document.getElementById("activeChatTitle");
const activeChatMetaEl = document.getElementById("activeChatMeta");
const copyInviteBtn = document.getElementById("copyInviteBtn");

// avatar UI
const profileAvatarBtn = document.getElementById("profileAvatarBtn");
const profileAvatarImg = document.getElementById("profileAvatarImg");
const avatarModal = document.getElementById("avatarModal");
const avatarGrid = document.getElementById("avatarGrid");
const avatarCloseBtn = document.getElementById("avatarCloseBtn");

// onboarding ("регистрация") UI
const onboardingModal = document.getElementById("onboardingModal");
const onbNickInput = document.getElementById("onbNickInput");
const onbRandomNickBtn = document.getElementById("onbRandomNickBtn");
const onbAvatarGrid = document.getElementById("onbAvatarGrid");
const onbSaveBtn = document.getElementById("onbSaveBtn");

// ============================
// State
// ============================
let currentRoomId = "";

// ============================
// Chats storage ("Мои" + "Присоединённые")
// ============================
const CHATS_KEY = "am_chats_v1";
const ACTIVE_ROOM_KEY = "am_active_room_v1";
// chat shape: { roomId, title, kind: 'created'|'joined', createdAt, lastActivityAt, lastPreview, unread }
let chats = [];

function loadChats() {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    chats = Array.isArray(arr) ? arr : [];
  } catch {
    chats = [];
  }
}

function saveChats() {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  } catch {}
}

function getChat(roomId) {
  return chats.find((c) => c.roomId === roomId) || null;
}

function upsertChat(next) {
  const idx = chats.findIndex((c) => c.roomId === next.roomId);
  if (idx >= 0) chats[idx] = { ...chats[idx], ...next };
  else chats.push(next);
  saveChats();
}

function bumpChat(roomId, patch = {}) {
  const c = getChat(roomId);
  if (!c) return;
  upsertChat({
    ...c,
    ...patch,
    lastActivityAt: patch.lastActivityAt || Date.now(),
  });
}

function shortId(roomId) {
  const s = String(roomId || "");
  return s.length <= 8 ? s : `${s.slice(0, 4)}…${s.slice(-3)}`;
}

function defaultTitleFor(roomId, kind) {
  if (kind === "created") return `Мой чат ${shortId(roomId)}`;
  return `Комната ${shortId(roomId)}`;
}

function ensureChat(roomId, kind) {
  const rid = safeText(roomId);
  if (!rid) return null;

  const existing = getChat(rid);
  if (existing) return existing;

  const c = {
    roomId: rid,
    kind: kind === "created" ? "created" : "joined",
    title: defaultTitleFor(rid, kind),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastPreview: "",
    unread: 0,
  };
  chats.push(c);
  saveChats();
  return c;
}

function getSortMode() {
  return (chatSortEl?.value || localStorage.getItem("am_chat_sort") || "recent").trim();
}

function setSortMode(mode) {
  localStorage.setItem("am_chat_sort", mode);
  if (chatSortEl) chatSortEl.value = mode;
}

function sortChats(list) {
  const mode = getSortMode();

  const byRecent = (a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
  const byCreated = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
  const byName = (a, b) => String(a.title || "").localeCompare(String(b.title || ""), "ru", { sensitivity: "base" });

  const sorted = [...list];
  if (mode === "name") sorted.sort(byName);
  else if (mode === "created") sorted.sort(byCreated);
  else sorted.sort(byRecent);
  return sorted;
}

function matchesSearch(c) {
  const q = String(chatSearchEl?.value || "").trim().toLowerCase();
  if (!q) return true;
  const hay = `${c.title || ""} ${c.roomId || ""}`.toLowerCase();
  return hay.includes(q);
}

function renderChatLists() {
  if (!chatListEl || !joinedListEl) return;

  const created = sortChats(chats.filter((c) => c.kind === "created").filter(matchesSearch));
  const joined = sortChats(chats.filter((c) => c.kind === "joined").filter(matchesSearch));

  chatListEl.innerHTML = "";
  joinedListEl.innerHTML = "";

  const renderOne = (root, c) => {
    const div = document.createElement("div");
    div.className = `chatItem ${c.roomId === currentRoomId ? "active" : ""}`;

    const letter = (String(c.title || "?") || "?").trim().charAt(0).toUpperCase();
    const time = c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

    div.innerHTML = `
      <div class="chatAvatar">${letter}</div>
      <div class="chatText">
        <div class="chatTitle">${escapeHtml(c.title || "Без названия")}</div>
        <div class="chatPreview">${escapeHtml(c.lastPreview || shortId(c.roomId))}</div>
      </div>
      <div class="chatMeta">
        <div class="small" style="margin:0; opacity:.65;">${time}</div>
        ${c.unread ? `<div class="badge">${c.unread}</div>` : ""}
      </div>
    `;

    div.onclick = () => selectChat(c.roomId);

    // right click: rename / delete
    div.oncontextmenu = (e) => {
      e.preventDefault();
      const action = prompt(`Чат: ${c.title}\n\n1 — переименовать\n2 — удалить из списка`, "1");
      if (action === "1") {
        const t = safeText(prompt("Новое имя чата:", c.title) || "");
        if (t) upsertChat({ ...c, title: t });
        renderChatLists();
        if (c.roomId === currentRoomId) updateActiveHeader();
      } else if (action === "2") {
        chats = chats.filter((x) => x.roomId !== c.roomId);
        saveChats();
        if (c.roomId === currentRoomId) {
          currentRoomId = "";
          localStorage.removeItem(ACTIVE_ROOM_KEY);
          chatEl.innerHTML = "";
          updateActiveHeader();
        }
        renderChatLists();
      }
    };

    root.appendChild(div);
  };

  if (created.length === 0) {
    const empty = document.createElement("div");
    empty.className = "small";
    empty.style.padding = "6px 10px 12px";
    empty.textContent = "Пока нет чатов. Нажми “Новый”.";
    chatListEl.appendChild(empty);
  } else {
    for (const c of created) renderOne(chatListEl, c);
  }

  if (joined.length === 0) {
    const empty = document.createElement("div");
    empty.className = "small";
    empty.style.padding = "6px 10px 12px";
    empty.textContent = "Пока нет. Войдите по Room ID.";
    joinedListEl.appendChild(empty);
  } else {
    for (const c of joined) renderOne(joinedListEl, c);
  }
}

function updateActiveHeader() {
  const c = currentRoomId ? getChat(currentRoomId) : null;
  if (activeChatTitleEl) activeChatTitleEl.textContent = c ? c.title : "Выберите чат";
  if (activeChatMetaEl) {
    activeChatMetaEl.textContent = c
      ? `Room: ${c.roomId} • ${c.kind === "created" ? "создан вами" : "присоединён"}`
      : "";
  }
}

function selectChat(roomId) {
  const c = getChat(roomId);
  if (!c) return;
  if (roomIdEl) roomIdEl.value = roomId;
  joinRoom(roomId);
}

// typing state
let typingTimer = null;
let iAmTyping = false;
const typingUsers = new Map();

// voice state
let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];

let recStartAt = 0;
let recUiTimer = null;

let isLocked = false;
let isCancelGesture = false;
let startX = 0;
let startY = 0;

let lastVoiceBlob = null;
let lastVoiceDurationSec = 0;

let isStartingRecording = false;
let stopAfterStart = false;

// ============================
// Utils
// ============================
function formatTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function nowIso() {
  return new Date().toISOString();
}

function safeText(v) {
  return String(v ?? "").trim();
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


function renderMeta({ who, avatarId, timeText }) {
  const name = escapeHtml(who || "");
  const time = escapeHtml(timeText || "");
  const n = Number(avatarId);
  if (Number.isFinite(n) && n >= 0 && n < AVATAR_COUNT) {
    const src = getAvatarUrl(n);
    return `<span class="metaRow"><img class="metaAvatarImg" src="${src}" alt=""/><span>${name}</span> • ${time}</span>`;
  }
  return `${name} • ${time}`;
}

function makeRandomNick() {
  const animals = ["Лиса", "Волк", "Кот", "Сова", "Енот", "Тигр", "Панда", "Дельфин"];
  const adj = ["Тихий", "Смелый", "Шустрый", "Ночной", "Добрый", "Хитрый", "Смешной", "Упрямый"];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const b = animals[Math.floor(Math.random() * animals.length)];
  const num = Math.floor(Math.random() * 900 + 100);
  return `${a} ${b} ${num}`;
}

function getNick() {
  return String(currentUser?.nick || "");
}

function setNick(_nick) {
  // ник задаётся при регистрации
}
// ============================
// Onboarding ("окно регистрации")
// Показываем один раз, если ник ещё не сохранён.
// ============================
function openOnboarding() {
  if (!onboardingModal) return;
  onboardingModal.style.display = "flex";

  // ник по умолчанию
  if (onbNickInput && !onbNickInput.value.trim()) {
    onbNickInput.value = makeRandomNick();
  }

  renderOnboardingAvatars();

  // фокус на поле
  setTimeout(() => onbNickInput?.focus(), 0);
}

function closeOnboarding() {
  if (!onboardingModal) return;
  onboardingModal.style.display = "none";
}

function renderOnboardingAvatars() {
  if (!onbAvatarGrid) return;
  const current = getMyAvatarId();
  onbAvatarGrid.innerHTML = "";
  for (let i = 0; i < AVATAR_COUNT; i++) {
    const btn = document.createElement("button");
    btn.className = `avatarBtn ${i === current ? "active" : ""}`;
    btn.type = "button";
    btn.innerHTML = `<img src="${getAvatarUrl(i)}" alt="avatar ${i + 1}" />`;
    btn.onclick = () => {
      const next = setMyAvatarId(i);
      if (profileAvatarImg) profileAvatarImg.src = getAvatarUrl(next);
      renderOnboardingAvatars();
      // не закрываем — пусть выберет ник и нажмёт "Готово"
    };
    onbAvatarGrid.appendChild(btn);
  }
}

function initOnboarding() {
  // клики
  if (onboardingModal) {
    onboardingModal.addEventListener("click", (e) => {
      if (e.target === onboardingModal) closeOnboarding();
    });
  }

  if (onbRandomNickBtn) {
    onbRandomNickBtn.onclick = () => {
      if (onbNickInput) onbNickInput.value = makeRandomNick();
    };
  }

  if (onbSaveBtn) {
    onbSaveBtn.onclick = () => {
      const nick = safeText(onbNickInput?.value);
      if (!nick) return alert("Введите ник");
      setNick(nick);

      // синхронизируем поле слева
      if (nickInput) nickInput.value = nick;

      // аватар уже сохранён в localStorage
      const id = getMyAvatarId();
      if (profileAvatarImg) profileAvatarImg.src = getAvatarUrl(id);

      closeOnboarding();
    };
  }

  // показать, если ника ещё нет
  if (!getNick()) {
    // openOnboarding(); (disabled: now auth page)
  } else {
    // синхронизируем ник в инпуте слева
    if (nickInput) nickInput.value = getNick();
  }
}


function setInvite(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  const link = url.toString();
  if (inviteEl) inviteEl.textContent = `Приглашение: ${link}`;
  return link;
}

function autoJoinFromUrl() {
  const url = new URL(window.location.href);
  const roomFromUrl = url.searchParams.get("room");
  if (roomFromUrl && roomIdEl && joinBtn) {
    roomIdEl.value = roomFromUrl;
    joinBtn.click();
  }
  return roomFromUrl || "";
}

function addLine(html, meta = "", variant = "other") {
  const div = document.createElement("div");
  div.className = `msg ${variant}`;
  div.innerHTML = `
    <div class="msgBody">${html}</div>
    ${meta ? `<div class="small">${meta}</div>` : ""}
  `;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}


// ============================
// Socket status (helps debug when messages "не отправляются")
// ============================
socket.on("connect", () => {
  disconnectedBannerShown = false;
  addLine(`🔌 Socket подключён`, "", "system");

  // Если пользователь нажал "Войти" пока не было соединения — вошлём join сейчас
  if (pendingJoin) {
    socket.emit("join_room", pendingJoin);
    pendingJoin = null;
  }

  // Отправим всё, что накопилось пока сокет был оффлайн
  while (pendingEmits.length) {
    const it = pendingEmits.shift();
    socket.emit(it.event, it.payload);
  }
});

socket.on("disconnect", (reason) => {
  if (!disconnectedBannerShown) {
    disconnectedBannerShown = true;
    addLine(`⚠️ Соединение потеряно (${reason}).`, "", "system");
  }
});

socket.on("connect_error", (err) => {
  const now = Date.now();
  // Не спамим чат одинаковыми ошибками
  if (now - lastConnectErrorAt < 10_000) return;
  lastConnectErrorAt = now;

  const msg = err?.message || String(err);
  addLine(`❌ Ошибка Socket.IO: ${msg}`, "", "system");

  // Подсказки для новичка
  if (/websocket error|xhr poll error|timeout/i.test(msg)) {
    addLine(
      `💡 Проверь: 1) сервер Node.js запущен на :4000  2) nginx проксирует /socket.io/ на 127.0.0.1:4000  3) нет других server_name malaus.online`,
      "",
      "system"
    );
  }
});

// ============================
// Notifications (sound + system) + unread title blink
// ============================
const BASE_TITLE = document.title;
let unreadCount = 0;

let soundEnabled = localStorage.getItem("soundEnabled") === "true";
let notifyEnabled = localStorage.getItem("notifyEnabled") === "true";

function updateTitle() {
  document.title = unreadCount > 0 ? `${BASE_TITLE} (${unreadCount})` : BASE_TITLE;
}

function syncUnreadCount() {
  unreadCount = chats.reduce((sum, c) => sum + Number(c.unread || 0), 0);
  updateTitle();
}

let blinkTimer = null;
let blinkOn = false;

function startBlink() {
  if (blinkTimer) return;
  blinkOn = false;

  blinkTimer = setInterval(() => {
    if (unreadCount <= 0 || !document.hidden) {
      stopBlink();
      return;
    }

    blinkOn = !blinkOn;
    document.title = blinkOn
      ? `🔴 Новое сообщение (${unreadCount})`
      : `${BASE_TITLE} (${unreadCount})`;
  }, 900);
}

function stopBlink() {
  if (blinkTimer) clearInterval(blinkTimer);
  blinkTimer = null;
  blinkOn = false;
  updateTitle();
}

function resetUnread() {
  // Сбросим непрочитанные по всем чатам
  for (const c of chats) c.unread = 0;
  saveChats();
  renderChatLists();
  unreadCount = 0;
  stopBlink();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) resetUnread();
});
window.addEventListener("focus", resetUnread);
window.addEventListener("click", resetUnread);

let audioCtx = null;

async function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
}

async function beep() {
  if (!soundEnabled) return;
  try {
    await ensureAudio();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    osc.start(t);
    osc.stop(t + 0.09);
  } catch (err) {
    console.log("🔇 beep error:", err);
  }
}

function showSystemNotification(title, body) {
  if (!notifyEnabled) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!document.hidden) return;
  new Notification(title, { body });
}

function renderNotifyButtons() {
  if (soundBtn) soundBtn.textContent = soundEnabled ? "🔊 Звук: ВКЛ" : "🔇 Звук: ВЫКЛ";
  if (notifyBtn) notifyBtn.textContent = notifyEnabled ? "🔔 Уведомления: ВКЛ" : "🔕 Уведомления: ВЫКЛ";
}
renderNotifyButtons();

if (soundBtn) {
  soundBtn.onclick = async () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem("soundEnabled", String(soundEnabled));
    if (soundEnabled) {
      try {
        await ensureAudio();
        await beep();
      } catch {}
    }
    renderNotifyButtons();
  };
}

if (notifyBtn) {
  notifyBtn.onclick = async () => {
    if (!notifyEnabled) {
      if (!("Notification" in window)) {
        alert("Этот браузер не поддерживает системные уведомления");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        alert("Уведомления не разрешены");
        return;
      }
      notifyEnabled = true;
    } else {
      notifyEnabled = false;
    }
    localStorage.setItem("notifyEnabled", String(notifyEnabled));
    renderNotifyButtons();
  };
}

// Copy invite link
if (copyInviteBtn) {
  copyInviteBtn.onclick = async () => {
    if (!currentRoomId) return alert("Сначала выберите чат");
    const link = setInvite(currentRoomId);
    try {
      await navigator.clipboard.writeText(link);
      addLine("✅ Ссылка скопирована", "", "system");
    } catch {
      prompt("Скопируйте ссылку:", link);
    }
  };
}

// Rename active chat (click title)
if (activeChatTitleEl) {
  activeChatTitleEl.style.cursor = "pointer";
  activeChatTitleEl.title = "Клик: переименовать";
  activeChatTitleEl.onclick = () => {
    if (!currentRoomId) return;
    const c = getChat(currentRoomId);
    const next = safeText(prompt("Имя чата:", c?.title || "") || "");
    if (!next) return;
    if (c) upsertChat({ ...c, title: next });
    updateActiveHeader();
    renderChatLists();
  };
}

// Search / Sort UI
if (chatSortEl) {
  const saved = getSortMode();
  chatSortEl.value = (saved === "name" || saved === "created" || saved === "recent") ? saved : "recent";
  chatSortEl.onchange = () => {
    const mode = (chatSortEl.value === "name" || chatSortEl.value === "created") ? chatSortEl.value : "recent";
    setSortMode(mode);
    renderChatLists();
  };
}

if (chatSearchEl) {
  chatSearchEl.oninput = () => {
    renderChatLists();
  };
}

// ============================
// Typing UI
// ============================
function renderTyping() {
  if (!typingLine) return;

  if (typingUsers.size === 0) {
    typingLine.textContent = "";
    return;
  }

  const names = Array.from(typingUsers.values());
  if (names.length === 1) {
    typingLine.textContent = `${names[0]} печатает…`;
  } else {
    typingLine.textContent = `Печатают: ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}`;
  }
}

// ============================
// Voice helpers (mime + panel + send)
// ============================
function pickBestAudioMimeType() {
  const candidates = [
    "audio/webm;codecs=opus", // Chrome/Edge
    "audio/ogg;codecs=opus",  // Firefox
    "audio/webm",
    "audio/ogg",
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

const VOICE_BITS_PER_SECOND = 128_000;

// ---- dynamic voice panel (created if missing in HTML) ----
let voicePanel = null;
let voiceTimerEl = null;
let voiceHintEl = null;
let voiceCancelBtn = null;
let voiceSendBtn = null;

function ensureVoicePanel() {
  if (voicePanel) return;

  voicePanel = document.createElement("div");
  voicePanel.id = "voicePanelDyn";
  voicePanel.style.cssText = `
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 9999;
    display: none;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(20,20,20,0.92);
    color: #fff;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;

  const left = document.createElement("div");
  left.style.cssText = "display:flex; flex-direction:column; gap:4px;";

  voiceTimerEl = document.createElement("div");
  voiceTimerEl.style.cssText = "font-weight:700;";
  voiceTimerEl.textContent = "00:00";

  voiceHintEl = document.createElement("div");
  voiceHintEl.style.cssText = "opacity:0.9; font-size:13px;";
  voiceHintEl.textContent = "⬅️ влево — отмена • ⬆️ вверх — замок";

  left.appendChild(voiceTimerEl);
  left.appendChild(voiceHintEl);

  const right = document.createElement("div");
  right.style.cssText = "display:flex; gap:8px; align-items:center;";

  voiceCancelBtn = document.createElement("button");
  voiceCancelBtn.textContent = "Отмена";
  voiceCancelBtn.style.cssText = "padding:8px 10px; border-radius:10px; border:none; cursor:pointer;";

  voiceSendBtn = document.createElement("button");
  voiceSendBtn.textContent = "Отправить";
  voiceSendBtn.style.cssText = "padding:8px 10px; border-radius:10px; border:none; cursor:pointer;";

  // hidden by default (only for locked preview)
  voiceCancelBtn.style.display = "none";
  voiceSendBtn.style.display = "none";

  right.appendChild(voiceCancelBtn);
  right.appendChild(voiceSendBtn);

  voicePanel.appendChild(left);
  voicePanel.appendChild(right);

  document.body.appendChild(voicePanel);

  voiceCancelBtn.onclick = () => resetVoicePanel();
  voiceSendBtn.onclick = async () => {
    if (!lastVoiceBlob) return;
    await sendVoiceBlob(lastVoiceBlob, lastVoiceBlob.type, lastVoiceDurationSec);
    resetVoicePanel();
  };
}

function showVoicePanel(show) {
  ensureVoicePanel();
  voicePanel.style.display = show ? "flex" : "none";
}

function setVoiceTimerText(sec) {
  ensureVoicePanel();
  voiceTimerEl.textContent = formatTime(sec);
}

function setVoiceHint(textOrHtml) {
  ensureVoicePanel();
  // allow small html for audio preview
  voiceHintEl.innerHTML = textOrHtml;
}

function resetVoicePanel() {
  showVoicePanel(false);
  lastVoiceBlob = null;
  lastVoiceDurationSec = 0;
  isLocked = false;
  isCancelGesture = false;

  // reset hint + buttons
  ensureVoicePanel();
  setVoiceHint("⬅️ влево — отмена • ⬆️ вверх — замок");
  voiceCancelBtn.style.display = "none";
  voiceSendBtn.style.display = "none";

  // reset record UI pieces
  if (recStatus) recStatus.textContent = "";
  if (stopBtn) stopBtn.disabled = true;
  if (recBtn) recBtn.disabled = false;
}

function startRecUiTimer() {
  recStartAt = Date.now();
  stopRecUiTimer();
  recUiTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recStartAt) / 1000);
    lastVoiceDurationSec = elapsed;
    setVoiceTimerText(elapsed);
    if (recStatus) recStatus.textContent = isLocked
      ? `🔒 Запись: ${formatTime(elapsed)}`
      : `🎙 Запись: ${formatTime(elapsed)}`;
  }, 200);
}

function stopRecUiTimer() {
  if (recUiTimer) clearInterval(recUiTimer);
  recUiTimer = null;
}

async function sendVoiceBlob(blob, mime, durationSec) {
  if (!currentRoomId) {
    alert("Сначала войдите в комнату");
    return;
  }

  const arrayBuffer = await blob.arrayBuffer();

  emitOrQueue(
    "send_voice",
    {
      roomId: currentRoomId,
      mime: mime || "audio/webm",
      durationSec, // опционально (сервер может игнорировать)
      audio: arrayBuffer,
    },
    "Голосовое не отправлено."
  );
}


async function stopMediaStream() {
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
}

// ============================
// пункт 2: Telegram-like record (hold, swipe cancel, swipe lock)
// ============================
async function startRecording() {
  if (!currentRoomId) return alert("Сначала войдите в комнату");
  if (!navigator.mediaDevices?.getUserMedia) return alert("Нет поддержки записи (getUserMedia).");
  if (!window.MediaRecorder) return alert("Нет поддержки MediaRecorder.");
  if (mediaRecorder && mediaRecorder.state === "recording") return;

  isLocked = false;
  isCancelGesture = false;
  lastVoiceBlob = null;
  lastVoiceDurationSec = 0;

  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000,
  };

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  } catch {
    alert("Нет доступа к микрофону. Разреши микрофон в браузере.");
    return;
  }

  audioChunks = [];

  const mimeType = pickBestAudioMimeType();
  const options = {
    ...(mimeType ? { mimeType } : {}),
    audioBitsPerSecond: VOICE_BITS_PER_SECOND,
  };

  try {
    mediaRecorder = new MediaRecorder(mediaStream, options);
  } catch (e) {
    console.warn("MediaRecorder не принял options, запускаю без них:", e);
    mediaRecorder = new MediaRecorder(mediaStream);
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onerror = (e) => {
    console.error("MediaRecorder error:", e);
    try { mediaRecorder?.stop(); } catch {}
    cleanupAfterStop(true);
  };

  mediaRecorder.onstop = async () => {
    stopRecUiTimer();
    await stopMediaStream();

    // отмена
    if (isCancelGesture) {
      cleanupAfterStop(true);
      return;
    }

    if (!audioChunks.length) {
      cleanupAfterStop(true);
      alert("Запись пустая. Попробуй ещё раз.");
      return;
    }

    const blob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
    lastVoiceBlob = blob;

    // если не замок — отправляем сразу
    if (!isLocked) {
      await sendVoiceBlob(blob, blob.type, lastVoiceDurationSec);
      cleanupAfterStop(true);
      return;
    }

    // если замок — превью + кнопки
    const url = URL.createObjectURL(blob);
    setVoiceHint(`<audio controls src="${url}" style="width: 260px;"></audio>`);
    voiceCancelBtn.style.display = "inline-block";
    voiceSendBtn.style.display = "inline-block";
  };

  // UI start
  showVoicePanel(true);
  setVoiceTimerText(0);
  setVoiceHint("⬅️ влево — отмена • ⬆️ вверх — замок");

  if (recBtn) recBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = true; // включим только когда будет lock

  startRecUiTimer();

  // делим запись на чанки каждые 250мс — меньше шанс “пустой blob/обрыв”
  mediaRecorder.start(250);
}

function cleanupAfterStop(resetPanel) {
  stopRecUiTimer();
  audioChunks = [];
  mediaRecorder = null;

  if (resetPanel) resetVoicePanel();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    try {
      mediaRecorder.stop();
    } catch {
      cleanupAfterStop(true);
    }
  }
}

// Hook buttons / gestures
if (recBtn) {
  recBtn.addEventListener("pointerdown", async (e) => {
    if (e.button !== undefined && e.button !== 0) return; // only left click

    // сброс флагов на новое удержание
    isStartingRecording = true;
    stopAfterStart = false;

    startX = e.clientX;
    startY = e.clientY;

    // захватываем указатель, чтобы pointerup пришёл даже если уехали мышкой
    try { recBtn.setPointerCapture(e.pointerId); } catch {}

    await startRecording();

    isStartingRecording = false;

    // если пользователь отпустил кнопку пока мы запрашивали микрофон — остановим сразу
    if (stopAfterStart && mediaRecorder && mediaRecorder.state === "recording" && !isLocked) {
      stopRecording();
    }
  });

  recBtn.addEventListener("pointermove", (e) => {
    if (!mediaRecorder || mediaRecorder.state !== "recording") return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // swipe left = cancel (если ещё не lock)
    if (!isLocked) {
      if (dx < -90) {
        isCancelGesture = true;
        setVoiceHint("❌ Отпусти — отмена");
      } else {
        isCancelGesture = false;
        setVoiceHint("⬅️ влево — отмена • ⬆️ вверх — замок");
      }
    }

    // swipe up = lock
    if (!isLocked && dy < -90) {
      isLocked = true;
      isCancelGesture = false;
      setVoiceHint("🔒 Замок включён. Теперь нажми «Стоп», чтобы получить превью.");
      if (stopBtn) stopBtn.disabled = false;
    }
  });

  recBtn.addEventListener("pointerup", () => {
    // если кнопку отпустили очень быстро, пока шёл запрос микрофона — запомним
    if (isStartingRecording && (!mediaRecorder || mediaRecorder.state !== "recording")) {
      stopAfterStart = true;
      return;
    }

    if (!mediaRecorder || mediaRecorder.state !== "recording") return;

    // lock: отпускание НЕ останавливает запись
    if (isLocked) return;

    // otherwise stop immediately (send or cancel will be decided in onstop)
    stopRecording();
  });

  recBtn.addEventListener("pointercancel", () => {
    // если система отменила pointer — считаем как cancel
    if (!mediaRecorder || mediaRecorder.state !== "recording") return;
    isCancelGesture = true;
    stopRecording();
  });
}

// stop button used mainly for lock mode
if (stopBtn) {
  stopBtn.onclick = () => {
    if (!mediaRecorder || mediaRecorder.state !== "recording") return;
    stopRecording();
  };
}

// ============================
// пункт 3: playback speed + listened
// ============================
const SPEEDS = [1, 1.5, 2];
const LISTENED_KEY = "listenedAudioIds_v1";

function loadListened() {
  try {
    const raw = localStorage.getItem(LISTENED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map(String));
  } catch {
    return new Set();
  }
}

function saveListened(set) {
  try {
    localStorage.setItem(LISTENED_KEY, JSON.stringify(Array.from(set)));
  } catch {}
}

const listenedSet = loadListened();

function markListened(audioId) {
  if (!audioId) return;
  if (listenedSet.has(audioId)) return;
  listenedSet.add(String(audioId));
  saveListened(listenedSet);

  // убрать визуальную метку "не прослушано" в DOM
  const node = chatEl.querySelector(`[data-audio-id="${CSS.escape(String(audioId))}"]`);
  if (node) node.classList.remove("unheard");
}

function renderAudioMessage({ audioId, isMe, meta, variant }) {
  const url = audioBase ? `${audioBase}/audio/${audioId}` : `/audio/${audioId}`;
const unheard = !isMe && !listenedSet.has(String(audioId));

  const html = `
    <div class="audioWrap ${unheard ? "unheard" : ""}" data-audio-id="${audioId}">
      <audio class="voice" controls preload="metadata" data-audio-id="${audioId}" src="${url}"></audio>
      <button class="speedBtn" type="button">1x</button>
      ${unheard ? `<span class="dot" title="Не прослушано">●</span>` : ``}
    </div>
  `;

  addLine(html, meta, variant);
}

// speed toggle via delegation
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".speedBtn");
  if (!btn) return;

  const wrap = btn.closest(".audioWrap");
  const audio = wrap?.querySelector("audio");
  if (!audio) return;

  const cur = audio.playbackRate || 1;
  const idx = SPEEDS.indexOf(cur);
  const next = SPEEDS[(idx + 1) % SPEEDS.length];

  audio.playbackRate = next;
  btn.textContent = `${next}x`;
});

// mark listened when play starts (play doesn't bubble -> use capture)
chatEl.addEventListener(
  "play",
  (e) => {
    const audio = e.target;
    if (!(audio instanceof HTMLAudioElement)) return;
    const audioId = audio.getAttribute("data-audio-id");
    if (audioId) markListened(audioId);
  },
  true
);

// ============================
// Nick init
// ============================
const savedNick = getNick();
if (savedNick) {
  if (nickInput) nickInput.value = savedNick;
  if (nickStatus) nickStatus.textContent = `Текущий ник: ${savedNick}`;
} else {
  const rnd = makeRandomNick();
  if (nickInput) nickInput.value = rnd;
  setNick(rnd);
}

if (saveNickBtn) {
  saveNickBtn.onclick = () => {
    const nick = safeText(nickInput?.value);
    if (!nick) return alert("Введите ник");
    setNick(nick);
  };
}

if (randomNickBtn) {
  randomNickBtn.onclick = () => {
    const rnd = makeRandomNick();
    if (nickInput) nickInput.value = rnd;
    setNick(rnd);
  };
}


// ============================
// Avatar UI
// ============================
function openAvatarModal() {
  if (!avatarModal) return;
  avatarModal.style.display = "flex";
  renderAvatarGrid();
}
function closeAvatarModal() {
  if (!avatarModal) return;
  avatarModal.style.display = "none";
}

function renderAvatarGrid() {
  if (!avatarGrid) return;
  const current = getMyAvatarId();
  avatarGrid.innerHTML = "";
  for (let i = 0; i < AVATAR_COUNT; i++) {
    const btn = document.createElement("button");
    btn.className = `avatarBtn ${i === current ? "active" : ""}`;
    btn.type = "button";
    btn.innerHTML = `<img src="${getAvatarUrl(i)}" alt="avatar ${i+1}" />`;
    btn.onclick = () => {
      const next = setMyAvatarId(i);
      if (profileAvatarImg) profileAvatarImg.src = getAvatarUrl(next);
      renderAvatarGrid();
      closeAvatarModal();
    };
    avatarGrid.appendChild(btn);
  }
}

function initAvatarPicker() {
  const id = getMyAvatarId();
  if (profileAvatarImg) profileAvatarImg.src = getAvatarUrl(id);

  if (profileAvatarBtn) profileAvatarBtn.onclick = () => openAvatarModal();
  if (avatarCloseBtn) avatarCloseBtn.onclick = () => closeAvatarModal();
  if (avatarModal) {
    avatarModal.addEventListener("click", (e) => {
      if (e.target === avatarModal) closeAvatarModal();
    });
  }
}

// init once
initAvatarPicker();
initOnboarding();

// ============================
// Join room (from chat list / room input)
// ============================
function joinRoom(roomId) {
  const rid = safeText(roomId);
  if (!rid) return;

  currentRoomId = rid;
  localStorage.setItem(ACTIVE_ROOM_KEY, rid);

  // unread reset for this chat
  const c = getChat(rid);
  if (c && (c.unread || 0) > 0) upsertChat({ ...c, unread: 0 });
  syncUnreadCount();

  typingUsers.clear();
  renderTyping();
  if (onlineList) onlineList.textContent = "";

  setInvite(rid);
  updateActiveHeader();
  renderChatLists();

  const payload = { roomId: rid };

  if (socket.connected) {
    socket.emit("join_room", payload);
    addLine(`✅ Вход в комнату: ${rid}`, "", "system");
    return;
  }

  // если сокет не подключён — запомним вход и отправим после connect
  pendingJoin = payload;
  try { socket.connect(); } catch {}
  if (!disconnectedBannerShown) {
    disconnectedBannerShown = true;
    addLine("⚠️ Нет соединения с сервером. Пытаюсь переподключиться…", "", "system");
  }
  addLine(`⏳ Подключаюсь… Войду в комнату ${rid} сразу после соединения.`, "", "system");
}

if (joinBtn) {
  joinBtn.onclick = () => {
    const roomId = safeText(roomIdEl?.value);
    if (!roomId) return alert("Введите Room ID");
    ensureChat(roomId, "joined");
    joinRoom(roomId);
  };
}


// ============================
// Typing events
// ============================
if (msgInput) {
  msgInput.addEventListener("input", () => {
    if (!currentRoomId) return;

    const text = safeText(msgInput.value);

    if (!text) {
      if (iAmTyping) {
        socket.emit("typing_stop", { roomId: currentRoomId });
        iAmTyping = false;
      }
      return;
    }

    if (!iAmTyping) {
      socket.emit("typing_start", { roomId: currentRoomId });
      iAmTyping = true;
    }

    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      socket.emit("typing_stop", { roomId: currentRoomId });
      iAmTyping = false;
    }, 700);
  });
}

// ============================
// Send text message
// ============================
if (sendBtn) {
  sendBtn.onclick = () => {
    const text = safeText(msgInput?.value);
    if (!text) return;
    if (!currentRoomId) return alert("Сначала войдите в комнату");

    if (iAmTyping) {
      socket.emit("typing_stop", { roomId: currentRoomId });
      iAmTyping = false;
    }
    if (typingTimer) clearTimeout(typingTimer);

    emitOrQueue(
      "send_message",
      { roomId: currentRoomId, text },
      "Сообщение не отправлено."
    );

    msgInput.value = "";
  };
}


// ============================
// Socket events
// ============================
socket.on("system", (data) => addLine(`🛠 ${safeText(data?.text)}`, "", "system"));

socket.on("presence", (data) => {
  if (!data || data.roomId !== currentRoomId) return;
  const names = (data.users || []).map((u) => u.nick || String(u.senderId || "").slice(0, 6));
  if (onlineList) onlineList.textContent = `Онлайн (${names.length}): ${names.join(", ")}`;
});

socket.on("history", (data) => {
  if (!data || data.roomId !== currentRoomId) return;

  // активный чат: считаем прочитанным
  const c = getChat(currentRoomId);
  if (c && (c.unread || 0) > 0) {
    upsertChat({ ...c, unread: 0 });
    syncUnreadCount();
  }

  chatEl.innerHTML = "";
  addLine(`📜 История комнаты: ${data.roomId}`, "", "system");
  bumpChat(currentRoomId, { lastActivityAt: Date.now() });
  renderChatLists();

  for (const msg of data.messages || []) {
    const isMe = msg.senderId === senderId;
    const who = isMe ? "Вы" : (msg.nick || String(msg.senderId || "").slice(0, 6));
    const meta = renderMeta({ who, avatarId: msg.avatarId, timeText: new Date(msg.time || nowIso()).toLocaleTimeString() });
    const variant = isMe ? "me" : "other";

    if (msg.type === "audio") {
      renderAudioMessage({ audioId: msg.audioId, isMe, meta, variant });
    } else {
      addLine(safeText(msg.text), meta, variant);
    }
  }
});

socket.on("new_message", (msg) => {
  if (!msg) return;

  const rid = safeText(msg.roomId || currentRoomId);
  if (rid) {
    // если сообщение пришло из комнаты, которой нет в списке (например, по ссылке) — добавим как joined
    if (!getChat(rid)) ensureChat(rid, "joined");

    const preview = msg.type === "audio" ? "🎧 Голосовое сообщение" : safeText(msg.text || "");
    bumpChat(rid, { lastPreview: preview, lastActivityAt: Date.now() });
  }

  const isMe = msg.senderId === senderId;
  const who = isMe ? "Вы" : (msg.nick || String(msg.senderId || "").slice(0, 6));
  const meta = renderMeta({ who, avatarId: msg.avatarId, timeText: new Date(msg.time || nowIso()).toLocaleTimeString() });
  const variant = isMe ? "me" : "other";

  const isActiveRoom = rid && rid === currentRoomId;

  // unread + notify
  if (!isMe && rid) {
    const c = getChat(rid);
    if (c) {
      const inc = (document.hidden || !isActiveRoom) ? 1 : 0;
      if (inc) upsertChat({ ...c, unread: Number(c.unread || 0) + 1 });
    }
    syncUnreadCount();

    if (document.hidden || !isActiveRoom) {
      startBlink();
      beep();
      const body = msg.type === "audio" ? "🎧 Голосовое сообщение" : (msg.text || "Новое сообщение");
      showSystemNotification(`Сообщение от ${who}`, body);
    }
  }

  renderChatLists();

  // если это не текущая комната — не рендерим в открытом чате
  if (!isActiveRoom) return;

  if (msg.type === "audio") {
    renderAudioMessage({ audioId: msg.audioId, isMe, meta, variant });
    return;
  }

  addLine(safeText(msg.text), meta, variant);
});

socket.on("typing", (data) => {
  if (!data || data.roomId !== currentRoomId) return;
  if (data.senderId === senderId) return;

  if (data.isTyping) typingUsers.set(data.senderId, data.nick || "Кто-то");
  else typingUsers.delete(data.senderId);

  renderTyping();
});

// ============================
// Create room
// ============================
if (createBtn) {
  createBtn.onclick = () => {
    const newRoom = crypto.randomUUID().slice(0, 8);
    const title = safeText(prompt("Имя нового чата (можно пусто):", "") || "");
    const c = ensureChat(newRoom, "created");
    if (c && title) upsertChat({ ...c, title });
    if (roomIdEl) roomIdEl.value = newRoom;
    joinRoom(newRoom);
  };
}

// ============================
// Start
// ============================
loadChats();

// если чатов нет — создадим первый "мой чат"
if (chats.length === 0) {
  const firstRoom = crypto.randomUUID().slice(0, 8);
  ensureChat(firstRoom, "created");
}

renderChatLists();
updateActiveHeader();
syncUnreadCount();

const urlJoined = autoJoinFromUrl();
if (!urlJoined) {
  const last = localStorage.getItem(ACTIVE_ROOM_KEY);
  if (last && getChat(last)) {
    joinRoom(last);
  } else {
    // откроем самый свежий созданный чат
    const created = sortChats(chats.filter((c) => c.kind === "created"));
    if (created[0]?.roomId) joinRoom(created[0].roomId);
  }
}
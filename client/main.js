import { io } from "socket.io-client";

// ✅ ПУНКТ 18 (деплой на домен/VPS): подключаемся к тому же домену, где открыт сайт
const socket = io();

// анонимный id на вкладку
const senderId = crypto.randomUUID();

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

// ✅ уведомления: элементы
const soundBtn = document.getElementById("soundBtn");
const notifyBtn = document.getElementById("notifyBtn");

// ✅ голосовые
const recBtn = document.getElementById("recBtn");
const stopBtn = document.getElementById("stopBtn");
const recStatus = document.getElementById("recStatus");

let currentRoomId = "";

// ============================
// ✅ УВЕДОМЛЕНИЯ (toggle ON/OFF) + ✅ МИГАНИЕ
// ============================

const BASE_TITLE = document.title;

let unreadCount = 0;

// ✅ сохраняем настройки (toggle)
let soundEnabled = localStorage.getItem("soundEnabled") === "true";
let notifyEnabled = localStorage.getItem("notifyEnabled") === "true";

function updateTitle() {
  document.title = unreadCount > 0 ? `${BASE_TITLE} (${unreadCount})` : BASE_TITLE;
}

// ✅ мигание title
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
  unreadCount = 0;
  stopBlink();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) resetUnread();
});
window.addEventListener("focus", resetUnread);
window.addEventListener("click", resetUnread);

// ✅ звук
let audioCtx = null;

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
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

// ✅ системные уведомления
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

soundBtn.onclick = async () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem("soundEnabled", String(soundEnabled));

  if (soundEnabled) {
    try {
      await ensureAudio();
      await beep();
    } catch (err) {
      console.log("sound enable error:", err);
    }
  }

  renderNotifyButtons();
};

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

// ============================

// ===== typing state =====
let typingTimer = null;
let iAmTyping = false;
const typingUsers = new Map();

function renderTyping() {
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

// ===== voice state =====
let mediaRecorder = null;
let audioChunks = [];
let mediaStream = null;

let recStartAt = 0;
let recUiTimer = null;

function formatTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function stopRecUiTimer() {
  if (recUiTimer) clearInterval(recUiTimer);
  recUiTimer = null;
}

function setRecUi(isRecording) {
  recBtn.disabled = isRecording;
  stopBtn.disabled = !isRecording;

  if (!isRecording) {
    stopRecUiTimer();
    recStatus.textContent = "";
    return;
  }

  recStartAt = Date.now();
  stopRecUiTimer();

  recUiTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recStartAt) / 1000);
    recStatus.textContent = `🎙 Запись: ${formatTime(elapsed)}`;
  }, 250);
}

function addLine(text, meta = "") {
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `
    <div>${text}</div>
    ${meta ? `<div class="small">${meta}</div>` : ""}
  `;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
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
  return localStorage.getItem("nick") || "";
}

function setNick(nick) {
  localStorage.setItem("nick", nick);
  nickStatus.textContent = `Сохранено: ${nick}`;
}

function setInvite(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  inviteEl.textContent = `Ссылка-приглашение: ${url.toString()}`;
}

function autoJoinFromUrl() {
  const url = new URL(window.location.href);
  const roomFromUrl = url.searchParams.get("room");
  if (roomFromUrl) {
    roomIdEl.value = roomFromUrl;
    joinBtn.click();
  }
}

// ===== загрузка ника =====
const savedNick = getNick();
if (savedNick) {
  nickInput.value = savedNick;
  nickStatus.textContent = `Текущий ник: ${savedNick}`;
} else {
  const rnd = makeRandomNick();
  nickInput.value = rnd;
  setNick(rnd);
}

// ===== кнопки ника =====
saveNickBtn.onclick = () => {
  const nick = nickInput.value.trim();
  if (!nick) return alert("Введите ник");
  setNick(nick);
};

randomNickBtn.onclick = () => {
  const rnd = makeRandomNick();
  nickInput.value = rnd;
  setNick(rnd);
};

// ===== вход в комнату =====
joinBtn.onclick = () => {
  const roomId = roomIdEl.value.trim();
  if (!roomId) return alert("Введите Room ID");

  currentRoomId = roomId;

  typingUsers.clear();
  renderTyping();
  onlineList.textContent = "";

  socket.emit("join_room", { roomId, senderId, nick: getNick() });

  addLine(`✅ Вошли в комнату: ${roomId}`);
  setInvite(roomId);
};

// ===== typing events =====
msgInput.addEventListener("input", () => {
  if (!currentRoomId) return;

  const text = msgInput.value.trim();

  if (!text) {
    if (iAmTyping) {
      socket.emit("typing_stop", { roomId: currentRoomId, senderId });
      iAmTyping = false;
    }
    return;
  }

  if (!iAmTyping) {
    socket.emit("typing_start", { roomId: currentRoomId, senderId, nick: getNick() });
    iAmTyping = true;
  }

  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit("typing_stop", { roomId: currentRoomId, senderId });
    iAmTyping = false;
  }, 700);
});

// ===== отправка сообщения =====
sendBtn.onclick = () => {
  const text = msgInput.value.trim();
  if (!text) return;
  if (!currentRoomId) return alert("Сначала войдите в комнату");

  if (iAmTyping) {
    socket.emit("typing_stop", { roomId: currentRoomId, senderId });
    iAmTyping = false;
  }
  if (typingTimer) clearTimeout(typingTimer);

  socket.emit("send_message", { roomId: currentRoomId, text, senderId, nick: getNick() });
  msgInput.value = "";
};

// ============================
// ✅ Улучшение качества голосовых (ПУНКТЫ 1–2–3)
// 1) выбираем лучший mimeType (opus)
// 2) задаём стабильный высокий битрейт
// 3) добавляем аудио-настройки микрофона (echo/noise/gain)
// + ✅ ПУНКТ 4: mediaRecorder.start(250) (чанки каждые 250мс, меньше багов и пустых blob)
// ============================

function pickBestAudioMimeType() {
  const candidates = [
    "audio/webm;codecs=opus", // Chrome/Edge
    "audio/ogg;codecs=opus", // Firefox
    "audio/webm",
    "audio/ogg",
  ];

  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return ""; // на крайний случай: пусть браузер выберет сам
}

const VOICE_BITS_PER_SECOND = 128_000;

// ===== Голосовые =====
recBtn.onclick = async () => {
  if (!currentRoomId) return alert("Сначала войдите в комнату");
  if (!navigator.mediaDevices?.getUserMedia) {
    return alert("В этом браузере нет поддержки записи (getUserMedia).");
  }
  if (!window.MediaRecorder) {
    return alert("В этом браузере не поддерживается MediaRecorder.");
  }
  if (mediaRecorder && mediaRecorder.state === "recording") return;

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
    setRecUi(false);
    try {
      mediaRecorder?.stop();
    } catch {}
  };

  mediaRecorder.onstop = async () => {
    setRecUi(false);

    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
      mediaStream = null;
    }

    if (!audioChunks.length) {
      alert("Запись получилась пустой. Попробуй ещё раз.");
      mediaRecorder = null;
      return;
    }

    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    const arrayBuffer = await blob.arrayBuffer();

    socket.emit("send_voice", {
      roomId: currentRoomId,
      senderId,
      nick: getNick(),
      mime: blob.type || "audio/webm",
      audio: arrayBuffer,
    });

    audioChunks = [];
    mediaRecorder = null;
  };

  setRecUi(true);

  // ✅ ПУНКТ 4: делим запись на чанки каждые 250мс — меньше шанс “пустой blob/обрыв”
  mediaRecorder.start(250);
};

stopBtn.onclick = () => {
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
};

// ===== socket events =====
socket.on("system", (data) => addLine(`🛠 ${data.text}`));

socket.on("presence", (data) => {
  if (data.roomId !== currentRoomId) return;
  const names = data.users.map((u) => u.nick || u.senderId.slice(0, 6));
  onlineList.textContent = `Онлайн (${names.length}): ${names.join(", ")}`;
});

socket.on("history", (data) => {
  if (data.roomId !== currentRoomId) return;

  chatEl.innerHTML = "";
  addLine(`📜 История комнаты: ${data.roomId}`);

  for (const msg of data.messages) {
    const isMe = msg.senderId === senderId;
    const who = isMe ? "Вы" : (msg.nick || msg.senderId.slice(0, 6));
    const meta = `${who} • ${new Date(msg.time).toLocaleTimeString()}`;

    if (msg.type === "audio") {
      const url = `/audio/${msg.audioId}`;
      addLine(`<audio controls src="${url}"></audio>`, meta);
    } else {
      addLine(msg.text, meta);
    }
  }
});

socket.on("new_message", (msg) => {
  const isMe = msg.senderId === senderId;
  const who = isMe ? "Вы" : (msg.nick || msg.senderId.slice(0, 6));
  const meta = `${who} • ${new Date(msg.time).toLocaleTimeString()}`;

  if (msg.senderId !== senderId && document.hidden) {
    unreadCount += 1;
    updateTitle();
    startBlink();
    beep();

    const body = msg.type === "audio" ? "🎧 Голосовое сообщение" : (msg.text || "Новое сообщение");
    showSystemNotification(`Сообщение от ${who}`, body);
  }

  if (msg.type === "audio") {
    const url = `/audio/${msg.audioId}`;
    addLine(`<audio controls src="${url}"></audio>`, meta);
    return;
  }

  addLine(msg.text, meta);
});

socket.on("typing", (data) => {
  if (data.roomId !== currentRoomId) return;
  if (data.senderId === senderId) return;

  if (data.isTyping) typingUsers.set(data.senderId, data.nick || "Кто-то");
  else typingUsers.delete(data.senderId);

  renderTyping();
});

createBtn.onclick = () => {
  const newRoom = crypto.randomUUID().slice(0, 8);
  roomIdEl.value = newRoom;
  joinBtn.click();
};

autoJoinFromUrl();

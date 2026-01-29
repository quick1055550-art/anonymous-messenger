"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { Server } = require("socket.io");

// ============================
// Настройки (можно переопределять через ENV)
// ============================
const PORT = Number(process.env.PORT || 4000);

// В проде лучше задать: FRONTEND_ORIGIN="https://malaus.online"
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

// Куда сохраняем голосовые (на диск)
const AUDIO_DIR =
  process.env.AUDIO_DIR || path.join(__dirname, "data", "audio");

// Сколько хранить голосовые (по умолчанию 6 часов)
const AUDIO_TTL_MS = Number(process.env.AUDIO_TTL_MS || 6 * 60 * 60 * 1000);

// Лимит размера одного голосового (по умолчанию ~3MB)
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 3_000_000);

// Сколько сообщений храним в истории комнаты
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 200);

fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ============================
// App / Server / Socket.IO
// ============================
const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// CORS
app.use(
  cors({
    origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN,
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN,
    credentials: true,
  },
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

// ============================
// Память: история комнат + индекс голосовых
// ============================
const roomsHistory = new Map(); // roomId -> [messages]
const audioIndex = new Map(); // audioId -> { filePath, mime, createdAt, size }

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function extByMime(mime = "") {
  const m = String(mime).toLowerCase();
  if (m.includes("ogg")) return "ogg";
  if (m.includes("webm")) return "webm";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  return "bin";
}

function safeBufferFromAudio(audio) {
  if (!audio) return null;
  try {
    return Buffer.from(audio);
  } catch {
    return null;
  }
}

function addToHistory(roomId, payload) {
  if (!roomId) return;
  if (!roomsHistory.has(roomId)) roomsHistory.set(roomId, []);
  const arr = roomsHistory.get(roomId);
  arr.push(payload);
  if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
}

async function cleanupAudio() {
  const now = Date.now();

  for (const [id, item] of audioIndex.entries()) {
    if (now - item.createdAt > AUDIO_TTL_MS) {
      audioIndex.delete(id);
      try {
        await fs.promises.unlink(item.filePath);
      } catch {
        // не критично
      }
    }
  }
}

// каждые 60 секунд чистим старые голосовые
setInterval(() => {
  cleanupAudio().catch(() => {});
}, 60_000);

// ============================
// HTTP: отдать голосовое по ссылке /audio/:id
// + Range Requests (перемотка как в Telegram)
// ============================
function guessMimeByExt(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === "ogg") return "audio/ogg";
  if (ext === "webm") return "audio/webm";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  return "application/octet-stream";
}

async function resolveAudioPathById(id) {
  const item = audioIndex.get(id);
  if (item?.filePath && fs.existsSync(item.filePath)) {
    return { filePath: item.filePath, mime: item.mime || guessMimeByExt(item.filePath) };
  }

  // если индекс пустой после рестарта — попробуем найти на диске
  const candidates = ["webm", "ogg", "mp3", "wav", "bin"].map((ext) =>
    path.join(AUDIO_DIR, `${id}.${ext}`)
  );
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return null;

  return { filePath: found, mime: guessMimeByExt(found) };
}

app.get("/audio/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).send("Bad id");

  const resolved = await resolveAudioPathById(id);
  if (!resolved) return res.status(404).send("Not found");

  const { filePath, mime } = resolved;

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return res.status(404).send("Not found");
  }

  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader("Content-Type", mime);
  res.setHeader("Accept-Ranges", "bytes");

  // Без range — отдаём целиком
  if (!range) {
    res.setHeader("Content-Length", fileSize);
    return fs.createReadStream(filePath).pipe(res);
  }

  // Range: bytes=start-end
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(range));
  if (!match) {
    // Некорректный range
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    return res.status(416).send("Bad range");
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : fileSize - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize || end >= fileSize) {
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    return res.status(416).send("Range not satisfiable");
  }

  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", chunkSize);

  return fs.createReadStream(filePath, { start, end }).pipe(res);
});

// Главная просто как "жив ли сервер"
app.get("/", (_req, res) => {
  res.send("Server is running ✅");
});

// ============================
// Presence (кто онлайн) по комнатам
// ============================
const roomUsers = new Map(); // roomId -> Map(socketId -> {senderId, nick})

function emitPresence(roomId) {
  const usersMap = roomUsers.get(roomId);
  const users = usersMap ? Array.from(usersMap.values()) : [];
  io.to(roomId).emit("presence", { roomId, users });
}

// ============================
// Socket.IO
// ============================
io.on("connection", (socket) => {
  socket.on("join_room", (data = {}) => {
    const roomId = String(data.roomId || "").trim();
    const senderId = String(data.senderId || "").trim();
    const nick = String(data.nick || "").trim();
    const avatarId = Number(data.avatarId);

    if (!roomId || !senderId) return;

    socket.join(roomId);

    if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Map());
    roomUsers.get(roomId).set(socket.id, { senderId, nick, avatarId: Number.isFinite(avatarId) ? avatarId : undefined });

    socket.emit("system", { text: `Вы подключились к комнате ${roomId}` });

    const history = roomsHistory.get(roomId) || [];
    socket.emit("history", { roomId, messages: history });

    emitPresence(roomId);
  });

  socket.on("send_message", (data = {}) => {
    const roomId = String(data.roomId || "").trim();
    const text = String(data.text || "").trim();
    const senderId = String(data.senderId || "").trim();
    const nick = String(data.nick || "").trim();
    const avatarId = Number(data.avatarId);

    if (!roomId || !senderId || !text) return;

    const payload = {
      roomId,
      type: "text",
      text,
      senderId,
      nick,
      avatarId: Number.isFinite(avatarId) ? avatarId : undefined,
      time: new Date().toISOString(),
    };

    addToHistory(roomId, payload);
    io.to(roomId).emit("new_message", payload);
  });

  socket.on("send_voice", async (data = {}) => {
    const roomId = String(data.roomId || "").trim();
    const senderId = String(data.senderId || "").trim();
    const nick = String(data.nick || "").trim();
    const avatarId = Number(data.avatarId);
    const mime = String(data.mime || "audio/webm").trim();

    if (!roomId || !senderId) return;

    const buf = safeBufferFromAudio(data.audio);
    if (!buf || buf.length === 0) return;

    if (buf.length > MAX_AUDIO_BYTES) {
      socket.emit("system", {
        text: `⚠️ Голосовое слишком большое (${buf.length} байт). Уменьши длительность.`,
      });
      return;
    }

    const audioId = makeId();
    const ext = extByMime(mime);
    const filePath = path.join(AUDIO_DIR, `${audioId}.${ext}`);

    try {
      await fs.promises.writeFile(filePath, buf);
    } catch {
      socket.emit("system", { text: "❌ Ошибка сохранения голосового" });
      return;
    }

    audioIndex.set(audioId, {
      filePath,
      mime,
      createdAt: Date.now(),
      size: buf.length,
    });

    const payload = {
      roomId,
      type: "audio",
      audioId,
      mime,
      senderId,
      nick,
      avatarId: Number.isFinite(avatarId) ? avatarId : undefined,
      time: new Date().toISOString(),
    };

    addToHistory(roomId, payload);
    io.to(roomId).emit("new_message", payload);
  });

  socket.on("typing_start", (data = {}) => {
    const roomId = String(data.roomId || "").trim();
    if (!roomId) return;
    socket.to(roomId).emit("typing", {
      roomId,
      senderId: data.senderId,
      nick: data.nick,
      avatarId: data.avatarId,
      isTyping: true,
    });
  });

  socket.on("typing_stop", (data = {}) => {
    const roomId = String(data.roomId || "").trim();
    if (!roomId) return;
    socket.to(roomId).emit("typing", {
      roomId,
      senderId: data.senderId,
      nick: data.nick,
      isTyping: false,
    });
  });

  socket.on("disconnect", () => {
    for (const [roomId, usersMap] of roomUsers.entries()) {
      if (usersMap.has(socket.id)) {
        usersMap.delete(socket.id);
        if (usersMap.size === 0) roomUsers.delete(roomId);
        emitPresence(roomId);
      }
    }
  });
});

// ============================
// Надёжность: лог ошибок
// ============================
process.on("unhandledRejection", (reason) => {
  console.error("UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
});

// start
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

"use strict";

require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { Server } = require("socket.io");
const { Pool } = require("pg");

// ============================
// Настройки (можно переопределять через ENV)
// ============================
const PORT = Number(process.env.PORT || 4000);

// В проде лучше задать: FRONTEND_ORIGIN="https://malaus.online"
// В проде лучше задать: FRONTEND_ORIGIN="https://malaus.online"
// Можно через запятую: "https://malaus.online,https://www.malaus.online"
// Если не задано — разрешаем localhost (dev) и домен malaus.online (prod).
const FRONTEND_ORIGIN_RAW = (process.env.FRONTEND_ORIGIN || "").trim();
const ALLOWED_ORIGINS = FRONTEND_ORIGIN_RAW
  ? FRONTEND_ORIGIN_RAW.split(",").map((s) => s.trim()).filter(Boolean)
  : ["http://localhost:5173", "http://127.0.0.1:5173", "https://malaus.online", "https://www.malaus.online"];

function corsOrigin(origin, cb) {
  // запросы без Origin (например, curl) — разрешаем
  if (!origin) return cb(null, true);
  if (ALLOWED_ORIGINS.includes("*")) return cb(null, true);
  return cb(null, ALLOWED_ORIGINS.includes(origin));
}
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
app.set("trust proxy", 1);

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// CORS
app.use(
  cors({ origin: corsOrigin, credentials: true })
);

app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  path: "/socket.io",
  transports: ["websocket", "polling"],
  cors: { origin: corsOrigin, credentials: true },
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

// ============================
// SQL (PostgreSQL) — хранение истории сообщений
// ============================
// Чтобы включить БД, задай переменную окружения DATABASE_URL,
// например: postgres://user:password@127.0.0.1:5432/anonymous_messenger
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
let dbPool = null;

function isDbEnabled() {
  return Boolean(DATABASE_URL);
}

function getDbPool() {
  if (!dbPool) {
    dbPool = new Pool({
      connectionString: DATABASE_URL,
      // Для прод-сервисов часто нужен SSL. Для локального postgres на сервере — обычно нет.
      ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
    });
  }
  return dbPool;
}

async function initDb() {
  if (!isDbEnabled()) {
    console.log("ℹ️ DATABASE_URL не задан — работаем без SQL (история в памяти).");
    return;
  }

  const pool = getDbPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      type TEXT NOT NULL, -- text | audio | system
      text TEXT,
      audio_id TEXT,
      mime TEXT,
      sender_id TEXT NOT NULL,
      nick TEXT,
      avatar_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);`);

  console.log("✅ SQL подключён: таблицы готовы");
}

async function dbInsertMessage(payload) {
  if (!isDbEnabled()) return;

  const pool = getDbPool();
  const createdAt = payload.time ? new Date(payload.time) : new Date();

  await pool.query(
    `INSERT INTO messages
      (id, room_id, type, text, audio_id, mime, sender_id, nick, avatar_id, created_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      payload.id || makeId(),
      payload.roomId,
      payload.type,
      payload.text || null,
      payload.audioId || null,
      payload.mime || null,
      payload.senderId,
      payload.nick || null,
      Number.isFinite(payload.avatarId) ? payload.avatarId : null,
      createdAt,
    ]
  );
}

async function dbLoadHistory(roomId, limit = 200) {
  if (!isDbEnabled()) return roomsHistory.get(roomId) || [];

  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT * FROM (
        SELECT id, room_id, type, text, audio_id, mime, sender_id, nick, avatar_id, created_at
        FROM messages
        WHERE room_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      ) t
      ORDER BY created_at ASC`,
    [roomId, limit]
  );

  return rows.map((r) => ({
    id: r.id,
    roomId: r.room_id,
    type: r.type,
    text: r.text || undefined,
    audioId: r.audio_id || undefined,
    mime: r.mime || undefined,
    senderId: r.sender_id,
    nick: r.nick || "",
    avatarId: Number.isFinite(r.avatar_id) ? r.avatar_id : undefined,
    time: new Date(r.created_at).toISOString(),
  }));
}

// Инициализация БД (без top-level await)
initDb().catch((err) => {
  console.error("❌ Ошибка инициализации SQL:", err);
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
  socket.on("join_room", async (data = {}) => {
    const roomId = String(data.roomId || "").trim();
    const senderId = String(data.senderId || "").trim();
    const nick = String(data.nick || "").trim();
    const avatarId = Number(data.avatarId);

    if (!roomId || !senderId) return;

    socket.join(roomId);

    if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Map());
    roomUsers.get(roomId).set(socket.id, { senderId, nick, avatarId: Number.isFinite(avatarId) ? avatarId : undefined });

    socket.emit("system", { text: `Вы подключились к комнате ${roomId}` });

    const history = await dbLoadHistory(roomId, 200);
    socket.emit("history", { roomId, messages: history });

    emitPresence(roomId);
  });

  socket.on("send_message", async (data = {}) => {
    const roomId = String(data.roomId || "").trim();
    const text = String(data.text || "").trim();
    const senderId = String(data.senderId || "").trim();
    const nick = String(data.nick || "").trim();
    const avatarId = Number(data.avatarId);

    if (!roomId || !senderId || !text) return;

    const id = makeId();

    const payload = {
      id,
      roomId,
      type: "text",
      text,
      senderId,
      nick,
      avatarId: Number.isFinite(avatarId) ? avatarId : undefined,
      time: new Date().toISOString(),
    };

    // Сохраняем в SQL (если включено)
    await dbInsertMessage(payload);

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

    const id = makeId();

    const payload = {
      id,
      roomId,
      type: "audio",
      audioId,
      mime,
      senderId,
      nick,
      avatarId: Number.isFinite(avatarId) ? avatarId : undefined,
      time: new Date().toISOString(),
    };

    // Сохраняем в SQL (если включено)
    await dbInsertMessage(payload);

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
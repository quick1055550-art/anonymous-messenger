const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.use(cors());
app.use(express.json());

// HTTP-сервер на базе Express
const server = http.createServer(app);

// Socket.IO
const io = new Server(server, {
  cors: { origin: "*" },
});

// ==================
// История сообщений
// ==================

const roomMessages = new Map();
const MAX_HISTORY = 50;

function addToHistory(roomId, message) {
  const arr = roomMessages.get(roomId) || [];
  arr.push(message);

  if (arr.length > MAX_HISTORY) {
    arr.splice(0, arr.length - MAX_HISTORY);
  }

  roomMessages.set(roomId, arr);
}

function getHistory(roomId) {
  return roomMessages.get(roomId) || [];
}

// ==================
// Онлайн (presence)
// ==================

const roomUsers = new Map(); // roomId -> Map(socketId -> { senderId, nick })

function upsertUser(roomId, socketId, user) {
  const m = roomUsers.get(roomId) || new Map();
  m.set(socketId, user);
  roomUsers.set(roomId, m);
}

function removeUser(roomId, socketId) {
  const m = roomUsers.get(roomId);
  if (!m) return;
  m.delete(socketId);
  if (m.size === 0) roomUsers.delete(roomId);
}

function listUsers(roomId) {
  const m = roomUsers.get(roomId);
  if (!m) return [];
  return Array.from(m.values());
}

function broadcastPresence(roomId) {
  io.to(roomId).emit("presence", {
    roomId,
    users: listUsers(roomId),
  });
}

// ==================
// Голосовые (audio) — ПУНКТ 1
// ==================

const audioStore = new Map(); // audioId -> { buffer, mime, createdAt }
const AUDIO_TTL_MS = 1000 * 60 * 60; // 1 час

function cleanupAudio() {
  const now = Date.now();
  for (const [id, item] of audioStore.entries()) {
    if (now - item.createdAt > AUDIO_TTL_MS) audioStore.delete(id);
  }
}
setInterval(cleanupAudio, 60_000);

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// HTTP endpoint: выдача аудио по ссылке
app.get("/audio/:id", (req, res) => {
  const item = audioStore.get(req.params.id);
  if (!item) return res.status(404).send("Not found");

  res.setHeader("Content-Type", item.mime || "audio/webm");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});

// ==================

app.get("/", (req, res) => {
  res.send("Server is running ✅");
});

io.on("connection", (socket) => {
  console.log("✅ user connected:", socket.id);

  // ===== Вход в комнату =====
  socket.on("join_room", (data) => {
    const roomId = typeof data === "string" ? data : data.roomId;

    const senderId = typeof data === "string" ? socket.id : (data.senderId || socket.id);
    const nick = typeof data === "string" ? "Аноним" : (data.nick || "Аноним");

    socket.join(roomId);
    socket.data.roomId = roomId;

    upsertUser(roomId, socket.id, { senderId, nick });

    socket.emit("system", { text: `Вы вошли в комнату: ${roomId}` });

    socket.emit("history", {
      roomId,
      messages: getHistory(roomId),
    });

    broadcastPresence(roomId);
  });

  // ===== Текстовое сообщение =====
  socket.on("send_message", (data) => {
    const payload = {
      text: data.text,
      senderId: data.senderId,
      nick: data.nick || "",
      time: new Date().toISOString(),
    };

    addToHistory(data.roomId, payload);
    io.to(data.roomId).emit("new_message", payload);
  });

  // ===== Голосовое сообщение (audio) =====
  socket.on("send_voice", (data) => {
    // data: { roomId, senderId, nick, mime, audio } где audio = ArrayBuffer/Uint8Array
    const audioId = makeId();

    audioStore.set(audioId, {
      buffer: Buffer.from(data.audio),
      mime: data.mime || "audio/webm",
      createdAt: Date.now(),
    });

    const payload = {
      type: "audio",
      audioId,
      mime: data.mime || "audio/webm",
      senderId: data.senderId,
      nick: data.nick || "",
      time: new Date().toISOString(),
    };

    addToHistory(data.roomId, payload);
    io.to(data.roomId).emit("new_message", payload);
  });

  // ===== typing =====
  socket.on("typing_start", (data) => {
    socket.to(data.roomId).emit("typing", {
      roomId: data.roomId,
      senderId: data.senderId,
      nick: data.nick || "",
      isTyping: true,
    });
  });

  socket.on("typing_stop", (data) => {
    socket.to(data.roomId).emit("typing", {
      roomId: data.roomId,
      senderId: data.senderId,
      isTyping: false,
    });
  });

  // ===== Disconnect =====
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;

    if (roomId) {
      removeUser(roomId, socket.id);
      broadcastPresence(roomId);
    }

    console.log("❌ user disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});

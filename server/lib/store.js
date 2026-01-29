"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Lightweight user store:
 * - Prefers SQLite via better-sqlite3 if available (optional dependency).
 * - Falls back to JSON file storage if SQLite isn't installed.
 *
 * This keeps the project runnable out of the box, and enables SQL when installed.
 */

const DATA_DIR = path.join(__dirname, "..", "data");
const JSON_PATH = path.join(DATA_DIR, "users.json");
const SQLITE_PATH = path.join(DATA_DIR, "app.db");

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makeId() {
  return b64url(crypto.randomBytes(16));
}

function makeToken() {
  return b64url(crypto.randomBytes(32));
}

function hashToken(token, salt) {
  return crypto.createHash("sha256").update(`${salt}.${token}`, "utf8").digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function loadJson() {
  ensureDataDir();
  if (!fs.existsSync(JSON_PATH)) return { users: [] };
  try {
    const raw = fs.readFileSync(JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { users: [] };
    if (!Array.isArray(parsed.users)) return { users: [] };
    return parsed;
  } catch {
    return { users: [] };
  }
}

function saveJson(db) {
  ensureDataDir();
  fs.writeFileSync(JSON_PATH, JSON.stringify(db, null, 2), "utf8");
}

function normalizeUsername(u) {
  const s = String(u || "").trim().toLowerCase();
  if (!s) return "";
  // allow letters/digits/_ and 3..24
  if (!/^[a-z0-9_]{3,24}$/.test(s)) return "";
  return s;
}

function sanitizeDisplayName(n) {
  const s = String(n || "").trim();
  if (!s) return "Anonymous";
  return s.slice(0, 32);
}

function sanitizeBio(b) {
  const s = String(b || "").trim();
  return s.slice(0, 160);
}

function sanitizeAvatarId(a) {
  const n = Number(a);
  return Number.isFinite(n) ? Math.max(0, Math.min(9, Math.floor(n))) : 0;
}

function createJsonStore() {
  return {
    kind: "json",
    createUser({ displayName, username, avatarId }) {
      const db = loadJson();
      const cleanUsername = normalizeUsername(username);
      if (cleanUsername && db.users.some((u) => u.username === cleanUsername)) {
        const err = new Error("USERNAME_TAKEN");
        err.code = "USERNAME_TAKEN";
        throw err;
      }

      const id = makeId();
      const token = makeToken();
      const salt = makeId();
      const tokenHash = hashToken(token, salt);

      const user = {
        id,
        createdAt: nowIso(),
        displayName: sanitizeDisplayName(displayName),
        username: cleanUsername || "",
        avatarId: sanitizeAvatarId(avatarId),
        bio: "",
        tokenSalt: salt,
        tokenHash,
      };

      db.users.push(user);
      saveJson(db);

      return { user, token };
    },

    findUserByToken(token) {
      if (!token) return null;
      const db = loadJson();
      for (const u of db.users) {
        const calc = hashToken(token, u.tokenSalt);
        if (calc === u.tokenHash) return u;
      }
      return null;
    },

    findUserById(id) {
      const db = loadJson();
      return db.users.find((u) => u.id === id) || null;
    },

    updateUser(id, patch) {
      const db = loadJson();
      const idx = db.users.findIndex((u) => u.id === id);
      if (idx < 0) return null;

      const next = { ...db.users[idx] };

      if (patch.displayName !== undefined) next.displayName = sanitizeDisplayName(patch.displayName);
      if (patch.avatarId !== undefined) next.avatarId = sanitizeAvatarId(patch.avatarId);
      if (patch.bio !== undefined) next.bio = sanitizeBio(patch.bio);

      if (patch.username !== undefined) {
        const cleanUsername = normalizeUsername(patch.username);
        if (cleanUsername && db.users.some((u) => u.id !== id && u.username === cleanUsername)) {
          const err = new Error("USERNAME_TAKEN");
          err.code = "USERNAME_TAKEN";
          throw err;
        }
        next.username = cleanUsername || "";
      }

      db.users[idx] = next;
      saveJson(db);
      return next;
    },
  };
}

function createSqliteStore() {
  // Optional dependency: best-effort
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    return null;
  }

  ensureDataDir();
  const db = new Database(SQLITE_PATH);

  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      display_name TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar_id INTEGER NOT NULL,
      bio TEXT NOT NULL,
      token_salt TEXT NOT NULL,
      token_hash TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username <> '';
  `);

  const stmtInsert = db.prepare(`
    INSERT INTO users (id, created_at, display_name, username, avatar_id, bio, token_salt, token_hash)
    VALUES (@id, @created_at, @display_name, @username, @avatar_id, @bio, @token_salt, @token_hash)
  `);

  const stmtById = db.prepare(`SELECT * FROM users WHERE id = ?`);
  const stmtAll = db.prepare(`SELECT * FROM users`);
  const stmtUpdate = db.prepare(`
    UPDATE users SET display_name=@display_name, username=@username, avatar_id=@avatar_id, bio=@bio
    WHERE id=@id
  `);

  return {
    kind: "sqlite",
    createUser({ displayName, username, avatarId }) {
      const cleanUsername = normalizeUsername(username);

      if (cleanUsername) {
        const exists = db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(cleanUsername);
        if (exists) {
          const err = new Error("USERNAME_TAKEN");
          err.code = "USERNAME_TAKEN";
          throw err;
        }
      }

      const id = makeId();
      const token = makeToken();
      const salt = makeId();
      const tokenHash = hashToken(token, salt);

      const user = {
        id,
        createdAt: nowIso(),
        displayName: sanitizeDisplayName(displayName),
        username: cleanUsername || "",
        avatarId: sanitizeAvatarId(avatarId),
        bio: "",
        tokenSalt: salt,
        tokenHash,
      };

      stmtInsert.run({
        id: user.id,
        created_at: user.createdAt,
        display_name: user.displayName,
        username: user.username,
        avatar_id: user.avatarId,
        bio: user.bio,
        token_salt: user.tokenSalt,
        token_hash: user.tokenHash,
      });

      return { user, token };
    },

    findUserByToken(token) {
      if (!token) return null;
      const users = stmtAll.all();
      for (const row of users) {
        const calc = hashToken(token, row.token_salt);
        if (calc === row.token_hash) {
          return {
            id: row.id,
            createdAt: row.created_at,
            displayName: row.display_name,
            username: row.username,
            avatarId: row.avatar_id,
            bio: row.bio,
            tokenSalt: row.token_salt,
            tokenHash: row.token_hash,
          };
        }
      }
      return null;
    },

    findUserById(id) {
      const row = stmtById.get(id);
      if (!row) return null;
      return {
        id: row.id,
        createdAt: row.created_at,
        displayName: row.display_name,
        username: row.username,
        avatarId: row.avatar_id,
        bio: row.bio,
        tokenSalt: row.token_salt,
        tokenHash: row.token_hash,
      };
    },

    updateUser(id, patch) {
      const existing = this.findUserById(id);
      if (!existing) return null;

      const cleanUsername = patch.username !== undefined ? normalizeUsername(patch.username) : existing.username;

      if (patch.username !== undefined && cleanUsername) {
        const taken = db.prepare(`SELECT 1 FROM users WHERE username = ? AND id <> ?`).get(cleanUsername, id);
        if (taken) {
          const err = new Error("USERNAME_TAKEN");
          err.code = "USERNAME_TAKEN";
          throw err;
        }
      }

      const next = {
        ...existing,
        displayName: patch.displayName !== undefined ? sanitizeDisplayName(patch.displayName) : existing.displayName,
        username: patch.username !== undefined ? (cleanUsername || "") : existing.username,
        avatarId: patch.avatarId !== undefined ? sanitizeAvatarId(patch.avatarId) : existing.avatarId,
        bio: patch.bio !== undefined ? sanitizeBio(patch.bio) : existing.bio,
      };

      stmtUpdate.run({
        id: next.id,
        display_name: next.displayName,
        username: next.username,
        avatar_id: next.avatarId,
        bio: next.bio,
      });

      return next;
    },
  };
}

let storeSingleton = null;

function getStore() {
  if (storeSingleton) return storeSingleton;
  storeSingleton = createSqliteStore() || createJsonStore();
  return storeSingleton;
}

function publicUser(u) {
  return {
    id: u.id,
    createdAt: u.createdAt,
    displayName: u.displayName,
    username: u.username,
    avatarId: u.avatarId,
    bio: u.bio,
  };
}

module.exports = {
  getStore,
  publicUser,
};

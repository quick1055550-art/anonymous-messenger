"use strict";

const { getStore, publicUser } = require("./store");

function getBearerToken(req) {
  const h = String(req.headers.authorization || "").trim();
  if (!h) return "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  const store = getStore();
  const user = store.findUserByToken(token);
  if (!user) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
  req.user = user;
  req.userToken = token;
  next();
}

function attachSocketAuth(io) {
  io.use((socket, next) => {
    const token = String(socket.handshake?.auth?.token || socket.handshake?.headers?.authorization || "").trim();
    const clean = token.startsWith("Bearer ") ? token.slice(7).trim() : token;
    const store = getStore();
    const user = store.findUserByToken(clean);
    if (!user) return next(new Error("UNAUTHORIZED"));
    socket.user = user;
    socket.userToken = clean;
    next();
  });
}

function authRoutes(app) {
  const store = getStore();

  // Create account (no phone/email). Returns token ONCE, store it client-side.
  app.post("/api/auth/register", (req, res) => {
    const displayName = req.body?.displayName;
    const username = req.body?.username;
    const avatarId = req.body?.avatarId;

    try {
      const { user, token } = store.createUser({ displayName, username, avatarId });
      res.json({
        ok: true,
        token,
        profile: publicUser(user),
      });
    } catch (e) {
      if (e?.code === "USERNAME_TAKEN") {
        return res.status(409).json({ ok: false, error: "USERNAME_TAKEN" });
      }
      res.status(500).json({ ok: false, error: "REGISTER_FAILED" });
    }
  });

  // Get my profile
  app.get("/api/me", requireAuth, (req, res) => {
    res.json({ ok: true, profile: publicUser(req.user) });
  });

  // Update my profile
  app.patch("/api/me", requireAuth, (req, res) => {
    try {
      const nextUser = store.updateUser(req.user.id, {
        displayName: req.body?.displayName,
        username: req.body?.username,
        avatarId: req.body?.avatarId,
        bio: req.body?.bio,
      });
      res.json({ ok: true, profile: publicUser(nextUser) });
    } catch (e) {
      if (e?.code === "USERNAME_TAKEN") {
        return res.status(409).json({ ok: false, error: "USERNAME_TAKEN" });
      }
      res.status(500).json({ ok: false, error: "UPDATE_FAILED" });
    }
  });
}

module.exports = {
  authRoutes,
  requireAuth,
  attachSocketAuth,
};

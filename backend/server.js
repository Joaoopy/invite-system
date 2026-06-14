require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const axios = require("axios");
const initSqlJs = require("sql.js");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "invites.db");

const DISCORD = {
  clientId:     process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  botToken:     process.env.DISCORD_BOT_TOKEN,
  guildId:      "1513325231647752213",
  redirectUri:  process.env.REDIRECT_URI || "http://localhost:3000/auth/callback",
  teamRoleId:   "1513341421749407985",
  adminRoles:   ["1513341421749407985", "1513570942415147219"],
};

// ── Cache de membros ────────────────────────────────────────────
const membersCache = {
  data: null,
  lastFetch: 0,
  TTL: 5 * 60 * 1000, // 5 minutos
};

async function getMembers(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && membersCache.data && (now - membersCache.lastFetch) < membersCache.TTL) {
    return membersCache.data;
  }

  let members = [];
  let after = "0";

  while (true) {
    const r = await axios.get(
      `https://discord.com/api/guilds/${DISCORD.guildId}/members?limit=100&after=${after}`,
      {
        headers: { Authorization: `Bot ${DISCORD.botToken}` },
        timeout: 10000,
      }
    );
    if (!r.data.length) break;
    members = members.concat(r.data);
    after = r.data[r.data.length - 1].user.id;
    if (r.data.length < 100) break;

    // Pequena pausa entre páginas para não estourar rate limit
    await new Promise(res => setTimeout(res, 200));
  }

  membersCache.data = members;
  membersCache.lastFetch = Date.now();
  console.log(`[Cache] ${members.length} membros carregados.`);
  return members;
}

// ── DB ──────────────────────────────────────────────────────────
let db;
async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      userId TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      avatar TEXT,
      totalInvites INTEGER DEFAULT 0,
      joinedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      username TEXT NOT NULL,
      invitedById TEXT,
      invitedBy TEXT,
      date TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT,
      date TEXT DEFAULT (datetime('now'))
    );
  `);
  saveDB();
}

function saveDB() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDB();
}

function logAction(action, details) {
  run("INSERT INTO logs (action, details) VALUES (?, ?)", [action, JSON.stringify(details)]);
}

// ── Middleware ──────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "invite-tracker-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 },
}));
app.use(express.static(path.join(__dirname, "../frontend/public")));

// ── Auth helpers ────────────────────────────────────────────────
function isTeam(roles)  { return roles.includes(DISCORD.teamRoleId); }
function isAdmin(roles) { return DISCORD.adminRoles.some(r => roles.includes(r)); }

function requireTeam(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Não autenticado." });
  if (!req.session.user.isTeam) return res.status(403).json({ error: "Sem permissão." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Não autenticado." });
  if (!req.session.user.isAdmin) return res.status(403).json({ error: "Acesso admin necessário." });
  next();
}

// ── OAuth2 ──────────────────────────────────────────────────────
app.get("/auth/login", (req, res) => {
  const params = new URLSearchParams({
    client_id:     DISCORD.clientId,
    redirect_uri:  DISCORD.redirectUri,
    response_type: "code",
    scope:         "identify guilds.members.read",
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect("/?error=no_code");
  try {
    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id:     DISCORD.clientId,
        client_secret: DISCORD.clientSecret,
        grant_type:    "authorization_code",
        code,
        redirect_uri:  DISCORD.redirectUri,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const { access_token } = tokenRes.data;

    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { id, username, avatar } = userRes.data;

    const memberRes = await axios.get(
      `https://discord.com/api/guilds/${DISCORD.guildId}/members/${id}`,
      { headers: { Authorization: `Bot ${DISCORD.botToken}` } }
    );
    const roles = memberRes.data.roles || [];

    if (!isTeam(roles)) return res.redirect("/?error=no_access");

    const avatarUrl = avatar
      ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`
      : null;

    const existing = query("SELECT userId FROM users WHERE userId = ?", [id]);
    if (existing.length) {
      run("UPDATE users SET username = ?, avatar = ? WHERE userId = ?", [username, avatarUrl, id]);
    } else {
      run("INSERT INTO users (userId, username, avatar) VALUES (?, ?, ?)", [id, username, avatarUrl]);
    }

    req.session.user = {
      id, username, avatar: avatarUrl,
      roles, isAdmin: isAdmin(roles), isTeam: true,
    };

    logAction("LOGIN", { userId: id, username });
    res.redirect("/");
  } catch (err) {
    console.error("[OAuth2 Error]", err.response?.data || err.message);
    res.redirect("/?error=auth_failed");
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

app.get("/auth/me", (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: req.session.user });
});

// ── Team ─────────────────────────────────────────────────────────
app.get("/api/team", requireTeam, async (req, res) => {
  try {
    const members = await getMembers();
    const team = members
      .filter(m => m.roles.includes(DISCORD.teamRoleId))
      .map(m => ({
        userId:   m.user.id,
        username: m.user.username,
        nick:     m.nick || null,
        avatar:   m.user.avatar
          ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
          : null,
        roles:   m.roles,
        isAdmin: isAdmin(m.roles),
      }));
    res.json(team);
  } catch (err) {
    console.error("[Team Error]", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao buscar membros." });
  }
});

// ── Busca de membros ─────────────────────────────────────────────
app.get("/api/user/search", requireTeam, async (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  if (!q) return res.json([]);
  try {
    const members = await getMembers();
    const results = members
      .filter(m =>
        m.user.id === q ||
        m.user.username.toLowerCase().includes(q) ||
        (m.nick || "").toLowerCase().includes(q)
      )
      .slice(0, 20)
      .map(m => {
        const local = query("SELECT totalInvites FROM users WHERE userId = ?", [m.user.id]);
        return {
          userId:       m.user.id,
          username:     m.user.username,
          nick:         m.nick || null,
          avatar:       m.user.avatar
            ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
            : null,
          totalInvites: local.length ? local[0].totalInvites : 0,
          roles:        m.roles,
          isAdmin:      isAdmin(m.roles),
          isTeam:       isTeam(m.roles),
        };
      });
    res.json(results);
  } catch (err) {
    console.error("[Search Error]", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao buscar." });
  }
});

// ── Forçar refresh do cache (admin) ─────────────────────────────
app.post("/api/admin/refresh-cache", requireAdmin, async (req, res) => {
  try {
    await getMembers(true);
    res.json({ success: true, message: "Cache atualizado." });
  } catch (err) {
    res.status(500).json({ error: "Erro ao atualizar cache." });
  }
});

// ── Stats pessoais ───────────────────────────────────────────────
app.get("/api/my-stats", requireTeam, (req, res) => {
  const userId = req.session.user.id;
  const total   = query("SELECT COUNT(*) AS c FROM invites WHERE invitedById = ?", [userId])[0].c;
  const today   = query("SELECT COUNT(*) AS c FROM invites WHERE invitedById = ? AND date(date) = date('now')", [userId])[0].c;
  const week    = query("SELECT COUNT(*) AS c FROM invites WHERE invitedById = ? AND date >= datetime('now','-7 days')", [userId])[0].c;
  const month   = query("SELECT COUNT(*) AS c FROM invites WHERE invitedById = ? AND strftime('%Y-%m',date) = strftime('%Y-%m','now')", [userId])[0].c;
  const history = query("SELECT username, date FROM invites WHERE invitedById = ? ORDER BY date DESC LIMIT 10", [userId]);
  const myRank  = query("SELECT COUNT(*) + 1 AS rank FROM users WHERE totalInvites > (SELECT totalInvites FROM users WHERE userId = ?)", [userId])[0].rank;
  res.json({ total, today, week, month, history, rank: myRank });
});

// ── Ranking ──────────────────────────────────────────────────────
app.get("/api/invites/ranking", requireTeam, (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(query(
    "SELECT userId, username, avatar, totalInvites FROM users WHERE totalInvites > 0 ORDER BY totalInvites DESC LIMIT ?",
    [limit]
  ));
});

app.get("/api/invites/ranking/monthly", requireTeam, (req, res) => {
  res.json(query(`
    SELECT invitedById AS userId, invitedBy AS username, COUNT(*) AS totalInvites
    FROM invites WHERE invitedById IS NOT NULL
      AND strftime('%Y-%m',date) = strftime('%Y-%m','now')
    GROUP BY invitedById ORDER BY totalInvites DESC LIMIT 20
  `));
});

// ── Stats dashboard ──────────────────────────────────────────────
app.get("/api/stats", requireTeam, (req, res) => {
  const totalInvites   = query("SELECT COUNT(*) AS c FROM invites WHERE invitedById IS NOT NULL")[0].c;
  const monthlyInvites = query("SELECT COUNT(*) AS c FROM invites WHERE invitedById IS NOT NULL AND strftime('%Y-%m',date)=strftime('%Y-%m','now')")[0].c;
  const lastMembers    = query("SELECT userId, username, invitedBy, date FROM invites ORDER BY date DESC LIMIT 5");
  res.json({ totalInvites, monthlyInvites, lastMembers });
});

// ── Bot registra novo membro ─────────────────────────────────────
app.post("/api/invites", (req, res) => {
  const { userId, username, invitedBy, invitedById, avatar } = req.body;
  if (!userId || !username) return res.status(400).json({ error: "Dados insuficientes." });

  const existing = query("SELECT userId FROM users WHERE userId = ?", [userId]);
  if (existing.length) {
    run("UPDATE users SET username = ? WHERE userId = ?", [username, userId]);
  } else {
    run("INSERT INTO users (userId, username, avatar) VALUES (?, ?, ?)", [userId, username, avatar || null]);
  }

  run("INSERT INTO invites (userId, username, invitedById, invitedBy) VALUES (?, ?, ?, ?)",
    [userId, username, invitedById || null, invitedBy || null]);

  if (invitedById) {
    const inv = query("SELECT userId FROM users WHERE userId = ?", [invitedById]);
    if (inv.length) {
      run("UPDATE users SET totalInvites = totalInvites + 1 WHERE userId = ?", [invitedById]);
    } else {
      run("INSERT INTO users (userId, username, totalInvites) VALUES (?, ?, 1)", [invitedById, invitedBy || invitedById]);
    }
  }

  // Invalidar cache ao entrar novo membro
  membersCache.lastFetch = 0;

  logAction("NEW_MEMBER", { userId, username, invitedBy });
  res.json({ success: true });
});

// ── Admin routes ─────────────────────────────────────────────────
app.get("/api/invites/history", requireAdmin, (req, res) => {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 30;
  const offset = (page - 1) * limit;
  const total  = query("SELECT COUNT(*) AS c FROM invites")[0].c;
  const data   = query("SELECT * FROM invites ORDER BY date DESC LIMIT ? OFFSET ?", [limit, offset]);
  res.json({ total, page, limit, data });
});

app.get("/api/user/:userId", requireTeam, (req, res) => {
  const user = query("SELECT * FROM users WHERE userId = ?", [req.params.userId]);
  if (!user.length) return res.status(404).json({ error: "Não encontrado." });
  const invitedPeople = query("SELECT username, date FROM invites WHERE invitedById = ? ORDER BY date DESC", [req.params.userId]);
  const joinedVia     = query("SELECT invitedBy, date FROM invites WHERE userId = ? ORDER BY date ASC LIMIT 1", [req.params.userId])[0] || null;
  res.json({ ...user[0], invitedPeople, joinedVia });
});

app.get("/api/admin/logs", requireAdmin, (req, res) => {
  res.json(query("SELECT * FROM logs ORDER BY date DESC LIMIT 100"));
});

app.post("/api/admin/reset/:userId", requireAdmin, (req, res) => {
  run("UPDATE users SET totalInvites = 0 WHERE userId = ?", [req.params.userId]);
  logAction("ADMIN_RESET", { userId: req.params.userId });
  res.json({ success: true });
});

app.post("/api/admin/set-invites", requireAdmin, (req, res) => {
  const { userId, total } = req.body;
  run("UPDATE users SET totalInvites = ? WHERE userId = ?", [total, userId]);
  logAction("ADMIN_SET_INVITES", { userId, total });
  res.json({ success: true });
});

app.delete("/api/admin/member/:userId", requireAdmin, (req, res) => {
  run("DELETE FROM users WHERE userId = ?", [req.params.userId]);
  run("DELETE FROM invites WHERE userId = ?", [req.params.userId]);
  logAction("ADMIN_DELETE", { userId: req.params.userId });
  res.json({ success: true });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/public/index.html"));
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
    // Pré-aquecer cache ao iniciar
    getMembers().catch(e => console.error("[Cache warmup]", e.message));
  });
});

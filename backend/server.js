require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const DISCORD = {
  clientId:     process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  botToken:     process.env.DISCORD_BOT_TOKEN,
  guildId:      "1513325231647752213",
  redirectUri:  process.env.REDIRECT_URI || "http://localhost:3000/auth/callback",

  // Cargos com acesso total: dashboard, ranking, equipe, histórico e painel admin
  adminRoles: [
    "1513341421749407985", // Equipe (cargo legado, mantido por segurança)
    "1513570942415147219", // Administrador Geral
    "1513571104734711879", // Responsável Geral de Divulgação do Partido
    "1513570807560011957", // Presidente
    "1513570695156858970", // Vice Presidente
    "1513570569084338459", // Diretor Divulgacional
  ],

  // Cargos com acesso a histórico (mas sem editar/resetar convites)
  supervisorRoles: [
    "1513570451153096805", // Coordenador Administrativo
    "1513570327915921569", // Coordenador
    "1513570215466762323", // Supervisor
  ],

  // Cargos com acesso básico: dashboard pessoal, ranking, equipe
  teamRoles: [
    "1513566687260184577", // Instrutor
    "1513565655796809798", // Estagiário
    "1513565038294728714", // Divulgador Sênior
    "1513564823957405756", // Divulgador Aprendiz
  ],
};

// ── Hierarquia completa (ordem do mais alto pro mais baixo) ────────
// Usada para: categorizar a página Equipe e fazer promoção/rebaixamento
const HIERARCHY = [
  { id: "1513571104734711879", name: "Responsável Geral de Divulgação", category: "Alto Conselho", color: "#f5a623" },
  { id: "1513570942415147219", name: "Administrador Geral",             category: "Alto Conselho", color: "#f5a623" },
  { id: "1513570807560011957", name: "Presidente",                      category: "Alto Escalão",  color: "#3b82f6" },
  { id: "1513570695156858970", name: "Vice Presidente",                 category: "Alto Escalão",  color: "#3b82f6" },
  { id: "1513570569084338459", name: "Diretor Divulgacional",           category: "Alto Escalão",  color: "#3b82f6" },
  { id: "1513570451153096805", name: "Coordenador Administrativo",      category: "Moderação Divulgacional", color: "#22d3ee" },
  { id: "1513570327915921569", name: "Coordenador",                     category: "Moderação Divulgacional", color: "#22d3ee" },
  { id: "1513570215466762323", name: "Supervisor",                      category: "Equipe Divulgadora", color: "#a78bfa" },
  { id: "1513566687260184577", name: "Instrutor",                       category: "Equipe Divulgadora", color: "#a78bfa" },
  { id: "1513565655796809798", name: "Estagiário",                      category: "Equipe Divulgadora", color: "#a78bfa" },
  { id: "1513565038294728714", name: "Divulgador Sênior",               category: "Equipe Divulgadora", color: "#a78bfa" },
  { id: "1513564823957405756", name: "Divulgador Aprendiz",             category: "Equipe Divulgadora", color: "#a78bfa" },
];

function getHierarchyEntry(roleId) {
  return HIERARCHY.find(h => h.id === roleId) || null;
}

// Pega o cargo de hierarquia mais alto que o membro possui
function getHighestRole(roles) {
  for (const h of HIERARCHY) {
    if (roles.includes(h.id)) return h;
  }
  return null;
}

// Pega o próximo cargo (acima) na hierarquia, undefined se já for o topo
function getNextRole(currentRoleId) {
  const idx = HIERARCHY.findIndex(h => h.id === currentRoleId);
  if (idx <= 0) return null; // já é o topo ou não encontrado
  return HIERARCHY[idx - 1];
}

// Pega o cargo anterior (abaixo) na hierarquia, undefined se já for o último
function getPreviousRole(currentRoleId) {
  const idx = HIERARCHY.findIndex(h => h.id === currentRoleId);
  if (idx === -1 || idx >= HIERARCHY.length - 1) return null;
  return HIERARCHY[idx + 1];
}

// ── Turso via HTTP API (evita bugs do client SDK) ──────────────────
const TURSO_URL   = (process.env.TURSO_DATABASE_URL || "").replace("libsql://", "https://");
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

async function tursoExec(statements) {
  // statements: array de { sql, args }
  const body = {
    requests: statements.map(s => ({
      type: "execute",
      stmt: { sql: s.sql, args: (s.args || []).map(toTursoArg) },
    })).concat([{ type: "close" }]),
  };

  const res = await axios.post(`${TURSO_URL}/v2/pipeline`, body, {
    headers: {
      Authorization: `Bearer ${TURSO_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  return res.data.results;
}

function toTursoArg(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") return { type: "integer", value: String(v) };
  return { type: "text", value: String(v) };
}

function rowsFromResult(result) {
  if (!result || result.type !== "ok") return [];
  const res = result.response.result;
  const cols = res.cols.map(c => c.name);
  return res.rows.map(row => {
    const obj = {};
    row.forEach((cell, i) => {
      obj[cols[i]] = cell.value !== undefined ? cell.value : null;
    });
    return obj;
  });
}

async function query(sql, args = []) {
  const results = await tursoExec([{ sql, args }]);
  return rowsFromResult(results[0]);
}

async function run(sql, args = []) {
  await tursoExec([{ sql, args }]);
}

async function logAction(action, details) {
  await run("INSERT INTO logs (action, details) VALUES (?, ?)", [action, JSON.stringify(details)]);
}

async function initDB() {
  await tursoExec([
    { sql: `CREATE TABLE IF NOT EXISTS users (
      userId TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      avatar TEXT,
      totalInvites INTEGER DEFAULT 0,
      joinedAt TEXT DEFAULT (datetime('now'))
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      username TEXT NOT NULL,
      invitedById TEXT,
      invitedBy TEXT,
      date TEXT DEFAULT (datetime('now'))
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT,
      date TEXT DEFAULT (datetime('now'))
    )` },
  ]);
  console.log("✅ Banco de dados Turso inicializado.");
}

// ── Cache de membros do Discord ──────────────────────────────────
const membersCache = { data: null, lastFetch: 0, TTL: 5 * 60 * 1000 };

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
      { headers: { Authorization: `Bot ${DISCORD.botToken}` }, timeout: 10000 }
    );
    if (!r.data.length) break;
    members = members.concat(r.data);
    after = r.data[r.data.length - 1].user.id;
    if (r.data.length < 100) break;
    await new Promise(res => setTimeout(res, 200));
  }
  membersCache.data = members;
  membersCache.lastFetch = Date.now();
  console.log(`[Cache] ${members.length} membros carregados.`);
  return members;
}

// ── Middleware ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "invite-tracker-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 },
}));
app.use(express.static(path.join(__dirname, "../frontend/public")));

// ── Auth helpers ──────────────────────────────────────────────────
function isAdmin(roles)      { return DISCORD.adminRoles.some(r => roles.includes(r)); }
function isSupervisor(roles) { return DISCORD.supervisorRoles.some(r => roles.includes(r)); }
function isTeamRole(roles)   { return DISCORD.teamRoles.some(r => roles.includes(r)); }

// Pertence à equipe = tem qualquer um dos três níveis
function isTeam(roles) {
  return isAdmin(roles) || isSupervisor(roles) || isTeamRole(roles);
}

// Pode ver histórico = admin ou supervisor
function canViewHistory(roles) {
  return isAdmin(roles) || isSupervisor(roles);
}

function requireTeam(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Não autenticado." });
  if (!req.session.user.isTeam) return res.status(403).json({ error: "Sem permissão." });
  next();
}
function requireHistoryAccess(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Não autenticado." });
  if (!req.session.user.canViewHistory) return res.status(403).json({ error: "Sem permissão para ver histórico." });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Não autenticado." });
  if (!req.session.user.isAdmin) return res.status(403).json({ error: "Acesso admin necessário." });
  next();
}

// ── OAuth2 ─────────────────────────────────────────────────────────
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

    const existing = await query("SELECT userId FROM users WHERE userId = ?", [id]);
    if (existing.length) {
      await run("UPDATE users SET username = ?, avatar = ? WHERE userId = ?", [username, avatarUrl, id]);
    } else {
      await run("INSERT INTO users (userId, username, avatar) VALUES (?, ?, ?)", [id, username, avatarUrl]);
    }

    req.session.user = {
      id, username, avatar: avatarUrl, roles,
      isAdmin: isAdmin(roles),
      isSupervisor: isSupervisor(roles),
      canViewHistory: canViewHistory(roles),
      isTeam: true,
    };

    await logAction("LOGIN", { userId: id, username });
    res.redirect("/");
  } catch (err) {
    console.error("[OAuth2 Error]", err.response?.data || err.message);
    res.redirect("/?error=auth_failed");
  }
});

app.get("/auth/logout", (req, res) => { req.session.destroy(); res.redirect("/"); });

app.get("/auth/me", (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: req.session.user });
});

// ── Team ──────────────────────────────────────────────────────────
app.get("/api/team", requireTeam, async (req, res) => {
  try {
    const members = await getMembers();
    const team = members
      .filter(m => isTeam(m.roles))
      .map(m => {
        const hierarchy = getHighestRole(m.roles);
        return {
          userId:   m.user.id,
          username: m.user.username,
          nick:     m.nick || null,
          avatar:   m.user.avatar
            ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
            : null,
          roles:        m.roles,
          isAdmin:      isAdmin(m.roles),
          isSupervisor: isSupervisor(m.roles),
          roleName:     hierarchy ? hierarchy.name : "Sem cargo",
          roleCategory: hierarchy ? hierarchy.category : "Outros",
          roleColor:    hierarchy ? hierarchy.color : "#64748b",
        };
      });
    res.json(team);
  } catch (err) {
    console.error("[Team Error]", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao buscar membros." });
  }
});

// ── Hierarquia completa (para o painel de promoção) ────────────────
app.get("/api/hierarchy", requireAdmin, (req, res) => {
  res.json(HIERARCHY);
});

// ── Promover / rebaixar membro ──────────────────────────────────────
app.post("/api/admin/promote", requireAdmin, async (req, res) => {
  const { userId, direction } = req.body; // direction: "up" ou "down"
  if (!userId || !["up", "down"].includes(direction)) {
    return res.status(400).json({ error: "Dados inválidos." });
  }
  try {
    const members = await getMembers(true);
    const member = members.find(m => m.user.id === userId);
    if (!member) return res.status(404).json({ error: "Membro não encontrado no servidor." });

    const currentRole = getHighestRole(member.roles);
    if (!currentRole) return res.status(400).json({ error: "Este membro não possui nenhum cargo da hierarquia." });

    const targetRole = direction === "up"
      ? getNextRole(currentRole.id)
      : getPreviousRole(currentRole.id);

    if (!targetRole) {
      return res.status(400).json({
        error: direction === "up" ? "Este membro já está no cargo mais alto." : "Este membro já está no cargo mais baixo."
      });
    }

    // Remove cargo atual, adiciona novo cargo
    await axios.delete(
      `https://discord.com/api/guilds/${DISCORD.guildId}/members/${userId}/roles/${currentRole.id}`,
      { headers: { Authorization: `Bot ${DISCORD.botToken}` } }
    );
    await axios.put(
      `https://discord.com/api/guilds/${DISCORD.guildId}/members/${userId}/roles/${targetRole.id}`,
      {},
      { headers: { Authorization: `Bot ${DISCORD.botToken}` } }
    );

    membersCache.lastFetch = 0; // invalida cache
    await logAction(direction === "up" ? "PROMOTE" : "DEMOTE", {
      userId, from: currentRole.name, to: targetRole.name,
    });

    res.json({ success: true, from: currentRole.name, to: targetRole.name });
  } catch (err) {
    console.error("[Promote Error]", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao alterar cargo. Verifique se o bot tem permissão Gerenciar Cargos e está posicionado acima do cargo na hierarquia do Discord." });
  }
});

// ── Busca de membros ───────────────────────────────────────────────
app.get("/api/user/search", requireTeam, async (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  if (!q) return res.json([]);
  try {
    const members = await getMembers();
    const filtered = members.filter(m =>
      m.user.id === q ||
      m.user.username.toLowerCase().includes(q) ||
      (m.nick || "").toLowerCase().includes(q)
    ).slice(0, 20);

    const results = [];
    for (const m of filtered) {
      const local = await query("SELECT totalInvites FROM users WHERE userId = ?", [m.user.id]);
      results.push({
        userId:       m.user.id,
        username:     m.user.username,
        nick:         m.nick || null,
        avatar:       m.user.avatar
          ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
          : null,
        totalInvites: local.length ? Number(local[0].totalInvites) : 0,
        roles:        m.roles,
        isAdmin:      isAdmin(m.roles),
        isTeam:       isTeam(m.roles),
      });
    }
    res.json(results);
  } catch (err) {
    console.error("[Search Error]", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao buscar." });
  }
});

app.post("/api/admin/refresh-cache", requireAdmin, async (req, res) => {
  try { await getMembers(true); res.json({ success: true }); }
  catch { res.status(500).json({ error: "Erro ao atualizar cache." }); }
});

// ── Stats pessoais ───────────────────────────────────────────────
app.get("/api/my-stats", requireTeam, async (req, res) => {
  const userId = req.session.user.id;
  const total   = Number((await query("SELECT COUNT(*) AS c FROM invites WHERE invitedById = ?", [userId]))[0].c);
  const today   = Number((await query("SELECT COUNT(*) AS c FROM invites WHERE invitedById = ? AND date(date) = date('now')", [userId]))[0].c);
  const week    = Number((await query("SELECT COUNT(*) AS c FROM invites WHERE invitedById = ? AND date >= datetime('now','-7 days')", [userId]))[0].c);
  const month   = Number((await query("SELECT COUNT(*) AS c FROM invites WHERE invitedById = ? AND strftime('%Y-%m',date) = strftime('%Y-%m','now')", [userId]))[0].c);
  const history = await query("SELECT username, date FROM invites WHERE invitedById = ? ORDER BY date DESC LIMIT 10", [userId]);
  const myRank  = Number((await query("SELECT COUNT(*) + 1 AS rank FROM users WHERE totalInvites > (SELECT totalInvites FROM users WHERE userId = ?)", [userId]))[0].rank);
  res.json({ total, today, week, month, history, rank: myRank });
});

// ── Ranking ────────────────────────────────────────────────────────
app.get("/api/invites/ranking", requireTeam, async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const rows = await query(
    "SELECT userId, username, avatar, totalInvites FROM users WHERE totalInvites > 0 ORDER BY totalInvites DESC LIMIT ?",
    [limit]
  );
  res.json(rows.map(r => ({ ...r, totalInvites: Number(r.totalInvites) })));
});

app.get("/api/invites/ranking/monthly", requireTeam, async (req, res) => {
  const rows = await query(`
    SELECT invitedById AS userId, invitedBy AS username, COUNT(*) AS totalInvites
    FROM invites WHERE invitedById IS NOT NULL
      AND strftime('%Y-%m',date) = strftime('%Y-%m','now')
    GROUP BY invitedById ORDER BY totalInvites DESC LIMIT 20
  `);
  res.json(rows.map(r => ({ ...r, totalInvites: Number(r.totalInvites) })));
});

// ── Stats dashboard ──────────────────────────────────────────────
app.get("/api/stats", requireTeam, async (req, res) => {
  const totalInvites   = Number((await query("SELECT COUNT(*) AS c FROM invites WHERE invitedById IS NOT NULL"))[0].c);
  const monthlyInvites = Number((await query("SELECT COUNT(*) AS c FROM invites WHERE invitedById IS NOT NULL AND strftime('%Y-%m',date)=strftime('%Y-%m','now')"))[0].c);
  const lastMembers    = await query("SELECT userId, username, invitedBy, date FROM invites ORDER BY date DESC LIMIT 5");
  res.json({ totalInvites, monthlyInvites, lastMembers });
});

// ── Bot registra novo membro ───────────────────────────────────────
app.post("/api/invites", async (req, res) => {
  const { userId, username, invitedBy, invitedById, avatar } = req.body;
  if (!userId || !username) return res.status(400).json({ error: "Dados insuficientes." });

  const existing = await query("SELECT userId FROM users WHERE userId = ?", [userId]);
  if (existing.length) {
    await run("UPDATE users SET username = ? WHERE userId = ?", [username, userId]);
  } else {
    await run("INSERT INTO users (userId, username, avatar) VALUES (?, ?, ?)", [userId, username, avatar || null]);
  }

  await run("INSERT INTO invites (userId, username, invitedById, invitedBy) VALUES (?, ?, ?, ?)",
    [userId, username, invitedById || null, invitedBy || null]);

  if (invitedById) {
    const inv = await query("SELECT userId FROM users WHERE userId = ?", [invitedById]);
    if (inv.length) {
      await run("UPDATE users SET totalInvites = totalInvites + 1 WHERE userId = ?", [invitedById]);
    } else {
      await run("INSERT INTO users (userId, username, totalInvites) VALUES (?, ?, 1)", [invitedById, invitedBy || invitedById]);
    }
  }

  membersCache.lastFetch = 0;
  await logAction("NEW_MEMBER", { userId, username, invitedBy });
  res.json({ success: true });
});

// ── Histórico (admin e supervisor) ────────────────────────────────
app.get("/api/invites/history", requireHistoryAccess, async (req, res) => {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 30;
  const offset = (page - 1) * limit;
  const total  = Number((await query("SELECT COUNT(*) AS c FROM invites"))[0].c);
  const data   = await query("SELECT * FROM invites ORDER BY date DESC LIMIT ? OFFSET ?", [limit, offset]);
  res.json({ total, page, limit, data });
});

app.get("/api/user/:userId", requireHistoryAccess, async (req, res) => {
  const user = await query("SELECT * FROM users WHERE userId = ?", [req.params.userId]);
  if (!user.length) return res.status(404).json({ error: "Não encontrado." });
  const invitedPeople = await query("SELECT username, date FROM invites WHERE invitedById = ? ORDER BY date DESC", [req.params.userId]);
  const joinedViaRows = await query("SELECT invitedBy, date FROM invites WHERE userId = ? ORDER BY date ASC LIMIT 1", [req.params.userId]);
  const userRow = { ...user[0], totalInvites: Number(user[0].totalInvites) };
  res.json({ ...userRow, invitedPeople, joinedVia: joinedViaRows[0] || null });
});

app.get("/api/admin/logs", requireAdmin, async (req, res) => {
  res.json(await query("SELECT * FROM logs ORDER BY date DESC LIMIT 100"));
});

app.post("/api/admin/reset/:userId", requireAdmin, async (req, res) => {
  await run("UPDATE users SET totalInvites = 0 WHERE userId = ?", [req.params.userId]);
  await logAction("ADMIN_RESET", { userId: req.params.userId });
  res.json({ success: true });
});

app.post("/api/admin/set-invites", requireAdmin, async (req, res) => {
  const { userId, total } = req.body;
  await run("UPDATE users SET totalInvites = ? WHERE userId = ?", [total, userId]);
  await logAction("ADMIN_SET_INVITES", { userId, total });
  res.json({ success: true });
});

app.delete("/api/admin/member/:userId", requireAdmin, async (req, res) => {
  await run("DELETE FROM users WHERE userId = ?", [req.params.userId]);
  await run("DELETE FROM invites WHERE userId = ?", [req.params.userId]);
  await logAction("ADMIN_DELETE", { userId: req.params.userId });
  res.json({ success: true });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/public/index.html"));
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
    getMembers().catch(e => console.error("[Cache warmup]", e.message));
  });
}).catch(err => {
  console.error("❌ Erro ao iniciar banco de dados:", err.response?.data || err.message);
  process.exit(1);
});

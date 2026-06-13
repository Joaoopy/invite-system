require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const axios = require("axios");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

const BACKEND_URL  = process.env.BACKEND_URL  || "http://localhost:3000";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin123";
const LOG_CHANNEL  = process.env.LOG_CHANNEL_ID; // ID do canal de log (opcional)

// Cache de convites por guild: Map<guildId, Map<inviteCode, uses>>
const inviteCache = new Map();

// ─── Funções Auxiliares ───────────────────────────────────────────────────────

async function fetchAndCacheInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(
      guild.id,
      new Map(invites.map((inv) => [inv.code, inv.uses]))
    );
  } catch (err) {
    console.error(`[Cache] Erro ao buscar convites da guild ${guild.id}:`, err.message);
  }
}

async function sendToBackend(payload) {
  try {
    const res = await axios.post(`${BACKEND_URL}/api/invites`, payload, {
      headers: { "x-admin-secret": ADMIN_SECRET },
    });
    return res.data;
  } catch (err) {
    console.error("[Backend] Erro ao enviar dados:", err.message);
    return null;
  }
}

async function logToChannel(guild, embed) {
  if (!LOG_CHANNEL) return;
  try {
    const channel = guild.channels.cache.get(LOG_CHANNEL);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (_) {}
}

// ─── Eventos ──────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);

  // Fazer cache inicial de todos os guilds
  for (const guild of client.guilds.cache.values()) {
    await fetchAndCacheInvites(guild);
    console.log(`📋 Cache carregado para: ${guild.name}`);
  }
});

// Atualizar cache ao criar novo convite
client.on("inviteCreate", async (invite) => {
  const cache = inviteCache.get(invite.guild.id);
  if (cache) cache.set(invite.code, invite.uses);
});

// Atualizar cache ao deletar convite
client.on("inviteDelete", async (invite) => {
  const cache = inviteCache.get(invite.guild.id);
  if (cache) cache.delete(invite.code);
});

// Detectar novo membro
client.on("guildMemberAdd", async (member) => {
  const { guild, user } = member;

  console.log(`\n👤 Novo membro: ${user.tag} (${user.id}) entrou em ${guild.name}`);

  // Buscar convites atuais
  let currentInvites;
  try {
    currentInvites = await guild.invites.fetch();
  } catch (err) {
    console.error("[Bot] Não consegui buscar convites:", err.message);
    return;
  }

  const cachedInvites = inviteCache.get(guild.id) || new Map();
  let usedInvite = null;

  // Comparar cache antigo com atual para encontrar convite usado
  for (const [code, invite] of currentInvites) {
    const cachedUses = cachedInvites.get(code) || 0;
    if (invite.uses > cachedUses) {
      usedInvite = invite;
      break;
    }
  }

  // Atualizar cache
  inviteCache.set(
    guild.id,
    new Map(currentInvites.map((inv) => [inv.code, inv.uses]))
  );

  // Montar payload
  const payload = {
    userId:      user.id,
    username:    user.tag,
    avatar:      user.displayAvatarURL({ size: 128 }),
    invitedBy:   usedInvite?.inviter?.tag   || null,
    invitedById: usedInvite?.inviter?.id    || null,
  };

  console.log("[Bot] Convidado por:", payload.invitedBy || "Desconhecido");

  // Enviar para backend
  const result = await sendToBackend(payload);

  if (result?.success) {
    console.log("[Backend] ✅ Registrado com sucesso.");

    // Embed de log
    const embed = new EmbedBuilder()
      .setTitle("🪖 Novo Recruta Registrado")
      .setColor(0x3b82f6)
      .setThumbnail(payload.avatar)
      .addFields(
        { name: "Membro",    value: `<@${user.id}> (${user.tag})`,                         inline: true },
        { name: "Convidado por", value: payload.invitedBy
            ? `<@${payload.invitedById}> (${payload.invitedBy})`
            : "Desconhecido / Link direto",                                                 inline: true },
        { name: "Convite",   value: usedInvite ? `\`${usedInvite.code}\`` : "Não rastreado", inline: true }
      )
      .setTimestamp();

    await logToChannel(guild, embed);
  }
});

// Detectar saída de membro (apenas loga, não remove do ranking)
client.on("guildMemberRemove", async (member) => {
  console.log(`[Bot] ${member.user.tag} saiu do servidor.`);
});

// ─── Comandos de Slash (Básico) ───────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ranking") {
    try {
      const res = await axios.get(`${BACKEND_URL}/api/invites/ranking?limit=10`);
      const ranking = res.data;

      if (!ranking.length) {
        return interaction.reply({ content: "Nenhum dado de ranking ainda.", ephemeral: true });
      }

      const medals = ["🥇", "🥈", "🥉"];
      const lines = ranking.map((u, i) => {
        const medal = medals[i] || `**#${i + 1}**`;
        return `${medal} **${u.username}** — ${u.totalInvites} convite${u.totalInvites !== 1 ? "s" : ""}`;
      });

      const embed = new EmbedBuilder()
        .setTitle("🏆 Ranking de Convites")
        .setColor(0xf59e0b)
        .setDescription(lines.join("\n"))
        .setTimestamp()
        .setFooter({ text: "Use /meurank para ver sua posição" });

      await interaction.reply({ embeds: [embed] });
    } catch {
      await interaction.reply({ content: "Erro ao buscar ranking.", ephemeral: true });
    }
  }

  if (interaction.commandName === "meurank") {
    try {
      const res = await axios.get(`${BACKEND_URL}/api/user/${interaction.user.id}`);
      const u = res.data;

      const embed = new EmbedBuilder()
        .setTitle(`📋 Perfil de ${u.username}`)
        .setColor(0x10b981)
        .addFields(
          { name: "Total de Convites", value: `${u.totalInvites}`,                             inline: true },
          { name: "Entrou em",         value: new Date(u.joinedAt).toLocaleDateString("pt-BR"), inline: true }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch {
      await interaction.reply({ content: "Você ainda não está registrado.", ephemeral: true });
    }
  }
});

client.login(process.env.BOT_TOKEN);

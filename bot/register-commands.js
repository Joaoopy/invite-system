// Rode UMA vez para registrar os slash commands no Discord
// node register-commands.js

require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("ranking")
    .setDescription("Mostra o top 10 recrutadores do servidor"),
  new SlashCommandBuilder()
    .setName("meurank")
    .setDescription("Mostra seu perfil e total de convites"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    console.log("Registrando slash commands...");
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registrados com sucesso!");
  } catch (err) {
    console.error("Erro:", err);
  }
})();

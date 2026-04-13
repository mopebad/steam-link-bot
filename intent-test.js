require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, () => {
  console.log("READY:", client.user.tag);
});

client.on("error", console.error);
client.on("warn", console.warn);

client.login(process.env.DISCORD_TOKEN).catch(console.error);
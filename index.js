require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
} = require('discord.js');
const Database = require('better-sqlite3');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

const db = new Database('links.db');

db.prepare(`
  CREATE TABLE IF NOT EXISTS steam_links (
    discord_id TEXT PRIMARY KEY,
    steam_id TEXT NOT NULL UNIQUE,
    steam_name TEXT NOT NULL,
    linked_at TEXT NOT NULL
  )
`).run();

const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Steam account')
    .addStringOption(option =>
      option
        .setName('input')
        .setDescription('Steam profile link, custom URL, or SteamID64')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unlinksteam')
    .setDescription('Unlink your Steam account'),

  new SlashCommandBuilder()
    .setName('verifiedlist')
    .setDescription('Admin: list all verified users'),

  new SlashCommandBuilder()
    .setName('adminsetsteam')
    .setDescription('Admin: manually set a user Steam link')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The Discord user to update')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('input')
        .setDescription('Steam profile link, custom URL, or SteamID64')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('adminunlinksteam')
    .setDescription('Admin: manually unlink a user Steam account')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The Discord user to unlink')
        .setRequired(true)
    ),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands.map(cmd => cmd.toJSON()) }
  );

  console.log('Commands registered');
}

function isAdmin(member) {
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (!adminRoleId) return false;
  return member.roles.cache.has(adminRoleId);
}

function extractSteamInput(input) {
  const trimmed = input.trim();

  if (/^\d{17}$/.test(trimmed)) {
    return { type: 'id', value: trimmed };
  }

  let match = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (match) {
    return { type: 'id', value: match[1] };
  }

  match = trimmed.match(/steamcommunity\.com\/id\/([^\/?#]+)/i);
  if (match) {
    return { type: 'vanity', value: match[1] };
  }

  return null;
}

async function resolveVanity(vanity) {
  const res = await fetch(
    `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${process.env.STEAM_API_KEY}&vanityurl=${encodeURIComponent(vanity)}`
  );
  const data = await res.json();

  if (!data.response || data.response.success !== 1 || !data.response.steamid) {
    throw new Error('Could not resolve Steam vanity URL.');
  }

  return data.response.steamid;
}

async function getProfile(steamId) {
  const res = await fetch(
    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${process.env.STEAM_API_KEY}&steamids=${steamId}`
  );
  const data = await res.json();

  if (!data.response || !data.response.players || !data.response.players.length) {
    throw new Error('Steam profile not found.');
  }

  return data.response.players[0];
}

async function resolveSteamProfile(input) {
  const parsed = extractSteamInput(input);

  if (!parsed) {
    throw new Error('Invalid Steam input. Use a SteamID64 or a valid Steam profile URL.');
  }

  let steamId = parsed.value;

  if (parsed.type === 'vanity') {
    steamId = await resolveVanity(parsed.value);
  }

  return await getProfile(steamId);
}

function buildNickname(discordName, steamName) {
  const sep = ' | ';
  const max = 32;
  const full = `${discordName}${sep}${steamName}`;

  if (full.length <= max) return full;

  const allowedSteam = max - discordName.length - sep.length;
  if (allowedSteam > 0) {
    return `${discordName}${sep}${steamName.slice(0, allowedSteam)}`;
  }

  return steamName.slice(0, max);
}

function cleanBaseName(name) {
  return name.split(' | ')[0].trim();
}

function saveLink(discordId, steamId, steamName) {
  db.prepare(`
    INSERT INTO steam_links (discord_id, steam_id, steam_name, linked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      steam_id = excluded.steam_id,
      steam_name = excluded.steam_name,
      linked_at = excluded.linked_at
  `).run(discordId, steamId, steamName, new Date().toISOString());
}

function removeLink(discordId) {
  return db.prepare(`DELETE FROM steam_links WHERE discord_id = ?`).run(discordId);
}

function getLinkByDiscordId(discordId) {
  return db.prepare(`SELECT * FROM steam_links WHERE discord_id = ?`).get(discordId);
}

function getLinkBySteamId(steamId) {
  return db.prepare(`SELECT * FROM steam_links WHERE steam_id = ?`).get(steamId);
}

function getAllLinks() {
  return db.prepare(`
    SELECT discord_id, steam_id, steam_name, linked_at
    FROM steam_links
    ORDER BY linked_at DESC
  `).all();
}

async function applyRoleAndNickname(guild, userId, steamName) {
  const member = await guild.members.fetch(userId);
  const role = await guild.roles.fetch(process.env.VERIFIED_ROLE_ID);

  if (!role) {
    throw new Error('Verified role not found.');
  }

  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(role);
  }

  const baseName = member.displayName || member.user.username;
  const cleanedBase = cleanBaseName(baseName);
  const newNickname = buildNickname(cleanedBase, steamName);

  let nicknameUpdated = true;
  let nicknameError = null;

  try {
    await member.setNickname(newNickname);
  } catch (err) {
    nicknameUpdated = false;
    nicknameError = err;
    console.error('Nickname update failed:', err);
  }

  return {
    roleName: role.name,
    nicknameUpdated,
    nickname: newNickname,
    nicknameError,
  };
}

async function removeRoleAndResetNickname(guild, userId) {
  const member = await guild.members.fetch(userId);
  const role = await guild.roles.fetch(process.env.VERIFIED_ROLE_ID);

  if (role && member.roles.cache.has(role.id)) {
    await member.roles.remove(role);
  }

  let nicknameCleared = true;

  try {
    await member.setNickname(null);
  } catch (err) {
    nicknameCleared = false;
    console.error('Nickname clear failed:', err);
  }

  return {
    roleName: role ? role.name : 'Unknown role',
    nicknameCleared,
  };
}

client.once(Events.ClientReady, () => {
  console.log('Bot ready');
});

/**
 * Auto-delete normal messages in the verify channel after 3 seconds.
 * Slash commands are interactions, not regular messages, so /link and /unlinksteam
 * will still work. Ephemeral bot replies also do not appear as normal channel messages.
 */
client.on(Events.MessageCreate, async message => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;
    if (message.channelId !== process.env.VERIFY_CHANNEL_ID) return;

    setTimeout(async () => {
      try {
        if (message.deletable) {
          await message.delete();
        }
      } catch (err) {
        console.error('Failed to auto-delete message:', err);
      }
    }, 3000);
  } catch (err) {
    console.error('MessageCreate handler error:', err);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  if (!guild) return;

  try {
    const member = await guild.members.fetch(interaction.user.id);

    if (interaction.commandName === 'link') {
      if (interaction.channelId !== process.env.VERIFY_CHANNEL_ID) {
        await interaction.reply({
          content: `Use /link in <#${process.env.VERIFY_CHANNEL_ID}>.`,
          flags: 64,
        });
        return;
      }

      await interaction.deferReply({ flags: 64 });

      const input = interaction.options.getString('input', true);
      const profile = await resolveSteamProfile(input);

      const existingSteamLink = getLinkBySteamId(profile.steamid);
      if (existingSteamLink && existingSteamLink.discord_id !== interaction.user.id) {
        await interaction.editReply('That Steam account is already linked to another Discord account.');
        return;
      }

      saveLink(interaction.user.id, profile.steamid, profile.personaname);

      const result = await applyRoleAndNickname(guild, interaction.user.id, profile.personaname);

      if (result.nicknameUpdated) {
        await interaction.editReply(
          `Steam linked successfully.\nRole added: **${result.roleName}**\nNickname updated to: **${result.nickname}**`
        );
      } else {
        await interaction.editReply(
          `Steam linked successfully.\nRole added: **${result.roleName}**\nI could not change your nickname. Check role hierarchy and nickname permissions.`
        );
      }

      return;
    }

    if (interaction.commandName === 'unlinksteam') {
      await interaction.deferReply({ flags: 64 });

      const existing = getLinkByDiscordId(interaction.user.id);
      if (!existing) {
        await interaction.editReply('You do not have a linked Steam account.');
        return;
      }

      removeLink(interaction.user.id);
      const result = await removeRoleAndResetNickname(guild, interaction.user.id);

      if (result.nicknameCleared) {
        await interaction.editReply(
          `Your Steam account was unlinked.\nRole removed: **${result.roleName}**`
        );
      } else {
        await interaction.editReply(
          `Your Steam account was unlinked and the role was removed, but I could not reset your nickname.`
        );
      }

      return;
    }

    if (
      ['verifiedlist', 'adminsetsteam', 'adminunlinksteam'].includes(interaction.commandName)
    ) {
      if (!isAdmin(member)) {
        await interaction.reply({
          content: 'You do not have permission to use this command.',
          flags: 64,
        });
        return;
      }
    }

    if (interaction.commandName === 'verifiedlist') {
      await interaction.deferReply({ flags: 64 });

      const rows = getAllLinks();

      if (!rows.length) {
        await interaction.editReply('No users are currently verified.');
        return;
      }

      const lines = rows.map((row, index) => {
        return `${index + 1}. <@${row.discord_id}> → ${row.steam_name} (${row.steam_id})`;
      });

      const chunks = [];
      let current = '';

      for (const line of lines) {
        if ((current + '\n' + line).length > 1900) {
          chunks.push(current);
          current = line;
        } else {
          current += (current ? '\n' : '') + line;
        }
      }

      if (current) chunks.push(current);

      await interaction.editReply(chunks[0]);

      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({
          content: chunks[i],
          flags: 64,
        });
      }

      return;
    }

    if (interaction.commandName === 'adminsetsteam') {
      await interaction.deferReply({ flags: 64 });

      const targetUser = interaction.options.getUser('user', true);
      const input = interaction.options.getString('input', true);
      const profile = await resolveSteamProfile(input);

      const existingSteamLink = getLinkBySteamId(profile.steamid);
      if (existingSteamLink && existingSteamLink.discord_id !== targetUser.id) {
        await interaction.editReply('That Steam account is already linked to another Discord account.');
        return;
      }

      saveLink(targetUser.id, profile.steamid, profile.personaname);

      const result = await applyRoleAndNickname(guild, targetUser.id, profile.personaname);

      if (result.nicknameUpdated) {
        await interaction.editReply(
          `Updated <@${targetUser.id}>.\nRole added: **${result.roleName}**\nNickname updated to: **${result.nickname}**`
        );
      } else {
        await interaction.editReply(
          `Updated <@${targetUser.id}> and added the role, but I could not change their nickname.`
        );
      }

      return;
    }

    if (interaction.commandName === 'adminunlinksteam') {
      await interaction.deferReply({ flags: 64 });

      const targetUser = interaction.options.getUser('user', true);
      const existing = getLinkByDiscordId(targetUser.id);

      if (!existing) {
        await interaction.editReply('That user does not have a linked Steam account.');
        return;
      }

      removeLink(targetUser.id);
      const result = await removeRoleAndResetNickname(guild, targetUser.id);

      if (result.nicknameCleared) {
        await interaction.editReply(
          `Removed the linked Steam account for <@${targetUser.id}>.\nRole removed: **${result.roleName}**`
        );
      } else {
        await interaction.editReply(
          `Removed the linked Steam account for <@${targetUser.id}> and removed the role, but I could not reset their nickname.`
        );
      }

      return;
    }
  } catch (error) {
    console.error(error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Something went wrong while processing that command.');
      } else {
        await interaction.reply({
          content: 'Something went wrong while processing that command.',
          flags: 64,
        });
      }
    } catch (replyError) {
      console.error('Failed to send error reply:', replyError);
    }
  }
});

(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
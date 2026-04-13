require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
  PermissionsBitField,
} = require('discord.js');
const Database = require('better-sqlite3');

const REQUIRED_ENV_VARS = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'STEAM_API_KEY',
  'VERIFIED_ROLE_ID',
  'VERIFY_CHANNEL_ID',
];

const OPTIONAL_ENV_VARS = [
  'ADMIN_ROLE_ID',
  'LOG_CHANNEL_ID',
  'SYNC_INTERVAL_MINUTES',
  'COMMAND_COOLDOWN_SECONDS',
  'STEAM_API_TIMEOUT_MS',
];

function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter(key => !process.env[key]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  for (const key of OPTIONAL_ENV_VARS) {
    if (!(key in process.env)) continue;
    if (
      ['SYNC_INTERVAL_MINUTES', 'COMMAND_COOLDOWN_SECONDS', 'STEAM_API_TIMEOUT_MS'].includes(key) &&
      Number.isNaN(Number(process.env[key]))
    ) {
      throw new Error(`${key} must be a number.`);
    }
  }
}

validateEnv();

const CONFIG = {
  GUILD_ID: process.env.GUILD_ID,
  VERIFIED_ROLE_ID: process.env.VERIFIED_ROLE_ID,
  VERIFY_CHANNEL_ID: process.env.VERIFY_CHANNEL_ID,
  ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || null,
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || null,
  SYNC_INTERVAL_MINUTES: Number(process.env.SYNC_INTERVAL_MINUTES || 60),
  COMMAND_COOLDOWN_SECONDS: Number(process.env.COMMAND_COOLDOWN_SECONDS || 5),
  STEAM_API_TIMEOUT_MS: Number(process.env.STEAM_API_TIMEOUT_MS || 10000),
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

const db = new Database('/data/links.db');

db.prepare(`
  CREATE TABLE IF NOT EXISTS steam_links (
    discord_id TEXT PRIMARY KEY,
    steam_id TEXT NOT NULL UNIQUE,
    steam_name TEXT NOT NULL,
    linked_at TEXT NOT NULL
  )
`).run();

function ensureColumn(tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some(col => col.name === columnName);

  if (!exists) {
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`).run();
    console.log(`Added missing column: ${tableName}.${columnName}`);
  }
}

ensureColumn('steam_links', 'original_nickname', 'TEXT');
ensureColumn('steam_links', 'last_refresh_at', 'TEXT');

const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Steam account')
    .addStringOption(option =>
      option
        .setName('input')
        .setDescription('Steam profile link, custom URL, vanity name, or SteamID64')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unlinksteam')
    .setDescription('Unlink your Steam account'),

  new SlashCommandBuilder()
    .setName('mylink')
    .setDescription('Show your linked Steam account'),

  new SlashCommandBuilder()
    .setName('refreshsteam')
    .setDescription('Refresh your Steam name and nickname from Steam'),

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
        .setDescription('Steam profile link, vanity name, or SteamID64')
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

  new SlashCommandBuilder()
    .setName('forcesyncsteam')
    .setDescription('Admin: force a full Steam name sync for all linked users'),
];

const cooldowns = new Map();
let isSyncRunning = false;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function escapeMarkdownLite(text) {
  return String(text).replace(/[*_`~|>]/g, '\\$&');
}

function getProfileUrl(steamId) {
  return `https://steamcommunity.com/profiles/${steamId}`;
}

function isOnCooldown(userId, commandName) {
  const seconds = CONFIG.COMMAND_COOLDOWN_SECONDS;
  if (seconds <= 0) return false;

  const key = `${userId}:${commandName}`;
  const now = Date.now();
  const expires = cooldowns.get(key);

  if (expires && expires > now) {
    return Math.ceil((expires - now) / 1000);
  }

  cooldowns.set(key, now + seconds * 1000);
  return false;
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands.map(cmd => cmd.toJSON()) }
  );

  console.log('Commands registered');
}

function isAdmin(member) {
  if (!member) return false;

  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) {
    return true;
  }

  if (CONFIG.ADMIN_ROLE_ID && member.roles.cache.has(CONFIG.ADMIN_ROLE_ID)) {
    return true;
  }

  return false;
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

  if (/^[a-zA-Z0-9_-]{2,64}$/.test(trimmed)) {
    return { type: 'vanity', value: trimmed };
  }

  return null;
}

async function steamFetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.STEAM_API_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`Steam API HTTP ${res.status}`);
    }

    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Steam API request timed out.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveVanity(vanity) {
  const data = await steamFetchJson(
    `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${process.env.STEAM_API_KEY}&vanityurl=${encodeURIComponent(vanity)}`
  );

  if (!data.response || data.response.success !== 1 || !data.response.steamid) {
    throw new Error('Could not resolve that Steam vanity URL.');
  }

  return data.response.steamid;
}

async function getProfile(steamId) {
  const data = await steamFetchJson(
    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${process.env.STEAM_API_KEY}&steamids=${steamId}`
  );

  if (!data.response || !data.response.players || !data.response.players.length) {
    throw new Error('Steam profile not found.');
  }

  return data.response.players[0];
}

async function resolveSteamProfile(input) {
  const parsed = extractSteamInput(input);

  if (!parsed) {
    throw new Error(
      'Invalid Steam input. Use a SteamID64, vanity name, or a valid Steam profile URL.'
    );
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
  const base = String(discordName || '').trim() || 'User';
  const steam = String(steamName || '').trim() || 'Steam';
  const full = `${base}${sep}${steam}`;

  if (full.length <= max) return full;

  const allowedSteam = max - base.length - sep.length;
  if (allowedSteam > 0) {
    return `${base}${sep}${steam.slice(0, allowedSteam)}`;
  }

  return steam.slice(0, max);
}

function cleanBaseName(name) {
  return String(name || '').split(' | ')[0].trim();
}

function saveLink(discordId, steamId, steamName, originalNickname = null) {
  const existing = getLinkByDiscordId(discordId);
  const resolvedOriginalNickname =
    existing?.original_nickname ??
    originalNickname ??
    null;

  db.prepare(`
    INSERT INTO steam_links (
      discord_id,
      steam_id,
      steam_name,
      linked_at,
      original_nickname,
      last_refresh_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      steam_id = excluded.steam_id,
      steam_name = excluded.steam_name,
      linked_at = excluded.linked_at,
      original_nickname = excluded.original_nickname,
      last_refresh_at = excluded.last_refresh_at
  `).run(
    discordId,
    steamId,
    steamName,
    nowIso(),
    resolvedOriginalNickname,
    nowIso()
  );
}

function touchLastRefresh(discordId) {
  db.prepare(`
    UPDATE steam_links
    SET last_refresh_at = ?
    WHERE discord_id = ?
  `).run(nowIso(), discordId);
}

function removeLink(discordId) {
  return db.prepare(`DELETE FROM steam_links WHERE discord_id = ?`).run(discordId);
}

function getLinkByDiscordId(discordId) {
  return db.prepare(`
    SELECT discord_id, steam_id, steam_name, linked_at, original_nickname, last_refresh_at
    FROM steam_links
    WHERE discord_id = ?
  `).get(discordId);
}

function getLinkBySteamId(steamId) {
  return db.prepare(`
    SELECT discord_id, steam_id, steam_name, linked_at, original_nickname, last_refresh_at
    FROM steam_links
    WHERE steam_id = ?
  `).get(steamId);
}

function getAllLinks() {
  return db.prepare(`
    SELECT discord_id, steam_id, steam_name, linked_at, original_nickname, last_refresh_at
    FROM steam_links
    ORDER BY linked_at DESC
  `).all();
}

async function logToChannel(message) {
  if (!CONFIG.LOG_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(CONFIG.LOG_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;
    await channel.send(message);
  } catch (err) {
    console.error('Failed to write to log channel:', err);
  }
}

async function applyRoleAndNickname(guild, userId, steamName, preferredBaseName = null) {
  const member = await guild.members.fetch(userId);
  const role = await guild.roles.fetch(CONFIG.VERIFIED_ROLE_ID);

  if (!role) {
    throw new Error('Verified role not found.');
  }

  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(role);
  }

  const baseName =
    cleanBaseName(preferredBaseName) ||
    cleanBaseName(member.displayName || member.user.username);

  const newNickname = buildNickname(baseName, steamName);

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

async function removeRoleAndRestoreNickname(guild, userId, originalNickname = null) {
  const member = await guild.members.fetch(userId);
  const role = await guild.roles.fetch(CONFIG.VERIFIED_ROLE_ID);

  if (role && member.roles.cache.has(role.id)) {
    await member.roles.remove(role);
  }

  let nicknameRestored = true;

  try {
    const restored = originalNickname && originalNickname.trim() ? originalNickname : null;
    await member.setNickname(restored);
  } catch (err) {
    nicknameRestored = false;
    console.error('Nickname restore failed:', err);
  }

  return {
    roleName: role ? role.name : 'Unknown role',
    nicknameRestored,
  };
}

async function syncSteamNames({ triggeredBy = 'system', interaction = null } = {}) {
  if (isSyncRunning) {
    if (interaction) {
      await interaction.editReply('A sync is already running.');
    }
    return;
  }

  isSyncRunning = true;

  const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (!guild) {
    isSyncRunning = false;
    throw new Error('Guild not found in client cache.');
  }

  const links = getAllLinks();
  let checked = 0;
  let updated = 0;
  let failed = 0;
  let missingMembers = 0;

  for (const link of links) {
    checked += 1;

    try {
      const profile = await getProfile(link.steam_id);
      const liveSteamName = profile.personaname;

      let member = null;
      try {
        member = await guild.members.fetch(link.discord_id);
      } catch {
        missingMembers += 1;
        await logToChannel(
          `⚠️ Sync skipped <@${link.discord_id}> because they are not currently in the server.`
        );
        await delay(1100);
        continue;
      }

      const result = await applyRoleAndNickname(
        guild,
        link.discord_id,
        liveSteamName,
        link.original_nickname || member.user.username
      );

      if (liveSteamName !== link.steam_name) {
        saveLink(link.discord_id, link.steam_id, liveSteamName, link.original_nickname);
        updated += 1;

        await logToChannel(
          `🔄 Steam name updated for <@${link.discord_id}>: ` +
          `**${escapeMarkdownLite(link.steam_name)}** → **${escapeMarkdownLite(liveSteamName)}**`
        );
      } else {
        touchLastRefresh(link.discord_id);
      }

      if (!result.nicknameUpdated) {
        await logToChannel(
          `⚠️ Synced Steam data for <@${link.discord_id}>, but nickname update failed. Check role hierarchy/permissions.`
        );
      }
    } catch (err) {
      failed += 1;
      console.error(`Failed syncing ${link.discord_id}:`, err);

      await logToChannel(
        `❌ Failed syncing <@${link.discord_id}> (${link.steam_id}): ${escapeMarkdownLite(err.message)}`
      );
    }

    await delay(1100);
  }

  const summary =
    `Steam sync finished. Checked: ${checked}, updated: ${updated}, failed: ${failed}, missing members: ${missingMembers}.`;

  console.log(summary);
  await logToChannel(`✅ ${summary} Triggered by: ${triggeredBy}.`);

  if (interaction) {
    await interaction.editReply(summary);
  }

  isSyncRunning = false;
}

async function restoreMemberIfLinked(member) {
  if (!member.guild || member.guild.id !== CONFIG.GUILD_ID) return;

  const existing = getLinkByDiscordId(member.id);
  if (!existing) return;

  try {
    const result = await applyRoleAndNickname(
      member.guild,
      member.id,
      existing.steam_name,
      existing.original_nickname || member.user.username
    );

    if (!result.nicknameUpdated) {
      await logToChannel(
        `⚠️ Restored verified role for <@${member.id}> after rejoin, but nickname update failed.`
      );
    } else {
      await logToChannel(
        `↩️ Restored verified role and nickname for <@${member.id}> after rejoin.`
      );
    }
  } catch (err) {
    console.error('Failed restoring member after rejoin:', err);
    await logToChannel(
      `❌ Failed restoring linked member <@${member.id}> after rejoin: ${escapeMarkdownLite(err.message)}`
    );
  }
}

function formatLinkInfo(userId, row) {
  return [
    `**Linked Steam account for <@${userId}>**`,
    `Steam Name: **${escapeMarkdownLite(row.steam_name)}**`,
    `Steam ID: \`${row.steam_id}\``,
    `Linked At: \`${row.linked_at}\``,
    `Last Refresh: \`${row.last_refresh_at || 'Never'}\``,
    `Profile: ${getProfileUrl(row.steam_id)}`,
  ].join('\n');
}

client.once(Events.ClientReady, async () => {
  console.log(`Bot ready as ${client.user.tag}`);

  await logToChannel('🟢 Bot is online.');

  try {
    await syncSteamNames({ triggeredBy: 'startup' });
  } catch (err) {
    console.error('Startup sync failed:', err);
    await logToChannel(`❌ Startup sync failed: ${escapeMarkdownLite(err.message)}`);
  }

  setInterval(() => {
    syncSteamNames({ triggeredBy: 'interval' }).catch(async err => {
      console.error('Scheduled sync failed:', err);
      await logToChannel(`❌ Scheduled sync failed: ${escapeMarkdownLite(err.message)}`);
    });
  }, CONFIG.SYNC_INTERVAL_MINUTES * 60 * 1000);
});

client.on(Events.GuildMemberAdd, async member => {
  await restoreMemberIfLinked(member);
});

/**
 * Auto-delete normal messages in the verify channel after 3 seconds.
 * Slash commands are interactions, not normal messages, so /link and other
 * slash commands still work. Ephemeral replies are also unaffected.
 */
client.on(Events.MessageCreate, async message => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;
    if (message.guild.id !== CONFIG.GUILD_ID) return;
    if (message.channelId !== CONFIG.VERIFY_CHANNEL_ID) return;

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
  if (!interaction.guild || interaction.guild.id !== CONFIG.GUILD_ID) return;

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);

    const cooldownRemaining = isOnCooldown(interaction.user.id, interaction.commandName);
    if (
      cooldownRemaining &&
      !['verifiedlist', 'adminsetsteam', 'adminunlinksteam', 'forcesyncsteam'].includes(interaction.commandName)
    ) {
      await interaction.reply({
        content: `Please wait ${cooldownRemaining}s before using \`/${interaction.commandName}\` again.`,
        flags: 64,
      });
      return;
    }

    if (
      ['verifiedlist', 'adminsetsteam', 'adminunlinksteam', 'forcesyncsteam'].includes(interaction.commandName)
    ) {
      if (!isAdmin(member)) {
        await interaction.reply({
          content: 'You do not have permission to use this command.',
          flags: 64,
        });
        return;
      }
    }

    if (interaction.commandName === 'link') {
      if (interaction.channelId !== CONFIG.VERIFY_CHANNEL_ID) {
        await interaction.reply({
          content: `Use /link in <#${CONFIG.VERIFY_CHANNEL_ID}>.`,
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
        await logToChannel(
          `⚠️ Duplicate Steam link attempt: <@${interaction.user.id}> tried linking Steam ID \`${profile.steamid}\`, already linked to <@${existingSteamLink.discord_id}>.`
        );
        return;
      }

      const existingUserLink = getLinkByDiscordId(interaction.user.id);
      const originalNickname =
        existingUserLink?.original_nickname ??
        cleanBaseName(member.displayName || member.user.username);

      saveLink(interaction.user.id, profile.steamid, profile.personaname, originalNickname);

      const result = await applyRoleAndNickname(
        interaction.guild,
        interaction.user.id,
        profile.personaname,
        originalNickname
      );

      if (result.nicknameUpdated) {
        await interaction.editReply(
          [
            `Steam linked successfully.`,
            `Role added: **${escapeMarkdownLite(result.roleName)}**`,
            `Nickname updated to: **${escapeMarkdownLite(result.nickname)}**`,
            `Profile: ${getProfileUrl(profile.steamid)}`,
          ].join('\n')
        );
      } else {
        await interaction.editReply(
          [
            `Steam linked successfully.`,
            `Role added: **${escapeMarkdownLite(result.roleName)}**`,
            `I could not change your nickname. Check role hierarchy and nickname permissions.`,
            `Profile: ${getProfileUrl(profile.steamid)}`,
          ].join('\n')
        );
      }

      await logToChannel(
        `✅ <@${interaction.user.id}> linked Steam **${escapeMarkdownLite(profile.personaname)}** (\`${profile.steamid}\`).`
      );
      return;
    }

    if (interaction.commandName === 'unlinksteam') {
      await interaction.deferReply({ flags: 64 });

      const existing = getLinkByDiscordId(interaction.user.id);
      if (!existing) {
        await interaction.editReply('You do not have a linked Steam account.');
        return;
      }

      const result = await removeRoleAndRestoreNickname(
        interaction.guild,
        interaction.user.id,
        existing.original_nickname
      );

      removeLink(interaction.user.id);

      if (result.nicknameRestored) {
        await interaction.editReply(
          `Your Steam account was unlinked.\nRole removed: **${escapeMarkdownLite(result.roleName)}**`
        );
      } else {
        await interaction.editReply(
          `Your Steam account was unlinked and the role was removed, but I could not restore your nickname.`
        );
      }

      await logToChannel(
        `🗑️ <@${interaction.user.id}> unlinked Steam **${escapeMarkdownLite(existing.steam_name)}** (\`${existing.steam_id}\`).`
      );
      return;
    }

    if (interaction.commandName === 'mylink') {
      await interaction.deferReply({ flags: 64 });

      const existing = getLinkByDiscordId(interaction.user.id);
      if (!existing) {
        await interaction.editReply('You do not have a linked Steam account.');
        return;
      }

      await interaction.editReply(formatLinkInfo(interaction.user.id, existing));
      return;
    }

    if (interaction.commandName === 'refreshsteam') {
      await interaction.deferReply({ flags: 64 });

      const existing = getLinkByDiscordId(interaction.user.id);
      if (!existing) {
        await interaction.editReply('You do not have a linked Steam account.');
        return;
      }

      const profile = await getProfile(existing.steam_id);
      saveLink(
        interaction.user.id,
        existing.steam_id,
        profile.personaname,
        existing.original_nickname
      );

      const result = await applyRoleAndNickname(
        interaction.guild,
        interaction.user.id,
        profile.personaname,
        existing.original_nickname || member.user.username
      );

      if (result.nicknameUpdated) {
        await interaction.editReply(
          [
            `Steam data refreshed successfully.`,
            `Current Steam name: **${escapeMarkdownLite(profile.personaname)}**`,
            `Nickname updated to: **${escapeMarkdownLite(result.nickname)}**`,
            `Profile: ${getProfileUrl(existing.steam_id)}`,
          ].join('\n')
        );
      } else {
        await interaction.editReply(
          [
            `Steam data refreshed successfully.`,
            `Current Steam name: **${escapeMarkdownLite(profile.personaname)}**`,
            `I could not change your nickname. Check role hierarchy and nickname permissions.`,
            `Profile: ${getProfileUrl(existing.steam_id)}`,
          ].join('\n')
        );
      }

      await logToChannel(
        `🔄 <@${interaction.user.id}> manually refreshed Steam data. New name: **${escapeMarkdownLite(profile.personaname)}**`
      );
      return;
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

      await interaction.editReply(
        `**Verified Users (${rows.length})**\n${chunks[0]}`
      );

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

      let targetMember = null;
      let originalNickname = null;

      try {
        targetMember = await interaction.guild.members.fetch(targetUser.id);
        const existingTargetLink = getLinkByDiscordId(targetUser.id);
        originalNickname =
          existingTargetLink?.original_nickname ??
          cleanBaseName(targetMember.displayName || targetMember.user.username);
      } catch {
        const existingTargetLink = getLinkByDiscordId(targetUser.id);
        originalNickname = existingTargetLink?.original_nickname ?? targetUser.username;
      }

      saveLink(targetUser.id, profile.steamid, profile.personaname, originalNickname);

      const result = await applyRoleAndNickname(
        interaction.guild,
        targetUser.id,
        profile.personaname,
        originalNickname
      );

      if (result.nicknameUpdated) {
        await interaction.editReply(
          [
            `Updated <@${targetUser.id}>.`,
            `Role added: **${escapeMarkdownLite(result.roleName)}**`,
            `Nickname updated to: **${escapeMarkdownLite(result.nickname)}**`,
            `Profile: ${getProfileUrl(profile.steamid)}`,
          ].join('\n')
        );
      } else {
        await interaction.editReply(
          `Updated <@${targetUser.id}> and added the role, but I could not change their nickname.`
        );
      }

      await logToChannel(
        `🛠️ ${interaction.user.tag} used /adminsetsteam on <@${targetUser.id}> → **${escapeMarkdownLite(profile.personaname)}** (\`${profile.steamid}\`).`
      );
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

      const result = await removeRoleAndRestoreNickname(
        interaction.guild,
        targetUser.id,
        existing.original_nickname
      );

      removeLink(targetUser.id);

      if (result.nicknameRestored) {
        await interaction.editReply(
          `Removed the linked Steam account for <@${targetUser.id}>.\nRole removed: **${escapeMarkdownLite(result.roleName)}**`
        );
      } else {
        await interaction.editReply(
          `Removed the linked Steam account for <@${targetUser.id}> and removed the role, but I could not restore their nickname.`
        );
      }

      await logToChannel(
        `🛠️ ${interaction.user.tag} used /adminunlinksteam on <@${targetUser.id}>. Removed Steam **${escapeMarkdownLite(existing.steam_name)}** (\`${existing.steam_id}\`).`
      );
      return;
    }

    if (interaction.commandName === 'forcesyncsteam') {
      await interaction.deferReply({ flags: 64 });
      await syncSteamNames({
        triggeredBy: `admin:${interaction.user.tag}`,
        interaction,
      });
      return;
    }
  } catch (error) {
    console.error(error);

    try {
      await logToChannel(`❌ Command error: ${escapeMarkdownLite(error.message)}`);

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
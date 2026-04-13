const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  AttachmentBuilder,
} = require('discord.js');

const { CONFIG } = require('./config');
const {
  db,
  audit,
  pruneAuditLogs,
  saveLink,
  touchLastRefresh,
  removeLink,
  getLinkByDiscordId,
  getLinkBySteamId,
  getAllLinks,
  setOriginalNickname,
  clearOriginalNickname,
  setLinkNote,
  getRecentAuditLogs,
} = require('./db');
const {
  delay,
  escapeMarkdownLite,
  getProfileUrl,
  isAdmin,
  isOnCooldown,
  buildNickname,
  cleanBaseName,
  parseBulkImportLines,
  chunkLines,
} = require('./utils');
const { getProfile, resolveSteamProfile } = require('./steam');
const { commands, adminCommands } = require('./commands');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

let isSyncRunning = false;
let intervalHandle = null;

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID), {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    console.log('Commands registered');
  } catch (err) {
    console.error('Command registration failed (non-fatal):', err);
    audit('command_register_failed', { details: String(err.message || err) });
  }
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
  if (!role) throw new Error('Verified role not found.');

  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(role);
  }

  const baseName = cleanBaseName(preferredBaseName) || cleanBaseName(member.displayName || member.user.username);
  const newNickname = buildNickname(baseName, steamName);

  let nicknameUpdated = true;
  let nicknameError = null;
  try {
    if (member.displayName !== newNickname) {
      await member.setNickname(newNickname);
    }
  } catch (err) {
    nicknameUpdated = false;
    nicknameError = err;
    console.error('Nickname update failed:', err);
  }

  return { roleName: role.name, nicknameUpdated, nickname: newNickname, nicknameError };
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

  return { roleName: role ? role.name : 'Unknown role', nicknameRestored };
}

function formatLinkInfo(userId, row) {
  return [
    `**Linked Steam account for <@${userId}>**`,
    `Steam Name: **${escapeMarkdownLite(row.steam_name)}**`,
    `Steam ID: \`${row.steam_id}\``,
    `Linked At: \`${row.linked_at}\``,
    `Last Refresh: \`${row.last_refresh_at || 'Never'}\``,
    `Note: ${row.note ? escapeMarkdownLite(row.note) : 'None'}`,
    `Profile: ${getProfileUrl(row.steam_id)}`,
  ].join('\n');
}

async function syncSteamNames({ triggeredBy = 'system', interaction = null } = {}) {
  if (isSyncRunning) {
    if (interaction) await interaction.editReply('A sync is already running.');
    return;
  }

  isSyncRunning = true;
  try {
    const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
    if (!guild) throw new Error('Guild not found in client cache.');

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
          await logToChannel(`⚠️ Sync skipped <@${link.discord_id}> because they are not currently in the server.`);
          await delay(1100);
          continue;
        }

        const result = await applyRoleAndNickname(guild, link.discord_id, liveSteamName, link.original_nickname || member.user.username);

        if (liveSteamName !== link.steam_name) {
          saveLink(link.discord_id, link.steam_id, liveSteamName, link.original_nickname, link.note);
          updated += 1;
          audit('steam_name_updated', {
            targetDiscordId: link.discord_id,
            targetSteamId: link.steam_id,
            details: `${link.steam_name} -> ${liveSteamName}`,
          });
          await logToChannel(`🔄 Steam name updated for <@${link.discord_id}>: **${escapeMarkdownLite(link.steam_name)}** → **${escapeMarkdownLite(liveSteamName)}**`);
        } else {
          touchLastRefresh(link.discord_id);
        }

        if (!result.nicknameUpdated) {
          await logToChannel(`⚠️ Synced Steam data for <@${link.discord_id}>, but nickname update failed. Check role hierarchy/permissions.`);
        }
      } catch (err) {
        failed += 1;
        console.error(`Failed syncing ${link.discord_id}:`, err);
        await logToChannel(`❌ Failed syncing <@${link.discord_id}> (${link.steam_id}): ${escapeMarkdownLite(err.message)}`);
      }
      await delay(1100);
    }

    const summary = `Steam sync finished. Checked: ${checked}, updated: ${updated}, failed: ${failed}, missing members: ${missingMembers}.`;
    console.log(summary);
    audit('full_sync_finished', { details: `${summary} Triggered by: ${triggeredBy}` });
    await logToChannel(`✅ ${summary} Triggered by: ${triggeredBy}.`);
    if (interaction) await interaction.editReply(summary);
  } finally {
    isSyncRunning = false;
  }
}

async function restoreMemberIfLinked(member) {
  if (!member.guild || member.guild.id !== CONFIG.GUILD_ID) return;
  const existing = getLinkByDiscordId(member.id);
  if (!existing) return;

  try {
    const result = await applyRoleAndNickname(member.guild, member.id, existing.steam_name, existing.original_nickname || member.user.username);
    if (!result.nicknameUpdated) {
      await logToChannel(`⚠️ Restored verified role for <@${member.id}> after rejoin, but nickname update failed.`);
    } else {
      await logToChannel(`↩️ Restored verified role and nickname for <@${member.id}> after rejoin.`);
    }
  } catch (err) {
    console.error('Failed restoring member after rejoin:', err);
    await logToChannel(`❌ Failed restoring linked member <@${member.id}> after rejoin: ${escapeMarkdownLite(err.message)}`);
  }
}

async function syncSingleUser(interaction, targetUser, actorTag) {
  const existing = getLinkByDiscordId(targetUser.id);
  if (!existing) {
    await interaction.editReply('That user does not have a linked Steam account.');
    return;
  }

  const profile = await getProfile(existing.steam_id);
  saveLink(targetUser.id, existing.steam_id, profile.personaname, existing.original_nickname, existing.note);
  const result = await applyRoleAndNickname(interaction.guild, targetUser.id, profile.personaname, existing.original_nickname || targetUser.username);
  audit('sync_single_user', {
    targetDiscordId: targetUser.id,
    targetSteamId: existing.steam_id,
    actorDiscordId: interaction.user.id,
    details: `Triggered by ${actorTag}`,
  });

  await interaction.editReply([
    `Synced <@${targetUser.id}> successfully.`,
    `Steam name: **${escapeMarkdownLite(profile.personaname)}**`,
    `Nickname updated: **${result.nicknameUpdated ? 'Yes' : 'No'}**`,
    `Profile: ${getProfileUrl(existing.steam_id)}`,
  ].join('\n'));
}

client.once(Events.ClientReady, async () => {
  console.log(`Bot ready as ${client.user.tag}`);
  await logToChannel('🟢 Bot is online.');
  pruneAuditLogs(CONFIG.AUDIT_LOG_RETENTION_DAYS);
  await registerCommands();

  try {
    await syncSteamNames({ triggeredBy: 'startup' });
  } catch (err) {
    console.error('Startup sync failed:', err);
    await logToChannel(`❌ Startup sync failed: ${escapeMarkdownLite(err.message)}`);
  }

  intervalHandle = setInterval(() => {
    syncSteamNames({ triggeredBy: 'interval' }).catch(async (err) => {
      console.error('Scheduled sync failed:', err);
      await logToChannel(`❌ Scheduled sync failed: ${escapeMarkdownLite(err.message)}`);
    });
  }, CONFIG.SYNC_INTERVAL_MINUTES * 60 * 1000);
});

client.on(Events.GuildMemberAdd, async (member) => {
  await restoreMemberIfLinked(member);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;
    if (message.guild.id !== CONFIG.GUILD_ID) return;
    if (message.channelId !== CONFIG.VERIFY_CHANNEL_ID) return;

    setTimeout(async () => {
      try {
        if (message.deletable) await message.delete();
      } catch (err) {
        console.error('Failed to auto-delete message:', err);
      }
    }, CONFIG.VERIFY_CHANNEL_AUTODELETE_SECONDS * 1000);
  } catch (err) {
    console.error('MessageCreate handler error:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild || interaction.guild.id !== CONFIG.GUILD_ID) return;

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);

    const cooldownRemaining = isOnCooldown(interaction.user.id, interaction.commandName);
    if (cooldownRemaining && !adminCommands.has(interaction.commandName)) {
      await interaction.reply({ content: `Please wait ${cooldownRemaining}s before using \`/${interaction.commandName}\` again.`, flags: 64 });
      return;
    }

    if (adminCommands.has(interaction.commandName) && !isAdmin(member)) {
      await interaction.reply({ content: 'You do not have permission to use this command.', flags: 64 });
      return;
    }

    if (interaction.commandName === 'verifyhelp') {
      await interaction.reply({
        content: [`Use /link in <#${CONFIG.VERIFY_CHANNEL_ID}>.`, 'Accepted inputs: Steam profile URL, custom URL/vanity, or SteamID64.'].join('\n'),
        flags: 64,
      });
      return;
    }

    if (interaction.commandName === 'bulkimport') {
      await interaction.deferReply({ flags: 64 });
      const rawData = interaction.options.getString('data', true);
      const entries = parseBulkImportLines(rawData).slice(0, CONFIG.MAX_BULKIMPORT_LINES);

      if (!entries.length) {
        await interaction.editReply('No valid lines were provided.\nUse one line per user:\n`DISCORD_USER_ID STEAM_ID64`\nor\n`@mention STEAM_ID64`');
        return;
      }

      let successCount = 0;
      let failCount = 0;
      const results = [];

      for (const entry of entries) {
        try {
          if (!entry.userId) {
            failCount += 1;
            results.push(`Line ${entry.lineNumber}: Invalid Discord mention or user ID.`);
            continue;
          }
          if (!entry.steamInput) {
            failCount += 1;
            results.push(`Line ${entry.lineNumber}: Missing Steam input.`);
            continue;
          }

          const targetUser = await client.users.fetch(entry.userId).catch(() => null);
          if (!targetUser) {
            failCount += 1;
            results.push(`Line ${entry.lineNumber}: Could not find Discord user \`${entry.userId}\`.`);
            continue;
          }

          const profile = await resolveSteamProfile(entry.steamInput);
          const existingSteamLink = getLinkBySteamId(profile.steamid);
          if (existingSteamLink && existingSteamLink.discord_id !== targetUser.id) {
            failCount += 1;
            results.push(`Line ${entry.lineNumber}: Steam ID \`${profile.steamid}\` is already linked to another Discord account.`);
            continue;
          }

          let originalNickname = targetUser.username;
          try {
            const targetMember = await interaction.guild.members.fetch(targetUser.id);
            const existingTargetLink = getLinkByDiscordId(targetUser.id);
            originalNickname = existingTargetLink?.original_nickname ?? cleanBaseName(targetMember.displayName || targetMember.user.username);
          } catch {
            const existingTargetLink = getLinkByDiscordId(targetUser.id);
            originalNickname = existingTargetLink?.original_nickname ?? targetUser.username;
          }

          saveLink(targetUser.id, profile.steamid, profile.personaname, originalNickname);
          const result = await applyRoleAndNickname(interaction.guild, targetUser.id, profile.personaname, originalNickname);
          successCount += 1;
          audit('bulkimport_link', {
            targetDiscordId: targetUser.id,
            targetSteamId: profile.steamid,
            actorDiscordId: interaction.user.id,
            details: entry.raw,
          });
          results.push(result.nicknameUpdated
            ? `Line ${entry.lineNumber}: Imported <@${targetUser.id}> → ${profile.personaname} (${profile.steamid})`
            : `Line ${entry.lineNumber}: Imported <@${targetUser.id}> → ${profile.personaname} (${profile.steamid}), but nickname update failed.`);
        } catch (err) {
          failCount += 1;
          results.push(`Line ${entry.lineNumber}: ${err.message}`);
        }
      }

      const summaryHeader = [`Bulk import complete.`, `Success: **${successCount}**`, `Failed: **${failCount}**`].join('\n');
      const chunks = chunkLines(results);
      await interaction.editReply(summaryHeader + (chunks[0] ? `\n\n${chunks[0]}` : ''));
      for (let i = 1; i < chunks.length; i += 1) {
        await interaction.followUp({ content: chunks[i], flags: 64 });
      }
      return;
    }

    if (interaction.commandName === 'link') {
      if (interaction.channelId !== CONFIG.VERIFY_CHANNEL_ID) {
        await interaction.reply({ content: `Use /link in <#${CONFIG.VERIFY_CHANNEL_ID}>.`, flags: 64 });
        return;
      }
      await interaction.deferReply({ flags: 64 });
      const input = interaction.options.getString('input', true);
      const profile = await resolveSteamProfile(input);
      const existingSteamLink = getLinkBySteamId(profile.steamid);
      if (existingSteamLink && existingSteamLink.discord_id !== interaction.user.id) {
        await interaction.editReply('That Steam account is already linked to another Discord account.');
        await logToChannel(`⚠️ Duplicate Steam link attempt: <@${interaction.user.id}> tried linking Steam ID \`${profile.steamid}\`, already linked to <@${existingSteamLink.discord_id}>.`);
        return;
      }

      const existingUserLink = getLinkByDiscordId(interaction.user.id);
      const originalNickname = existingUserLink?.original_nickname ?? cleanBaseName(member.displayName || member.user.username);
      saveLink(interaction.user.id, profile.steamid, profile.personaname, originalNickname);
      const result = await applyRoleAndNickname(interaction.guild, interaction.user.id, profile.personaname, originalNickname);
      audit('user_linked', {
        targetDiscordId: interaction.user.id,
        targetSteamId: profile.steamid,
        actorDiscordId: interaction.user.id,
      });

      await interaction.editReply(result.nicknameUpdated
        ? [`Steam linked successfully.`, `Role added: **${escapeMarkdownLite(result.roleName)}**`, `Nickname updated to: **${escapeMarkdownLite(result.nickname)}**`, `Profile: ${getProfileUrl(profile.steamid)}`].join('\n')
        : [`Steam linked successfully.`, `Role added: **${escapeMarkdownLite(result.roleName)}**`, `I could not change your nickname. Check role hierarchy and nickname permissions.`, `Profile: ${getProfileUrl(profile.steamid)}`].join('\n'));
      await logToChannel(`✅ <@${interaction.user.id}> linked Steam **${escapeMarkdownLite(profile.personaname)}** (\`${profile.steamid}\`).`);
      return;
    }

    if (interaction.commandName === 'unlinksteam') {
      await interaction.deferReply({ flags: 64 });
      const existing = getLinkByDiscordId(interaction.user.id);
      if (!existing) {
        await interaction.editReply('You do not have a linked Steam account.');
        return;
      }
      const result = await removeRoleAndRestoreNickname(interaction.guild, interaction.user.id, existing.original_nickname);
      removeLink(interaction.user.id);
      audit('user_unlinked', {
        targetDiscordId: interaction.user.id,
        targetSteamId: existing.steam_id,
        actorDiscordId: interaction.user.id,
      });
      await interaction.editReply(result.nicknameRestored
        ? `Your Steam account was unlinked.\nRole removed: **${escapeMarkdownLite(result.roleName)}**`
        : 'Your Steam account was unlinked and the role was removed, but I could not restore your nickname.');
      await logToChannel(`🗑️ <@${interaction.user.id}> unlinked Steam **${escapeMarkdownLite(existing.steam_name)}** (\`${existing.steam_id}\`).`);
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
      saveLink(interaction.user.id, existing.steam_id, profile.personaname, existing.original_nickname, existing.note);
      const result = await applyRoleAndNickname(interaction.guild, interaction.user.id, profile.personaname, existing.original_nickname || member.user.username);
      audit('user_refreshed', {
        targetDiscordId: interaction.user.id,
        targetSteamId: existing.steam_id,
        actorDiscordId: interaction.user.id,
      });
      await interaction.editReply(result.nicknameUpdated
        ? [`Steam data refreshed successfully.`, `Current Steam name: **${escapeMarkdownLite(profile.personaname)}**`, `Nickname updated to: **${escapeMarkdownLite(result.nickname)}**`, `Profile: ${getProfileUrl(existing.steam_id)}`].join('\n')
        : [`Steam data refreshed successfully.`, `Current Steam name: **${escapeMarkdownLite(profile.personaname)}**`, `I could not change your nickname. Check role hierarchy and nickname permissions.`, `Profile: ${getProfileUrl(existing.steam_id)}`].join('\n'));
      await logToChannel(`🔄 <@${interaction.user.id}> manually refreshed Steam data. New name: **${escapeMarkdownLite(profile.personaname)}**`);
      return;
    }

    if (interaction.commandName === 'verifiedlist') {
      await interaction.deferReply({ flags: 64 });
      const rows = getAllLinks();
      if (!rows.length) {
        await interaction.editReply('No users are currently verified.');
        return;
      }
      const lines = rows.map((row, index) => `${index + 1}. <@${row.discord_id}> → ${row.steam_name} (${row.steam_id})`);
      const chunks = chunkLines(lines);
      await interaction.editReply(`**Verified Users (${rows.length})**\n${chunks[0]}`);
      for (let i = 1; i < chunks.length; i += 1) {
        await interaction.followUp({ content: chunks[i], flags: 64 });
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
      let originalNickname = null;
      try {
        const targetMember = await interaction.guild.members.fetch(targetUser.id);
        const existingTargetLink = getLinkByDiscordId(targetUser.id);
        originalNickname = existingTargetLink?.original_nickname ?? cleanBaseName(targetMember.displayName || targetMember.user.username);
      } catch {
        const existingTargetLink = getLinkByDiscordId(targetUser.id);
        originalNickname = existingTargetLink?.original_nickname ?? targetUser.username;
      }

      saveLink(targetUser.id, profile.steamid, profile.personaname, originalNickname);
      const result = await applyRoleAndNickname(interaction.guild, targetUser.id, profile.personaname, originalNickname);
      audit('admin_set_steam', {
        targetDiscordId: targetUser.id,
        targetSteamId: profile.steamid,
        actorDiscordId: interaction.user.id,
      });
      await interaction.editReply(result.nicknameUpdated
        ? [`Updated <@${targetUser.id}>.`, `Role added: **${escapeMarkdownLite(result.roleName)}**`, `Nickname updated to: **${escapeMarkdownLite(result.nickname)}**`, `Profile: ${getProfileUrl(profile.steamid)}`].join('\n')
        : `Updated <@${targetUser.id}> and added the role, but I could not change their nickname.`);
      await logToChannel(`🛠️ ${interaction.user.tag} used /adminsetsteam on <@${targetUser.id}> → **${escapeMarkdownLite(profile.personaname)}** (\`${profile.steamid}\`).`);
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
      const result = await removeRoleAndRestoreNickname(interaction.guild, targetUser.id, existing.original_nickname);
      removeLink(targetUser.id);
      audit('admin_unlink_steam', {
        targetDiscordId: targetUser.id,
        targetSteamId: existing.steam_id,
        actorDiscordId: interaction.user.id,
      });
      await interaction.editReply(result.nicknameRestored
        ? `Removed the linked Steam account for <@${targetUser.id}>.\nRole removed: **${escapeMarkdownLite(result.roleName)}**`
        : `Removed the linked Steam account for <@${targetUser.id}> and removed the role, but I could not restore their nickname.`);
      await logToChannel(`🛠️ ${interaction.user.tag} used /adminunlinksteam on <@${targetUser.id}>. Removed Steam **${escapeMarkdownLite(existing.steam_name)}** (\`${existing.steam_id}\`).`);
      return;
    }

    if (interaction.commandName === 'forcesyncsteam') {
      await interaction.deferReply({ flags: 64 });
      await syncSteamNames({ triggeredBy: `admin:${interaction.user.tag}`, interaction });
      return;
    }

    if (interaction.commandName === 'steamstats') {
      await interaction.deferReply({ flags: 64 });
      const rows = getAllLinks();
      const withNotes = rows.filter((r) => r.note).length;
      const refreshed = rows.filter((r) => r.last_refresh_at).length;
      await interaction.editReply([
        '**Steam Link Stats**',
        `Total linked: **${rows.length}**`,
        `With saved base nickname: **${rows.filter((r) => r.original_nickname).length}**`,
        `With notes: **${withNotes}**`,
        `Refreshed at least once: **${refreshed}**`,
        `Sync running: **${isSyncRunning ? 'Yes' : 'No'}**`,
      ].join('\n'));
      return;
    }

    if (interaction.commandName === 'findsteam') {
      await interaction.deferReply({ flags: 64 });
      const steamId = interaction.options.getString('steamid', true);
      const row = getLinkBySteamId(steamId);
      await interaction.editReply(row ? formatLinkInfo(row.discord_id, row) : 'No linked Discord account was found for that Steam ID.');
      return;
    }

    if (interaction.commandName === 'userlink') {
      await interaction.deferReply({ flags: 64 });
      const targetUser = interaction.options.getUser('user', true);
      const row = getLinkByDiscordId(targetUser.id);
      await interaction.editReply(row ? formatLinkInfo(targetUser.id, row) : 'That user does not have a linked Steam account.');
      return;
    }

    if (interaction.commandName === 'syncusersteam') {
      await interaction.deferReply({ flags: 64 });
      const targetUser = interaction.options.getUser('user', true);
      await syncSingleUser(interaction, targetUser, interaction.user.tag);
      return;
    }

    if (interaction.commandName === 'restoreverified') {
      await interaction.deferReply({ flags: 64 });
      const rows = getAllLinks();
      let restored = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          const memberTarget = await interaction.guild.members.fetch(row.discord_id).catch(() => null);
          if (!memberTarget) continue;
          await applyRoleAndNickname(interaction.guild, row.discord_id, row.steam_name, row.original_nickname || memberTarget.user.username);
          restored += 1;
        } catch {
          failed += 1;
        }
      }
      audit('restore_verified', { actorDiscordId: interaction.user.id, details: `restored=${restored} failed=${failed}` });
      await interaction.editReply(`Restore complete. Restored: **${restored}**, failed: **${failed}**.`);
      return;
    }

    if (interaction.commandName === 'orphanlinks') {
      await interaction.deferReply({ flags: 64 });
      const rows = getAllLinks();
      const orphanLines = [];
      for (const row of rows) {
        const memberTarget = await interaction.guild.members.fetch(row.discord_id).catch(() => null);
        if (!memberTarget) {
          orphanLines.push(`<@${row.discord_id}> → ${row.steam_name} (${row.steam_id})`);
        }
      }
      if (!orphanLines.length) {
        await interaction.editReply('No orphaned links found.');
        return;
      }
      const chunks = chunkLines(orphanLines);
      await interaction.editReply(`**Orphaned Links (${orphanLines.length})**\n${chunks[0]}`);
      for (let i = 1; i < chunks.length; i += 1) {
        await interaction.followUp({ content: chunks[i], flags: 64 });
      }
      return;
    }

    if (interaction.commandName === 'recentactions') {
      await interaction.deferReply({ flags: 64 });
      const logs = getRecentAuditLogs(10);
      if (!logs.length) {
        await interaction.editReply('No recent audit actions found.');
        return;
      }
      const lines = logs.map((log) => `#${log.id} [${log.created_at}] ${log.action} | actor=${log.actor_discord_id || 'system'} | target=${log.target_discord_id || 'n/a'} | steam=${log.target_steam_id || 'n/a'} | details=${log.details || 'n/a'}`);
      const chunks = chunkLines(lines);
      await interaction.editReply(`**Recent Actions**\n${chunks[0]}`);
      for (let i = 1; i < chunks.length; i += 1) {
        await interaction.followUp({ content: chunks[i], flags: 64 });
      }
      return;
    }

    if (interaction.commandName === 'exportlinks') {
      await interaction.deferReply({ flags: 64 });
      const rows = getAllLinks().slice(0, CONFIG.MAX_EXPORT_ROWS);
      const header = 'discord_id,steam_id,steam_name,linked_at,original_nickname,last_refresh_at,note';
      const csvLines = rows.map((r) => [r.discord_id, r.steam_id, r.steam_name, r.linked_at, r.original_nickname || '', r.last_refresh_at || '', (r.note || '').replace(/"/g, '""')].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
      const csv = [header, ...csvLines].join('\n');
      const outputPath = path.join('/tmp', `steam-links-export-${Date.now()}.csv`);
      fs.writeFileSync(outputPath, csv, 'utf8');
      const attachment = new AttachmentBuilder(outputPath, { name: 'steam-links-export.csv' });
      await interaction.editReply({ content: `Exported ${rows.length} linked users.`, files: [attachment] });
      return;
    }

    if (interaction.commandName === 'unlinkbysteam') {
      await interaction.deferReply({ flags: 64 });
      const steamId = interaction.options.getString('steamid', true);
      const row = getLinkBySteamId(steamId);
      if (!row) {
        await interaction.editReply('That Steam ID is not linked.');
        return;
      }
      const memberTarget = await interaction.guild.members.fetch(row.discord_id).catch(() => null);
      if (memberTarget) {
        await removeRoleAndRestoreNickname(interaction.guild, row.discord_id, row.original_nickname).catch(() => null);
      }
      removeLink(row.discord_id);
      audit('unlink_by_steam', {
        targetDiscordId: row.discord_id,
        targetSteamId: row.steam_id,
        actorDiscordId: interaction.user.id,
      });
      await interaction.editReply(`Removed link for <@${row.discord_id}> using Steam ID \`${row.steam_id}\`.`);
      return;
    }

    if (interaction.commandName === 'setbasenick') {
      await interaction.deferReply({ flags: 64 });
      const row = getLinkByDiscordId(interaction.user.id);
      if (!row) {
        await interaction.editReply('Link your Steam account first before setting a saved base nickname.');
        return;
      }
      const baseName = cleanBaseName(interaction.options.getString('name', true));
      setOriginalNickname(interaction.user.id, baseName);
      const result = await applyRoleAndNickname(interaction.guild, interaction.user.id, row.steam_name, baseName);
      audit('set_base_nick', { targetDiscordId: interaction.user.id, actorDiscordId: interaction.user.id, details: baseName });
      await interaction.editReply(`Saved base nickname as **${escapeMarkdownLite(baseName)}**.${result.nicknameUpdated ? `\nUpdated nickname to: **${escapeMarkdownLite(result.nickname)}**` : ''}`);
      return;
    }

    if (interaction.commandName === 'resetbasenick') {
      await interaction.deferReply({ flags: 64 });
      const row = getLinkByDiscordId(interaction.user.id);
      if (!row) {
        await interaction.editReply('You do not have a linked Steam account.');
        return;
      }
      clearOriginalNickname(interaction.user.id);
      const fallback = cleanBaseName(member.displayName || member.user.username);
      const result = await applyRoleAndNickname(interaction.guild, interaction.user.id, row.steam_name, fallback);
      audit('reset_base_nick', { targetDiscordId: interaction.user.id, actorDiscordId: interaction.user.id });
      await interaction.editReply(`Reset your saved base nickname.${result.nicknameUpdated ? `\nUpdated nickname to: **${escapeMarkdownLite(result.nickname)}**` : ''}`);
      return;
    }

    if (interaction.commandName === 'renickname') {
      await interaction.deferReply({ flags: 64 });
      const targetUser = interaction.options.getUser('user', true);
      const row = getLinkByDiscordId(targetUser.id);
      if (!row) {
        await interaction.editReply('That user does not have a linked Steam account.');
        return;
      }
      const result = await applyRoleAndNickname(interaction.guild, targetUser.id, row.steam_name, row.original_nickname || targetUser.username);
      audit('renickname', { targetDiscordId: targetUser.id, targetSteamId: row.steam_id, actorDiscordId: interaction.user.id });
      await interaction.editReply(result.nicknameUpdated
        ? `Re-applied nickname for <@${targetUser.id}>: **${escapeMarkdownLite(result.nickname)}**`
        : `Could not update nickname for <@${targetUser.id}>. Check role hierarchy and permissions.`);
      return;
    }

    if (interaction.commandName === 'setlinknote') {
      await interaction.deferReply({ flags: 64 });
      const targetUser = interaction.options.getUser('user', true);
      const row = getLinkByDiscordId(targetUser.id);
      if (!row) {
        await interaction.editReply('That user does not have a linked Steam account.');
        return;
      }
      const note = interaction.options.getString('note', true).trim();
      setLinkNote(targetUser.id, note);
      audit('set_link_note', { targetDiscordId: targetUser.id, targetSteamId: row.steam_id, actorDiscordId: interaction.user.id, details: note });
      await interaction.editReply(`Saved note for <@${targetUser.id}>: ${escapeMarkdownLite(note)}`);
      return;
    }
  } catch (error) {
    console.error(error);
    try {
      await logToChannel(`❌ Command error: ${escapeMarkdownLite(error.message)}`);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Something went wrong while processing that command.');
      } else {
        await interaction.reply({ content: 'Something went wrong while processing that command.', flags: 64 });
      }
    } catch (replyError) {
      console.error('Failed to send error reply:', replyError);
    }
  }
});

async function shutdown(signal) {
  try {
    console.log(`Received ${signal}, shutting down...`);
    if (intervalHandle) clearInterval(intervalHandle);
    await client.destroy();
    db.close();
    process.exit(0);
  } catch (err) {
    console.error('Shutdown error:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

(async () => {
  await client.login(CONFIG.DISCORD_TOKEN);
})();

const { PermissionsBitField } = require('discord.js');
const { CONFIG } = require('./config');

const cooldowns = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeMarkdownLite(text) {
  return String(text ?? '').replace(/[*_`~|>]/g, '\\$&');
}

function getProfileUrl(steamId) {
  return `https://steamcommunity.com/profiles/${steamId}`;
}

function isAdmin(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  if (CONFIG.ADMIN_ROLE_ID && member.roles.cache.has(CONFIG.ADMIN_ROLE_ID)) return true;
  return false;
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

function parseMentionToUserId(raw) {
  const trimmed = String(raw || '').trim();
  const match = trimmed.match(/^<@!?(\d+)>$/);
  return match ? match[1] : null;
}

function parseBulkImportLines(data) {
  const lines = String(data || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    const parts = line.split(/\s+/);
    const first = parts[0];
    const steamInput = parts.slice(1).join(' ').trim();
    let userId = parseMentionToUserId(first);
    if (!userId && /^\d{17,20}$/.test(first)) {
      userId = first;
    }
    return { lineNumber: index + 1, raw: line, userId, steamInput };
  });
}

function chunkLines(lines, maxLength = 1900) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  delay,
  escapeMarkdownLite,
  getProfileUrl,
  isAdmin,
  isOnCooldown,
  buildNickname,
  cleanBaseName,
  parseMentionToUserId,
  parseBulkImportLines,
  chunkLines,
};

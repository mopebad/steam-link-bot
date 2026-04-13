const Database = require('better-sqlite3');
const { CONFIG } = require('./config');

const db = new Database(CONFIG.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

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
  const exists = columns.some((col) => col.name === columnName);
  if (!exists) {
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`).run();
    console.log(`Added missing column: ${tableName}.${columnName}`);
  }
}

ensureColumn('steam_links', 'original_nickname', 'TEXT');
ensureColumn('steam_links', 'last_refresh_at', 'TEXT');
ensureColumn('steam_links', 'note', 'TEXT');

// audit table for admin actions / operational events

db.prepare(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target_discord_id TEXT,
    target_steam_id TEXT,
    actor_discord_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL
  )
`).run();

db.prepare('CREATE INDEX IF NOT EXISTS idx_steam_links_steam_id ON steam_links(steam_id)').run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)').run();

function nowIso() {
  return new Date().toISOString();
}

function audit(action, { targetDiscordId = null, targetSteamId = null, actorDiscordId = null, details = null } = {}) {
  db.prepare(`
    INSERT INTO audit_logs (action, target_discord_id, target_steam_id, actor_discord_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(action, targetDiscordId, targetSteamId, actorDiscordId, details, nowIso());
}

function pruneAuditLogs(days) {
  db.prepare(`DELETE FROM audit_logs WHERE created_at < datetime('now', ?)`).run(`-${days} days`);
}

function saveLink(discordId, steamId, steamName, originalNickname = null, note = undefined) {
  const existing = getLinkByDiscordId(discordId);
  const resolvedOriginalNickname = existing?.original_nickname ?? originalNickname ?? null;
  const resolvedNote = note === undefined ? existing?.note ?? null : note;

  db.prepare(`
    INSERT INTO steam_links (
      discord_id,
      steam_id,
      steam_name,
      linked_at,
      original_nickname,
      last_refresh_at,
      note
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      steam_id = excluded.steam_id,
      steam_name = excluded.steam_name,
      linked_at = excluded.linked_at,
      original_nickname = excluded.original_nickname,
      last_refresh_at = excluded.last_refresh_at,
      note = excluded.note
  `).run(discordId, steamId, steamName, nowIso(), resolvedOriginalNickname, nowIso(), resolvedNote);
}

function touchLastRefresh(discordId) {
  db.prepare('UPDATE steam_links SET last_refresh_at = ? WHERE discord_id = ?').run(nowIso(), discordId);
}

function removeLink(discordId) {
  return db.prepare('DELETE FROM steam_links WHERE discord_id = ?').run(discordId);
}

function getLinkByDiscordId(discordId) {
  return db.prepare(`
    SELECT discord_id, steam_id, steam_name, linked_at, original_nickname, last_refresh_at, note
    FROM steam_links
    WHERE discord_id = ?
  `).get(discordId);
}

function getLinkBySteamId(steamId) {
  return db.prepare(`
    SELECT discord_id, steam_id, steam_name, linked_at, original_nickname, last_refresh_at, note
    FROM steam_links
    WHERE steam_id = ?
  `).get(steamId);
}

function getAllLinks() {
  return db.prepare(`
    SELECT discord_id, steam_id, steam_name, linked_at, original_nickname, last_refresh_at, note
    FROM steam_links
    ORDER BY linked_at DESC
  `).all();
}

function setOriginalNickname(discordId, originalNickname) {
  db.prepare('UPDATE steam_links SET original_nickname = ? WHERE discord_id = ?').run(originalNickname, discordId);
}

function clearOriginalNickname(discordId) {
  db.prepare('UPDATE steam_links SET original_nickname = NULL WHERE discord_id = ?').run(discordId);
}

function setLinkNote(discordId, note) {
  db.prepare('UPDATE steam_links SET note = ? WHERE discord_id = ?').run(note, discordId);
}

function getRecentAuditLogs(limit = 10) {
  return db.prepare(`
    SELECT id, action, target_discord_id, target_steam_id, actor_discord_id, details, created_at
    FROM audit_logs
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

module.exports = {
  db,
  nowIso,
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
};

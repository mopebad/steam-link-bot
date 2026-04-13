require('dotenv').config();

const REQUIRED_ENV_VARS = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'STEAM_API_KEY',
  'VERIFIED_ROLE_ID',
  'VERIFY_CHANNEL_ID',
];

const OPTIONAL_NUMERIC_ENV_VARS = [
  'SYNC_INTERVAL_MINUTES',
  'COMMAND_COOLDOWN_SECONDS',
  'STEAM_API_TIMEOUT_MS',
  'VERIFY_CHANNEL_AUTODELETE_SECONDS',
  'STEAM_API_RETRY_COUNT',
  'MAX_BULKIMPORT_LINES',
  'AUDIT_LOG_RETENTION_DAYS',
  'MAX_EXPORT_ROWS',
];

function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  for (const key of OPTIONAL_NUMERIC_ENV_VARS) {
    if (!(key in process.env)) continue;
    if (Number.isNaN(Number(process.env[key]))) {
      throw new Error(`${key} must be a number.`);
    }
  }
}

validateEnv();

const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,
  STEAM_API_KEY: process.env.STEAM_API_KEY,
  VERIFIED_ROLE_ID: process.env.VERIFIED_ROLE_ID,
  VERIFY_CHANNEL_ID: process.env.VERIFY_CHANNEL_ID,
  ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || null,
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || null,
  SYNC_INTERVAL_MINUTES: Number(process.env.SYNC_INTERVAL_MINUTES || 60),
  COMMAND_COOLDOWN_SECONDS: Number(process.env.COMMAND_COOLDOWN_SECONDS || 5),
  STEAM_API_TIMEOUT_MS: Number(process.env.STEAM_API_TIMEOUT_MS || 10000),
  VERIFY_CHANNEL_AUTODELETE_SECONDS: Number(process.env.VERIFY_CHANNEL_AUTODELETE_SECONDS || 3),
  STEAM_API_RETRY_COUNT: Number(process.env.STEAM_API_RETRY_COUNT || 2),
  MAX_BULKIMPORT_LINES: Number(process.env.MAX_BULKIMPORT_LINES || 100),
  AUDIT_LOG_RETENTION_DAYS: Number(process.env.AUDIT_LOG_RETENTION_DAYS || 90),
  MAX_EXPORT_ROWS: Number(process.env.MAX_EXPORT_ROWS || 5000),
  DB_PATH: process.env.DB_PATH || '/data/links.db',
};

module.exports = { CONFIG };

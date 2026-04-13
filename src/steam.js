const { CONFIG } = require('./config');
const { delay } = require('./utils');

function extractSteamInput(input) {
  const trimmed = String(input || '').trim();
  if (/^\d{17}$/.test(trimmed)) return { type: 'id', value: trimmed };

  let match = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (match) return { type: 'id', value: match[1] };

  match = trimmed.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (match) return { type: 'vanity', value: match[1] };

  if (/^[a-zA-Z0-9_-]{2,64}$/.test(trimmed)) {
    return { type: 'vanity', value: trimmed };
  }

  return null;
}

async function steamFetchJson(url) {
  let lastError = null;
  for (let attempt = 0; attempt <= CONFIG.STEAM_API_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.STEAM_API_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < CONFIG.STEAM_API_RETRY_COUNT) {
          await delay(500 * (attempt + 1));
          continue;
        }
        throw new Error(`Steam API HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      const retriable = err.name === 'AbortError' || /ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(err.message));
      if (attempt < CONFIG.STEAM_API_RETRY_COUNT && retriable) {
        await delay(500 * (attempt + 1));
        continue;
      }
      if (err.name === 'AbortError') {
        throw new Error('Steam API request timed out.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Unknown Steam API error.');
}

async function resolveVanity(vanity) {
  const data = await steamFetchJson(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${CONFIG.STEAM_API_KEY}&vanityurl=${encodeURIComponent(vanity)}`);
  if (!data.response || data.response.success !== 1 || !data.response.steamid) {
    throw new Error('Could not resolve that Steam vanity URL.');
  }
  return data.response.steamid;
}

async function getProfile(steamId) {
  const data = await steamFetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${CONFIG.STEAM_API_KEY}&steamids=${steamId}`);
  if (!data.response || !Array.isArray(data.response.players) || !data.response.players.length) {
    throw new Error('Steam profile not found.');
  }
  return data.response.players[0];
}

async function resolveSteamProfile(input) {
  const parsed = extractSteamInput(input);
  if (!parsed) {
    throw new Error('Invalid Steam input. Use a SteamID64, vanity name, or a valid Steam profile URL.');
  }
  let steamId = parsed.value;
  if (parsed.type === 'vanity') {
    steamId = await resolveVanity(parsed.value);
  }
  return await getProfile(steamId);
}

module.exports = {
  extractSteamInput,
  steamFetchJson,
  resolveVanity,
  getProfile,
  resolveSteamProfile,
};

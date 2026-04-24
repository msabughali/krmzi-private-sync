const fs = require("fs/promises");
const path = require("path");

async function ensureStateFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify({ syncedEpisodeUrls: [] }, null, 2), "utf8");
  }
}

async function loadState(filePath) {
  await ensureStateFile(filePath);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.syncedEpisodeUrls)) {
    parsed.syncedEpisodeUrls = [];
  }
  return parsed;
}

async function saveState(filePath, state) {
  await ensureStateFile(filePath);
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

function isSynced(state, episodeUrl) {
  return state.syncedEpisodeUrls.includes(episodeUrl);
}

function markSynced(state, episodeUrl) {
  if (!state.syncedEpisodeUrls.includes(episodeUrl)) {
    state.syncedEpisodeUrls.push(episodeUrl);
  }
}

module.exports = { loadState, saveState, isSynced, markSynced };

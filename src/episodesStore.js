const fs = require("fs/promises");
const path = require("path");
const { sanitizeStoredEpisodeImageUrl } = require("./parser");

async function ensureEpisodesFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify({ episodes: [] }, null, 2), "utf8");
  }
}

async function loadEpisodes(filePath) {
  await ensureEpisodesFile(filePath);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.episodes)) parsed.episodes = [];
  for (const ep of parsed.episodes) {
    if (ep && typeof ep === "object") {
      ep.imageUrl = sanitizeStoredEpisodeImageUrl(ep.imageUrl);
      // Legacy aggregator wrapper URL is no longer used for anything.
      if ("wrapperUrl" in ep) delete ep.wrapperUrl;
    }
  }
  return parsed;
}

async function saveEpisodes(filePath, data) {
  await ensureEpisodesFile(filePath);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function upsertEpisodes(existing, incoming) {
  const map = new Map(existing.map((ep) => [ep.episodeUrl, ep]));
  for (const ep of incoming) {
    const prev = map.get(ep.episodeUrl) || {};
    const merged = { ...prev, ...ep, updatedAt: new Date().toISOString() };
    merged.imageUrl = sanitizeStoredEpisodeImageUrl(merged.imageUrl);
    if ("wrapperUrl" in merged) delete merged.wrapperUrl;
    map.set(ep.episodeUrl, merged);
  }
  return Array.from(map.values()).sort((a, b) => {
    const ta = Date.parse(a.discoveredAt || a.updatedAt || 0);
    const tb = Date.parse(b.discoveredAt || b.updatedAt || 0);
    return tb - ta;
  });
}

module.exports = { loadEpisodes, saveEpisodes, upsertEpisodes };

const fs = require("fs/promises");
const path = require("path");
const {
  extractSlugFromEpisodeUrl,
  parseSeriesName,
  sanitizeStoredEpisodeImageUrl
} = require("./parser");

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
      if (Array.isArray(ep.seriesEpisodes)) {
        ep.seriesEpisodes = ep.seriesEpisodes
          .filter((item) => item && typeof item === "object" && item.episodeUrl)
          .map((item) => ({
            ...item,
            seriesName: item.seriesName || null,
            playerServers: Array.isArray(item.playerServers) ? item.playerServers : [],
            imageUrl: sanitizeStoredEpisodeImageUrl(item.imageUrl)
          }));
      }
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

function episodeUrlKey(value) {
  try {
    const u = new URL(value);
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Keep parser-normalized path if decoding fails.
    }
    return `${u.origin.toLowerCase()}${pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return String(value || "");
  }
}

function seriesKey(ep) {
  return (
    parseSeriesName(ep?.seriesName || ep?.title || extractSlugFromEpisodeUrl(ep?.episodeUrl)) ||
    ep?.episodeUrl ||
    ""
  );
}

function mergeEpisodeDetail(prev = {}, incoming = {}) {
  const merged = { ...prev, ...incoming };
  for (const key of ["playerUrl", "playerId", "playerProvider", "imageUrl", "title", "slug", "seriesName"]) {
    if ((incoming[key] === null || incoming[key] === undefined || incoming[key] === "") && prev[key]) {
      merged[key] = prev[key];
    }
  }
  if (!Array.isArray(incoming.playerServers) || incoming.playerServers.length === 0) {
    merged.playerServers = Array.isArray(prev.playerServers) ? prev.playerServers : [];
  }
  merged.imageUrl = sanitizeStoredEpisodeImageUrl(merged.imageUrl);
  return merged;
}

function mergeSeriesEpisodeLists(prevList, incomingList) {
  const map = new Map();
  for (const item of Array.isArray(prevList) ? prevList : []) {
    if (item?.episodeUrl) map.set(episodeUrlKey(item.episodeUrl), item);
  }
  for (const item of Array.isArray(incomingList) ? incomingList : []) {
    if (!item?.episodeUrl) continue;
    const key = episodeUrlKey(item.episodeUrl);
    map.set(key, mergeEpisodeDetail(map.get(key) || {}, item));
  }
  return Array.from(map.values()).sort((a, b) => {
    const an = Number.isFinite(a.episodeNumber) ? a.episodeNumber : -1;
    const bn = Number.isFinite(b.episodeNumber) ? b.episodeNumber : -1;
    return bn - an;
  });
}

function upsertEpisodes(existing, incoming) {
  const map = new Map(existing.map((ep) => [seriesKey(ep), ep]));
  for (const ep of incoming) {
    const key = seriesKey(ep);
    const prev = map.get(key) || {};
    const merged = mergeEpisodeDetail(prev, ep);
    merged.seriesName = key || merged.seriesName || null;
    merged.title = merged.seriesName || merged.title || null;
    const prevSeriesEpisodes = Array.isArray(prev.seriesEpisodes) && prev.seriesEpisodes.length
      ? prev.seriesEpisodes
      : prev.episodeUrl
        ? [prev]
        : [];
    const incomingSeriesEpisodes = Array.isArray(ep.seriesEpisodes) && ep.seriesEpisodes.length
      ? ep.seriesEpisodes
      : [ep];
    merged.seriesEpisodes = mergeSeriesEpisodeLists(prevSeriesEpisodes, incomingSeriesEpisodes);
    merged.discoveredAt = prev.discoveredAt || ep.discoveredAt || new Date().toISOString();
    merged.updatedAt = new Date().toISOString();
    merged.imageUrl = sanitizeStoredEpisodeImageUrl(merged.imageUrl);
    if ("wrapperUrl" in merged) delete merged.wrapperUrl;
    map.set(key, merged);
  }
  return Array.from(map.values()).sort((a, b) => {
    const ta = Date.parse(a.discoveredAt || a.updatedAt || 0);
    const tb = Date.parse(b.discoveredAt || b.updatedAt || 0);
    return tb - ta;
  });
}

module.exports = { loadEpisodes, saveEpisodes, upsertEpisodes };

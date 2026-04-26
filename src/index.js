const fs = require("fs/promises");
const path = require("path");
const config = require("./config");
const logger = require("./logger");
const { runCrawl, runSeriesDiscovery, runSeriesEpisodeRefresh } = require("./crawler");
const { syncEpisodes } = require("./syncClient");
const { loadState, saveState, isSynced, markSynced } = require("./stateStore");
const { loadEpisodes, saveEpisodes, upsertEpisodes } = require("./episodesStore");
const {
  extractSlugFromEpisodeUrl,
  canonicalizePlayerUrl,
  sanitizeStoredEpisodeImageUrl,
  parseSeriesName
} = require("./parser");

function pickUnsynced(crawled, state) {
  return crawled.filter((ep) => !isSynced(state, ep.episodeUrl));
}

function hasUsableServer(ep) {
  if (!Array.isArray(ep?.playerServers)) return false;
  return ep.playerServers.some((s) => {
    const id = s && typeof s.id === "string" ? s.id.trim() : "";
    return id.length > 0;
  });
}

function canonicalStoredPlayerUrl(item) {
  const playerUrl = item?.playerUrl || item?.videoUrl || null;
  return playerUrl ? canonicalizePlayerUrl(playerUrl) : null;
}

function normalizeStoredSeriesEpisodes(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === "object" && item.episodeUrl)
    .map((item) => ({
      title: item.title || extractSlugFromEpisodeUrl(item.episodeUrl)?.replace(/-/g, " ") || null,
      seriesName: item.seriesName || null,
      episodeUrl: item.episodeUrl,
      slug: item.slug || extractSlugFromEpisodeUrl(item.episodeUrl),
      episodeNumber: item.episodeNumber ?? null,
      playerUrl: canonicalStoredPlayerUrl(item),
      playerId: item.playerId || item.videoId || null,
      playerProvider: item.playerProvider || null,
      playerServers: Array.isArray(item.playerServers) ? item.playerServers : [],
      imageUrl: sanitizeStoredEpisodeImageUrl(item.imageUrl)
    }));
}

function mapEpisodeForStorage(ep, options = {}) {
  const includeSeriesEpisodes = options.includeSeriesEpisodes !== false;
  const stored = {
    // Use the series name for grouped top-level entries; fall back to decoded Arabic slug.
    title: ep.seriesName || ep.title || extractSlugFromEpisodeUrl(ep.episodeUrl)?.replace(/-/g, " ") || null,
    seriesName: ep.seriesName || null,
    episodeUrl: ep.episodeUrl,
    slug: extractSlugFromEpisodeUrl(ep.episodeUrl),
    episodeNumber: ep.episodeNumber ?? null,
    // playerUrl may be null when only a decoded server list is available;
    // the web UI resolves playback via playerServers in that case.
    playerUrl: ep.videoUrl ? canonicalizePlayerUrl(ep.videoUrl) : null,
    playerId: ep.videoId || null,
    playerProvider: ep.playerProvider || null,
    playerServers: Array.isArray(ep.playerServers) ? ep.playerServers : [],
    imageUrl: sanitizeStoredEpisodeImageUrl(ep.imageUrl),
    discoveredAt: new Date().toISOString()
  };

  const seriesEpisodes = includeSeriesEpisodes
    ? normalizeStoredSeriesEpisodes(ep.seriesEpisodes)
    : [];
  if (seriesEpisodes.length > 0) {
    stored.seriesEpisodes = seriesEpisodes;
  }

  return stored;
}

function transformForStore(episodes) {
  return episodes.map((ep) => mapEpisodeForStorage(ep, { includeSeriesEpisodes: true }));
}

function transformForSync(episodes) {
  return episodes
    .filter((ep) => ep.videoUrl || hasUsableServer(ep))
    .map((ep) => mapEpisodeForStorage(ep, { includeSeriesEpisodes: false }));
}

function buildSeriesReference(episodes) {
  const series = [];
  const seen = new Set();

  for (const ep of Array.isArray(episodes) ? episodes : []) {
    if (!ep || typeof ep !== "object") continue;
    const seriesName =
      ep.seriesName ||
      parseSeriesName(ep.title || extractSlugFromEpisodeUrl(ep.episodeUrl)) ||
      extractSlugFromEpisodeUrl(ep.episodeUrl);
    if (!seriesName || seen.has(seriesName)) continue;
    seen.add(seriesName);

    const chain = Array.isArray(ep.seriesEpisodes) && ep.seriesEpisodes.length
      ? ep.seriesEpisodes
      : [ep];
    const compactEpisodes = chain
      .filter((item) => item && item.episodeUrl)
      .map((item) => ({
        episodeNumber: item.episodeNumber ?? null,
        title: item.title || null,
        episodeUrl: item.episodeUrl,
        slug: item.slug || extractSlugFromEpisodeUrl(item.episodeUrl)
      }))
      .sort((a, b) => {
        const an = Number.isFinite(a.episodeNumber) ? a.episodeNumber : -1;
        const bn = Number.isFinite(b.episodeNumber) ? b.episodeNumber : -1;
        return bn - an;
      });

    series.push({
      seriesName,
      latestEpisodeNumber: compactEpisodes[0]?.episodeNumber ?? ep.episodeNumber ?? null,
      latestEpisodeUrl: compactEpisodes[0]?.episodeUrl || ep.episodeUrl,
      imageUrl: sanitizeStoredEpisodeImageUrl(ep.imageUrl),
      episodeCount: compactEpisodes.length,
      episodes: compactEpisodes
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    count: series.length,
    series: series.sort((a, b) => a.seriesName.localeCompare(b.seriesName, "ar"))
  };
}

async function saveSeriesReference(filePath, episodes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await loadSeriesReference(filePath);
  const fromEpisodes = buildSeriesReference(episodes);
  const map = new Map();

  for (const item of Array.isArray(existing.series) ? existing.series : []) {
    if (item?.seriesName) map.set(item.seriesName, item);
  }
  for (const item of Array.isArray(fromEpisodes.series) ? fromEpisodes.series : []) {
    if (!item?.seriesName) continue;
    const prev = map.get(item.seriesName) || {};
    map.set(item.seriesName, {
      ...prev,
      ...item,
      discoveredAt: prev.discoveredAt || item.discoveredAt,
      updatedAt: new Date().toISOString()
    });
  }

  const series = Array.from(map.values()).sort((a, b) =>
    a.seriesName.localeCompare(b.seriesName, "ar")
  );
  await fs.writeFile(
    filePath,
    JSON.stringify({ generatedAt: new Date().toISOString(), count: series.length, series }, null, 2),
    "utf8"
  );
}

async function loadSeriesReference(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.series)) parsed.series = [];
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") return { series: [] };
    throw err;
  }
}

function buildKnownSeriesSnapshot(seriesRef, storedEpisodes) {
  const seriesNames = new Set();
  const episodeUrls = new Set();
  const episodesBySeries = {};

  const ensureSeriesBucket = (seriesName) => {
    if (!episodesBySeries[seriesName]) {
      episodesBySeries[seriesName] = { episodeUrls: [], episodeNumbers: [] };
    }
    return episodesBySeries[seriesName];
  };

  for (const item of Array.isArray(seriesRef?.series) ? seriesRef.series : []) {
    if (item?.seriesName) seriesNames.add(item.seriesName);
    for (const ep of Array.isArray(item?.episodes) ? item.episodes : []) {
      if (ep?.episodeUrl) episodeUrls.add(ep.episodeUrl);
      if (item?.seriesName) {
        const bucket = ensureSeriesBucket(item.seriesName);
        if (ep?.episodeUrl) bucket.episodeUrls.push(ep.episodeUrl);
        if (Number.isFinite(ep?.episodeNumber)) bucket.episodeNumbers.push(Number(ep.episodeNumber));
      }
    }
  }

  for (const item of Array.isArray(storedEpisodes) ? storedEpisodes : []) {
    const seriesName =
      item?.seriesName ||
      parseSeriesName(item?.title || extractSlugFromEpisodeUrl(item?.episodeUrl));
    if (seriesName) seriesNames.add(seriesName);
    const bucket = seriesName ? ensureSeriesBucket(seriesName) : null;
    if (item?.episodeUrl) {
      episodeUrls.add(item.episodeUrl);
      if (bucket) bucket.episodeUrls.push(item.episodeUrl);
    }
    if (bucket && Number.isFinite(item?.episodeNumber)) {
      bucket.episodeNumbers.push(Number(item.episodeNumber));
    }
    for (const ep of Array.isArray(item?.seriesEpisodes) ? item.seriesEpisodes : []) {
      if (ep?.episodeUrl) {
        episodeUrls.add(ep.episodeUrl);
        if (bucket) bucket.episodeUrls.push(ep.episodeUrl);
      }
      if (bucket && Number.isFinite(ep?.episodeNumber)) {
        bucket.episodeNumbers.push(Number(ep.episodeNumber));
      }
    }
  }

  return {
    seriesNames: Array.from(seriesNames),
    episodeUrls: Array.from(episodeUrls),
    episodesBySeries: Object.fromEntries(
      Object.entries(episodesBySeries).map(([seriesName, bucket]) => [
        seriesName,
        {
          episodeUrls: Array.from(new Set(bucket.episodeUrls)),
          episodeNumbers: Array.from(new Set(bucket.episodeNumbers))
        }
      ])
    )
  };
}

function mergeSeriesReferences(existingRef, discovered) {
  const now = new Date().toISOString();
  const map = new Map();

  for (const item of Array.isArray(existingRef?.series) ? existingRef.series : []) {
    if (item?.seriesName) map.set(item.seriesName, item);
  }

  let added = 0;
  let skipped = 0;
  for (const item of Array.isArray(discovered) ? discovered : []) {
    const seriesName =
      item?.seriesName ||
      parseSeriesName(item?.title || extractSlugFromEpisodeUrl(item?.episodeUrl));
    if (!seriesName) continue;
    if (map.has(seriesName)) {
      skipped += 1;
      continue;
    }

    added += 1;
    map.set(seriesName, {
      seriesName,
      latestEpisodeNumber: item.episodeNumber ?? null,
      latestEpisodeUrl: item.episodeUrl,
      imageUrl: sanitizeStoredEpisodeImageUrl(item.listingImageUrl || item.imageUrl),
      episodeCount: 0,
      episodes: [],
      discoveredAt: now,
      updatedAt: now
    });
  }

  const series = Array.from(map.values()).sort((a, b) =>
    a.seriesName.localeCompare(b.seriesName, "ar")
  );
  return {
    generatedAt: now,
    count: series.length,
    added,
    skipped,
    series
  };
}

async function runSeriesOnly(options = {}) {
  const activeLogger = options.silent ? { info: () => {}, warn: () => {}, error: () => {} } : logger;
  activeLogger.info("series_refresh_started");
  const seriesRef = await loadSeriesReference(config.series.filePath);
  const discovered = await runSeriesDiscovery(config, activeLogger);
  const merged = mergeSeriesReferences(seriesRef, discovered);
  await fs.mkdir(path.dirname(config.series.filePath), { recursive: true });
  await fs.writeFile(config.series.filePath, JSON.stringify(merged, null, 2), "utf8");
  activeLogger.info("series_refresh_finished", {
    discovered: discovered.length,
    added: merged.added,
    skipped: merged.skipped,
    total: merged.count
  });
  return {
    discovered: discovered.length,
    added: merged.added,
    skipped: merged.skipped,
    total: merged.count
  };
}

function getFlagValue(flagName) {
  const arg = process.argv.find((item) => item.startsWith(`${flagName}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

async function runOnce(options = {}) {
  const activeLogger = options.silent ? { info: () => {}, warn: () => {}, error: () => {} } : logger;
  const reset = Boolean(options.reset);
  activeLogger.info("run_started", { reset });
  const state = await loadState(config.state.filePath);
  const storeData = await loadEpisodes(config.episodes.filePath);
  const seriesRef = await loadSeriesReference(config.series.filePath);
  const knownSeries = buildKnownSeriesSnapshot(seriesRef, storeData.episodes);
  if (!options.singleEpisodeUrl) {
    knownSeries.onSeriesResult = async (seriesResult, progress) => {
      const storeEpisodes = transformForStore([seriesResult]);
      storeData.episodes = upsertEpisodes(storeData.episodes, storeEpisodes);
      await saveEpisodes(config.episodes.filePath, storeData);
      await saveSeriesReference(config.series.filePath, storeData.episodes);
      activeLogger.info("series_progress_saved", {
        ...progress,
        stored: storeData.episodes.length
      });
    };
  }
  const crawled = options.singleEpisodeUrl
    ? await runCrawl(config, activeLogger, { ...options, knownSeries })
    : await runSeriesEpisodeRefresh(config, activeLogger, seriesRef, knownSeries);
  const unsynced = pickUnsynced(crawled, state);
  const outbound = transformForSync(unsynced);

  if (reset) {
    // Full replace: drop previous entries and keep only playable episodes
    // produced by this crawl. Scheduler runs still use upsert (below).
    const freshStoreEpisodes = transformForStore(crawled);
    if (freshStoreEpisodes.length > 0) {
      storeData.episodes = upsertEpisodes([], freshStoreEpisodes);
    } else {
      // In production, source mirrors can intermittently return empty listings.
      // Do not erase previously stored episodes on an empty reset crawl.
      activeLogger.warn("reset_skipped_empty_crawl_preserving_store", {
        previousStored: Array.isArray(storeData.episodes) ? storeData.episodes.length : 0
      });
    }
  } else {
    const storeEpisodes = transformForStore(unsynced);
    storeData.episodes = upsertEpisodes(storeData.episodes, storeEpisodes);
  }

  await saveEpisodes(config.episodes.filePath, storeData);
  await saveSeriesReference(config.series.filePath, storeData.episodes);

  activeLogger.info("run_prepared", {
    crawled: crawled.length,
    unsynced: unsynced.length,
    outbound: outbound.length,
    reset,
    stored: storeData.episodes.length,
    seriesReference: config.series.filePath,
    dryRun: config.runtime.dryRun
  });

  const syncConfigured = Boolean(config.sync.endpoint && config.sync.token);
  if (outbound.length > 0 && !config.runtime.dryRun && syncConfigured) {
    await syncEpisodes(outbound, config, activeLogger);
    for (const episode of unsynced) {
      if (episode.videoUrl) markSynced(state, episode.episodeUrl);
    }
    await saveState(config.state.filePath, state);
    activeLogger.info("state_updated", { syncedTotal: state.syncedEpisodeUrls.length });
  }

  if (outbound.length === 0) {
    activeLogger.info("nothing_to_sync");
  } else if (config.runtime.dryRun) {
    activeLogger.info("dry_run_skip_sync", { count: outbound.length });
  } else if (!syncConfigured) {
    activeLogger.warn("remote_sync_not_configured_skip_sync", {
      count: outbound.length,
      missingEndpoint: !config.sync.endpoint,
      missingToken: !config.sync.token
    });
  }

  activeLogger.info("run_finished");
  return { crawled, unsynced, outbound, stored: storeData.episodes.length };
}

async function runLoop() {
  const intervalMs = config.scheduler.intervalMinutes * 60 * 1000;
  for (;;) {
    try {
      await runOnce();
    } catch (error) {
      logger.error("run_failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const loop = process.argv.includes("--loop");
  const printJson = process.argv.includes("--print-json");
  const reset = process.argv.includes("--reset");
  const seriesOnly = process.argv.includes("--series-only");
  const singleEpisodeUrl = getFlagValue("--episode-url");
  if (loop && seriesOnly) {
    throw new Error("--loop and --series-only cannot be used together");
  }
  if (singleEpisodeUrl && seriesOnly) {
    throw new Error("--episode-url and --series-only cannot be used together");
  }
  if (loop && singleEpisodeUrl) {
    throw new Error("--loop and --episode-url cannot be used together");
  }
  if (loop && printJson) {
    throw new Error("--loop and --print-json cannot be used together");
  }
  if (loop && reset) {
    throw new Error("--loop and --reset cannot be used together");
  }
  if (loop) return runLoop();
  const result = seriesOnly
    ? await runSeriesOnly({ silent: printJson })
    : await runOnce({ singleEpisodeUrl, silent: printJson, reset });
  if (printJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

main().catch((error) => {
  logger.error("fatal_error", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});

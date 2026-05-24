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

function errorMeta(err) {
  if (!err) return { error: "unknown" };
  if (err instanceof Error) {
    return {
      error: err.message,
      name: err.name,
      stack: err.stack ? String(err.stack).split("\n").slice(0, 8).join("\n") : null,
      code: err.code || null
    };
  }
  return { error: String(err) };
}

async function withStage(activeLogger, stage, meta, fn) {
  const startedAt = Date.now();
  activeLogger.info("stage_started", { stage, ...meta });
  try {
    const result = await fn();
    activeLogger.info("stage_finished", {
      stage,
      durationMs: Date.now() - startedAt,
      ...meta
    });
    return result;
  } catch (err) {
    activeLogger.error("stage_failed", {
      stage,
      durationMs: Date.now() - startedAt,
      ...meta,
      ...errorMeta(err)
    });
    throw err;
  }
}

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
    series: series.sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.discoveredAt || 0);
      const tb = Date.parse(b.updatedAt || b.discoveredAt || 0);
      return tb - ta;
    })
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

  const series = Array.from(map.values()).sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.discoveredAt || 0);
    const tb = Date.parse(b.updatedAt || b.discoveredAt || 0);
    return tb - ta;
  });
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
    parsed.series.sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.discoveredAt || 0);
      const tb = Date.parse(b.updatedAt || b.discoveredAt || 0);
      return tb - ta;
    });
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

  const series = Array.from(map.values()).sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.discoveredAt || 0);
    const tb = Date.parse(b.updatedAt || b.discoveredAt || 0);
    return tb - ta;
  });
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
  const startedAt = Date.now();
  activeLogger.info("series_refresh_started", {
    seriesFile: config.series.filePath,
    pid: process.pid
  });

  const seriesRef = await withStage(
    activeLogger,
    "load_series_reference",
    { seriesFile: config.series.filePath },
    () => loadSeriesReference(config.series.filePath)
  );
  activeLogger.info("series_reference_loaded", {
    existingCount: Array.isArray(seriesRef?.series) ? seriesRef.series.length : 0
  });

  const discovered = await withStage(
    activeLogger,
    "discover_series_from_listing",
    {},
    () => runSeriesDiscovery(config, activeLogger)
  );

  const merged = await withStage(
    activeLogger,
    "merge_series_reference",
    { discovered: discovered.length },
    () => Promise.resolve(mergeSeriesReferences(seriesRef, discovered))
  );

  await withStage(
    activeLogger,
    "write_series_reference",
    { seriesFile: config.series.filePath, total: merged.count, added: merged.added, skipped: merged.skipped },
    async () => {
      await fs.mkdir(path.dirname(config.series.filePath), { recursive: true });
      await fs.writeFile(config.series.filePath, JSON.stringify(merged, null, 2), "utf8");
    }
  );

  let seriesFileSize = null;
  try {
    seriesFileSize = (await fs.stat(config.series.filePath)).size;
  } catch (err) {
    activeLogger.warn("series_file_stat_failed", errorMeta(err));
    seriesFileSize = null;
  }

  activeLogger.info("series_refresh_finished", {
    discovered: discovered.length,
    added: merged.added,
    skipped: merged.skipped,
    total: merged.count,
    seriesFile: config.series.filePath,
    seriesFileSize,
    durationMs: Date.now() - startedAt
  });
  return {
    discovered: discovered.length,
    added: merged.added,
    skipped: merged.skipped,
    total: merged.count,
    seriesFile: config.series.filePath,
    seriesFileSize
  };
}

function getFlagValue(flagName) {
  const arg = process.argv.find((item) => item.startsWith(`${flagName}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

async function runOnce(options = {}) {
  const activeLogger = options.silent ? { info: () => {}, warn: () => {}, error: () => {} } : logger;
  const reset = Boolean(options.reset);
  const startedAt = Date.now();
  activeLogger.info("run_started", {
    reset,
    singleEpisodeUrl: options.singleEpisodeUrl || null,
    episodesFile: config.episodes.filePath,
    seriesFile: config.series.filePath,
    pid: process.pid
  });

  const state = await withStage(
    activeLogger,
    "load_state",
    { stateFile: config.state.filePath },
    () => loadState(config.state.filePath)
  );
  const storeData = await withStage(
    activeLogger,
    "load_episodes",
    { episodesFile: config.episodes.filePath },
    () => loadEpisodes(config.episodes.filePath)
  );
  activeLogger.info("episodes_loaded", {
    existingCount: Array.isArray(storeData.episodes) ? storeData.episodes.length : 0
  });
  let seriesRef = await withStage(
    activeLogger,
    "load_series_reference",
    { seriesFile: config.series.filePath },
    () => loadSeriesReference(config.series.filePath)
  );
  activeLogger.info("series_reference_loaded", {
    existingCount: Array.isArray(seriesRef?.series) ? seriesRef.series.length : 0
  });

  // Coolify deploys frequently start with an empty series.json (no persistent
  // volume yet, or a fresh re-seed). Without populating it first the episode
  // refresh would iterate an empty list and silently save nothing — looking
  // exactly like "the refresh button does not save data".
  const noSeriesYet = !Array.isArray(seriesRef?.series) || seriesRef.series.length === 0;
  if (!options.singleEpisodeUrl && noSeriesYet) {
    activeLogger.info("series_reference_empty_running_discovery_first", {
      seriesFile: config.series.filePath
    });
    const discovered = await withStage(
      activeLogger,
      "seed_series_via_discovery",
      {},
      () => runSeriesDiscovery(config, activeLogger)
    );
    const merged = mergeSeriesReferences(seriesRef, discovered);
    await withStage(
      activeLogger,
      "write_series_reference_seed",
      { added: merged.added, skipped: merged.skipped, total: merged.count },
      async () => {
        await fs.mkdir(path.dirname(config.series.filePath), { recursive: true });
        await fs.writeFile(config.series.filePath, JSON.stringify(merged, null, 2), "utf8");
      }
    );
    activeLogger.info("series_reference_seeded_during_episode_refresh", {
      discovered: discovered.length,
      added: merged.added,
      skipped: merged.skipped,
      total: merged.count
    });
    seriesRef = await loadSeriesReference(config.series.filePath);
  }

  const knownSeries = buildKnownSeriesSnapshot(seriesRef, storeData.episodes);
  activeLogger.info("known_series_snapshot_built", {
    seriesNames: knownSeries.seriesNames.length,
    knownEpisodeUrls: knownSeries.episodeUrls.length
  });
  if (!options.singleEpisodeUrl) {
    knownSeries.onSeriesResult = async (seriesResult, progress) => {
      try {
        const storeEpisodes = transformForStore([seriesResult]);
        storeData.episodes = upsertEpisodes(storeData.episodes, storeEpisodes);
        await saveEpisodes(config.episodes.filePath, storeData);
        await saveSeriesReference(config.series.filePath, storeData.episodes);
        activeLogger.info("series_progress_saved", {
          ...progress,
          stored: storeData.episodes.length
        });
      } catch (err) {
        activeLogger.error("series_progress_save_failed", {
          ...progress,
          ...errorMeta(err)
        });
        throw err;
      }
    };
  }
  const crawled = await withStage(
    activeLogger,
    options.singleEpisodeUrl ? "run_single_episode_crawl" : "run_series_episode_refresh",
    { singleEpisodeUrl: options.singleEpisodeUrl || null, seriesCount: knownSeries.seriesNames.length },
    async () =>
      options.singleEpisodeUrl
        ? runCrawl(config, activeLogger, { ...options, knownSeries })
        : runSeriesEpisodeRefresh(config, activeLogger, seriesRef, knownSeries)
  );
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

  await withStage(
    activeLogger,
    "save_episodes",
    { episodesFile: config.episodes.filePath, count: storeData.episodes.length },
    () => saveEpisodes(config.episodes.filePath, storeData)
  );
  await withStage(
    activeLogger,
    "save_series_reference",
    { seriesFile: config.series.filePath },
    () => saveSeriesReference(config.series.filePath, storeData.episodes)
  );

  let episodesFileSize = null;
  let seriesFileSize = null;
  try {
    episodesFileSize = (await fs.stat(config.episodes.filePath)).size;
  } catch (err) {
    activeLogger.warn("episodes_file_stat_failed", errorMeta(err));
    episodesFileSize = null;
  }
  try {
    seriesFileSize = (await fs.stat(config.series.filePath)).size;
  } catch (err) {
    activeLogger.warn("series_file_stat_failed", errorMeta(err));
    seriesFileSize = null;
  }

  activeLogger.info("run_prepared", {
    crawled: crawled.length,
    unsynced: unsynced.length,
    outbound: outbound.length,
    reset,
    stored: storeData.episodes.length,
    episodesFile: config.episodes.filePath,
    episodesFileSize,
    seriesReference: config.series.filePath,
    seriesFileSize,
    durationMs: Date.now() - startedAt,
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

  activeLogger.info("run_finished", {
    durationMs: Date.now() - startedAt,
    stored: storeData.episodes.length,
    crawled: crawled.length,
    outbound: outbound.length
  });
  return { crawled, unsynced, outbound, stored: storeData.episodes.length };
}

async function runLoop() {
  const intervalMs = config.scheduler.intervalMinutes * 60 * 1000;
  let iteration = 0;
  for (;;) {
    iteration += 1;
    const startedAt = Date.now();
    logger.info("loop_iteration_started", { iteration, intervalMinutes: config.scheduler.intervalMinutes });
    try {
      await runOnce();
      logger.info("loop_iteration_finished", {
        iteration,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      logger.error("run_failed", {
        iteration,
        durationMs: Date.now() - startedAt,
        ...errorMeta(error)
      });
    }
    logger.info("loop_iteration_sleeping", { iteration, sleepMs: intervalMs });
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

process.on("uncaughtException", (err) => {
  logger.error("crawl_uncaught_exception", errorMeta(err));
});
process.on("unhandledRejection", (reason) => {
  logger.error("crawl_unhandled_rejection", errorMeta(reason));
});

main().catch((error) => {
  logger.error("fatal_error", errorMeta(error));
  process.exitCode = 1;
});

const config = require("./config");
const logger = require("./logger");
const { runCrawl } = require("./crawler");
const { syncEpisodes } = require("./syncClient");
const { loadState, saveState, isSynced, markSynced } = require("./stateStore");
const { loadEpisodes, saveEpisodes, upsertEpisodes } = require("./episodesStore");
const {
  extractSlugFromEpisodeUrl,
  canonicalizePlayerUrl,
  sanitizeStoredEpisodeImageUrl
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

function mapEpisodeForStorage(ep) {
  return {
    // Use decoded Arabic slug as fallback display title.
    title: ep.title || extractSlugFromEpisodeUrl(ep.episodeUrl)?.replace(/-/g, " ") || null,
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
}

function transformForStore(episodes) {
  return episodes.map((ep) => mapEpisodeForStorage(ep));
}

function transformForSync(episodes) {
  return episodes
    .filter((ep) => ep.videoUrl || hasUsableServer(ep))
    .map((ep) => mapEpisodeForStorage(ep));
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
  const crawled = await runCrawl(config, activeLogger, options);
  const unsynced = pickUnsynced(crawled, state);
  const outbound = transformForSync(unsynced);
  const storeData = await loadEpisodes(config.episodes.filePath);

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

  activeLogger.info("run_prepared", {
    crawled: crawled.length,
    unsynced: unsynced.length,
    outbound: outbound.length,
    reset,
    stored: storeData.episodes.length,
    dryRun: config.runtime.dryRun
  });

  if (outbound.length > 0 && !config.runtime.dryRun) {
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
  const singleEpisodeUrl = getFlagValue("--episode-url");
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
  const result = await runOnce({ singleEpisodeUrl, silent: printJson, reset });
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

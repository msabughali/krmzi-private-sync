const path = require("path");
require("dotenv").config();

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseIntSafe(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  source: {
    baseUrl: process.env.SOURCE_BASE_URL || "https://krmzy.com",
    listPath: process.env.SOURCE_LIST_PATH || "/",
    maxEpisodesPerRun: parseIntSafe(process.env.MAX_EPISODES_PER_RUN, 50),
    maxListPages: parseIntSafe(process.env.MAX_LIST_PAGES, 5),
    navigationTimeoutMs: parseIntSafe(process.env.NAVIGATION_TIMEOUT_MS, 60000)
  },
  crawler: {
    headless: parseBool(process.env.HEADLESS, true),
    retries: parseIntSafe(process.env.CRAWLER_RETRIES, 3),
    minDelayMs: parseIntSafe(process.env.MIN_DELAY_MS, 400),
    maxDelayMs: parseIntSafe(process.env.MAX_DELAY_MS, 900)
  },
  sync: {
    endpoint: process.env.TARGET_SYNC_ENDPOINT || "",
    token: process.env.TARGET_SYNC_TOKEN || "",
    timeoutMs: parseIntSafe(process.env.SYNC_TIMEOUT_MS, 20000)
  },
  state: {
    filePath:
      process.env.STATE_FILE_PATH || path.join(process.cwd(), "data", "state.json")
  },
  episodes: {
    filePath:
      process.env.EPISODES_FILE_PATH || path.join(process.cwd(), "data", "episodes.json")
  },
  series: {
    filePath:
      process.env.SERIES_FILE_PATH || path.join(process.cwd(), "data", "series.json")
  },
  scheduler: {
    intervalMinutes: parseIntSafe(process.env.INTERVAL_MINUTES, 30)
  },
  runtime: {
    dryRun: parseBool(process.env.DRY_RUN, false),
    logLevel: process.env.LOG_LEVEL || "info"
  }
};

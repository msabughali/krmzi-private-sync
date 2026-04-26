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

function parseMirrorList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        return new URL(item).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = {
  source: {
    baseUrl: process.env.SOURCE_BASE_URL || "https://krmzi.onl",
    listPath: process.env.SOURCE_LIST_PATH || "/",
    maxEpisodesPerRun: parseIntSafe(process.env.MAX_EPISODES_PER_RUN, 1000),
    maxListPages: parseIntSafe(process.env.MAX_LIST_PAGES, 80),
    navigationTimeoutMs: parseIntSafe(process.env.NAVIGATION_TIMEOUT_MS, 60000),
    // Optional comma/space separated list of additional mirror origins to
    // try when the primary host is unreachable or returns a placeholder.
    // Example: LISTING_MIRRORS="https://krmzi.fun,https://krmzi.app"
    extraMirrors: parseMirrorList(process.env.LISTING_MIRRORS)
  },
  crawler: {
    headless: parseBool(process.env.HEADLESS, true),
    retries: parseIntSafe(process.env.CRAWLER_RETRIES, 3),
    minDelayMs: parseIntSafe(process.env.MIN_DELAY_MS, 400),
    maxDelayMs: parseIntSafe(process.env.MAX_DELAY_MS, 900),
    // Outbound proxy for Playwright. Required to bypass datacenter-IP
    // geofencing applied by the upstream source (krmzy/krmzi mirrors
    // currently 30x-redirect datacenter IPs to a "Coming Soon" page).
    // Examples:
    //   CRAWLER_PROXY_SERVER=http://gate.smartproxy.com:7000
    //   CRAWLER_PROXY_SERVER=socks5://user-pass@residential.proxy:1080
    proxy: {
      server: process.env.CRAWLER_PROXY_SERVER || "",
      username: process.env.CRAWLER_PROXY_USERNAME || "",
      password: process.env.CRAWLER_PROXY_PASSWORD || "",
      bypass: process.env.CRAWLER_PROXY_BYPASS || ""
    }
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

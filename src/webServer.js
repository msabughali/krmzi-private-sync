const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");
const config = require("./config");
const { loadEpisodes } = require("./episodesStore");
const { resolveServerCandidates } = require("./parser");

const WEB_ROOT = path.join(process.cwd(), "web");
const PORT = Number.parseInt(process.env.WEB_PORT || "8787", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

async function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const type = MIME[ext] || "application/octet-stream";
  const content = await fs.readFile(filePath);
  res.writeHead(200, { "content-type": type });
  res.end(content);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function safeJoin(base, candidate) {
  const normalized = path.normalize(path.join(base, candidate));
  return normalized.startsWith(base) ? normalized : null;
}

function episodeUrlKey(value) {
  try {
    const u = new URL(value);
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Keep the URL parser's normalized path if decoding fails.
    }
    return `${u.origin.toLowerCase()}${pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return String(value || "");
  }
}

function findStoredEpisodeByUrl(episodes, episodeUrl) {
  if (!episodeUrl || !Array.isArray(episodes)) return null;
  const targetKey = episodeUrlKey(episodeUrl);
  for (const ep of episodes) {
    if (!ep || typeof ep !== "object") continue;
    if (episodeUrlKey(ep.episodeUrl) === targetKey) return ep;
    if (Array.isArray(ep.seriesEpisodes)) {
      const nested = ep.seriesEpisodes.find((item) => episodeUrlKey(item?.episodeUrl) === targetKey);
      if (nested) return nested;
    }
  }
  return null;
}

const refreshState = {
  running: false,
  lastError: null,
  lastFinishedAt: null,
  lastExitCode: null,
  progress: null
};

function updateRefreshProgressFromLog(line) {
  let payload = null;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;

  if (payload.message === "checking_series_episodes") {
    refreshState.progress = {
      phase: "checking_series",
      seriesName: payload.seriesName || null,
      processed: payload.processed || null,
      total: payload.total || null,
      updatedAt: payload.ts || new Date().toISOString()
    };
  } else if (payload.message === "resolving_missing_series_episode") {
    refreshState.progress = {
      ...(refreshState.progress || {}),
      phase: "resolving_episode",
      seriesName: payload.seriesName || null,
      episodeNumber: payload.episodeNumber || null,
      episodeUrl: payload.episodeUrl || null,
      updatedAt: payload.ts || new Date().toISOString()
    };
  } else if (payload.message === "series_progress_saved") {
    refreshState.progress = {
      phase: "saved_series",
      seriesName: payload.seriesName || null,
      processed: payload.processed || null,
      total: payload.total || null,
      missing: payload.missing || 0,
      saved: payload.saved || 0,
      stored: payload.stored || null,
      updatedAt: payload.ts || new Date().toISOString()
    };
  } else if (payload.message === "series_episodes_already_complete") {
    refreshState.progress = {
      phase: "skipped_complete_series",
      seriesName: payload.seriesName || null,
      processed: payload.processed || null,
      total: payload.seriesTotal || null,
      updatedAt: payload.ts || new Date().toISOString()
    };
  }
}

function startRefreshCrawl(args = []) {
  const entry = path.join(process.cwd(), "src", "index.js");
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STATE_FILE_PATH: config.state.filePath,
      EPISODES_FILE_PATH: config.episodes.filePath,
      SERIES_FILE_PATH: config.series.filePath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdoutBuf += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) updateRefreshProgressFromLog(line.trim());
      }
      if (stdoutBuf.length > 6000) stdoutBuf = stdoutBuf.slice(-6000);
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrBuf += String(chunk);
      if (stderrBuf.length > 6000) stderrBuf = stderrBuf.slice(-6000);
    });
  }

  child.on("error", (err) => {
    refreshState.running = false;
    refreshState.lastError = err.message;
    refreshState.lastExitCode = -1;
    refreshState.lastFinishedAt = new Date().toISOString();
  });

  child.on("close", (code) => {
    refreshState.running = false;
    refreshState.lastExitCode = code;
    if (code === 0) {
      refreshState.lastError = null;
    } else {
      const parts = [stderrBuf.trim(), stdoutBuf.trim()].filter(Boolean);
      const tail = parts.join("\n---\n").slice(-2000);
      refreshState.lastError = tail || `Process exited with code ${code}`;
    }
    refreshState.lastFinishedAt = new Date().toISOString();
    if (refreshState.progress) {
      refreshState.progress = {
        ...refreshState.progress,
        phase: code === 0 ? "finished" : "failed",
        updatedAt: refreshState.lastFinishedAt
      };
    }
  });
}

async function handler(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (reqUrl.pathname === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, uptime: process.uptime() });
  }

  if (reqUrl.pathname === "/api/refresh-status" && req.method === "GET") {
    return sendJson(res, 200, {
      running: refreshState.running,
      lastError: refreshState.lastError,
      lastFinishedAt: refreshState.lastFinishedAt,
      lastExitCode: refreshState.lastExitCode,
      progress: refreshState.progress
    });
  }

  if (reqUrl.pathname === "/api/refresh") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    if (refreshState.running) {
      return sendJson(res, 409, {
        error: "already_running",
        message: "A crawl is already in progress."
      });
    }
    refreshState.running = true;
    refreshState.lastError = null;
    refreshState.lastExitCode = null;
    refreshState.lastFinishedAt = null;
    refreshState.progress = { phase: "starting", updatedAt: new Date().toISOString() };
    try {
      startRefreshCrawl(["--once"]);
    } catch (err) {
      refreshState.running = false;
      refreshState.lastError = err instanceof Error ? err.message : String(err);
      refreshState.lastFinishedAt = new Date().toISOString();
      refreshState.lastExitCode = -1;
      return sendJson(res, 500, { error: "spawn_failed", message: refreshState.lastError });
    }
    return sendJson(res, 202, { ok: true, accepted: true });
  }

  if (reqUrl.pathname === "/api/refresh-series") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    if (refreshState.running) {
      return sendJson(res, 409, {
        error: "already_running",
        message: "A crawl is already in progress."
      });
    }
    refreshState.running = true;
    refreshState.lastError = null;
    refreshState.lastExitCode = null;
    refreshState.lastFinishedAt = null;
    refreshState.progress = { phase: "starting_series_scan", updatedAt: new Date().toISOString() };
    try {
      startRefreshCrawl(["--series-only"]);
    } catch (err) {
      refreshState.running = false;
      refreshState.lastError = err instanceof Error ? err.message : String(err);
      refreshState.lastFinishedAt = new Date().toISOString();
      refreshState.lastExitCode = -1;
      return sendJson(res, 500, { error: "spawn_failed", message: refreshState.lastError });
    }
    return sendJson(res, 202, { ok: true, accepted: true });
  }

  if (reqUrl.pathname === "/api/episodes") {
    const data = await loadEpisodes(config.episodes.filePath);
    return sendJson(res, 200, data);
  }

  if (reqUrl.pathname === "/api/resolve-server") {
    const episodeUrl = reqUrl.searchParams.get("episodeUrl");
    const playerUrlParam = reqUrl.searchParams.get("playerUrl");
    const server = reqUrl.searchParams.get("server");
    const preferDirect = ["1", "true", "yes"].includes(
      String(reqUrl.searchParams.get("preferDirect") || "").toLowerCase()
    );
    const data = await loadEpisodes(config.episodes.filePath);
    const fromEpisode = episodeUrl
      ? findStoredEpisodeByUrl(data.episodes, episodeUrl)
      : null;
    const playerUrl = playerUrlParam || fromEpisode?.playerUrl || null;
    const storedServers = Array.isArray(fromEpisode?.playerServers)
      ? fromEpisode.playerServers
      : null;

    if (!playerUrl && !(storedServers && storedServers.length)) {
      return sendJson(res, 400, {
        error: "missing_player_url",
        message: "Provide playerUrl or an episodeUrl with a saved player URL / server list."
      });
    }

    // Prefer the server list we stored during crawl. No aggregator URL is ever
    // dereferenced at runtime.
    const resolved = storedServers && storedServers.length
      ? resolveServerCandidates(null, server, { preferDirect, servers: storedServers })
      : resolveServerCandidates(playerUrl, server, { preferDirect });

    return sendJson(res, 200, {
      episodeUrl: episodeUrl || fromEpisode?.episodeUrl || null,
      playerUrl,
      ...resolved
    });
  }

  if (reqUrl.pathname === "/play") {
    return sendFile(res, path.join(WEB_ROOT, "play.html"));
  }

  const target = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
  const filePath = safeJoin(WEB_ROOT, target);
  if (!filePath) return sendJson(res, 403, { error: "forbidden" });

  try {
    return await sendFile(res, filePath);
  } catch {
    return sendJson(res, 404, { error: "not_found" });
  }
}

http
  .createServer((req, res) => {
    handler(req, res).catch((err) => {
      sendJson(res, 500, { error: "server_error", message: err.message });
    });
  })
  .listen(PORT, () => {
    process.stdout.write(`Web UI: http://localhost:${PORT}\n`);
  });

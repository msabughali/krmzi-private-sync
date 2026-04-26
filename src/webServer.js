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
  // Coolify (and its Traefik proxy) plus browsers happily cache HTML/JS forever
  // unless we say otherwise, so deployments shipping new UI behavior never reach
  // the user. Force revalidation on every request for app shell assets.
  const noCacheExts = new Set([".html", ".js", ".css"]);
  const headers = { "content-type": type };
  if (noCacheExts.has(ext)) {
    headers["cache-control"] = "no-store, must-revalidate";
    headers.pragma = "no-cache";
    headers.expires = "0";
  }
  res.writeHead(200, headers);
  res.end(content);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, must-revalidate",
    pragma: "no-cache",
    expires: "0"
  });
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
  progress: null,
  lastSaved: null,
  startedAt: null,
  pid: null,
  args: null
};

function emitLog(level, message, meta = {}) {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta })}\n`
  );
}

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

async function statSafe(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      path: filePath,
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      isFile: stat.isFile()
    };
  } catch (err) {
    return {
      path: filePath,
      exists: false,
      error: err && err.code ? err.code : String(err && err.message ? err.message : err)
    };
  }
}

async function probeDataDirectory() {
  const dir = path.dirname(config.episodes.filePath);
  const probe = path.join(dir, ".write-probe");
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, String(Date.now()), "utf8");
    const back = await fs.readFile(probe, "utf8");
    await fs.unlink(probe).catch(() => {});
    return { writable: true, dir, sample: back };
  } catch (err) {
    return {
      writable: false,
      dir,
      error: err && err.code ? err.code : String(err && err.message ? err.message : err)
    };
  }
}

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
  } else if (payload.message === "series_refresh_started") {
    refreshState.progress = {
      phase: "starting_series_scan",
      updatedAt: payload.ts || new Date().toISOString()
    };
  } else if (payload.message === "listing_page_load_failed") {
    refreshState.progress = {
      phase: "listing_page_load_failed_retrying_mirror",
      pageUrl: payload.pageUrl || null,
      candidateBase: payload.candidateBase || null,
      pageNumber: payload.pageNumber || null,
      updatedAt: payload.ts || new Date().toISOString()
    };
  } else if (payload.message === "list_page_scanned") {
    refreshState.progress = {
      phase: "scanning_listing_pages",
      pageUrl: payload.pageUrl || null,
      pageFound: payload.pageFound || 0,
      newlyAdded: payload.newlyAdded || 0,
      totalAggregated: payload.totalAggregated || 0,
      updatedAt: payload.ts || new Date().toISOString()
    };
  } else if (payload.message === "discovered_series_candidates") {
    refreshState.progress = {
      phase: "series_candidates_discovered",
      count: payload.count || 0,
      updatedAt: payload.ts || new Date().toISOString()
    };
  } else if (payload.message === "series_refresh_finished") {
    refreshState.progress = {
      phase: "series_scan_finished",
      discovered: payload.discovered || 0,
      added: payload.added || 0,
      skipped: payload.skipped || 0,
      total: payload.total || 0,
      seriesFile: payload.seriesFile || null,
      seriesFileSize: payload.seriesFileSize ?? null,
      updatedAt: payload.ts || new Date().toISOString()
    };
    refreshState.lastSaved = {
      type: "series_only",
      seriesFile: payload.seriesFile || null,
      seriesFileSize: payload.seriesFileSize ?? null,
      total: payload.total || 0,
      added: payload.added || 0,
      at: payload.ts || new Date().toISOString()
    };
  } else if (payload.message === "run_prepared") {
    refreshState.lastSaved = {
      type: "episodes_run",
      episodesFile: payload.episodesFile || null,
      episodesFileSize: payload.episodesFileSize ?? null,
      seriesFile: payload.seriesReference || null,
      seriesFileSize: payload.seriesFileSize ?? null,
      stored: payload.stored ?? null,
      crawled: payload.crawled ?? null,
      at: payload.ts || new Date().toISOString()
    };
  } else if (payload.message === "series_reference_seeded_during_episode_refresh") {
    refreshState.progress = {
      ...(refreshState.progress || {}),
      phase: "series_reference_seeded",
      added: payload.added || 0,
      total: payload.total || 0,
      updatedAt: payload.ts || new Date().toISOString()
    };
  }
}

function startRefreshCrawl(args = []) {
  const entry = path.resolve(__dirname, "index.js");
  const startedAt = Date.now();
  emitLog("info", "refresh_crawl_starting", {
    entry,
    cwd: process.cwd(),
    args,
    seriesFile: config.series.filePath,
    episodesFile: config.episodes.filePath
  });

  let child;
  try {
    child = spawn(process.execPath, [entry, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STATE_FILE_PATH: config.state.filePath,
        EPISODES_FILE_PATH: config.episodes.filePath,
        SERIES_FILE_PATH: config.series.filePath
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    emitLog("error", "refresh_spawn_threw", { args, ...errorMeta(err) });
    throw err;
  }

  refreshState.pid = child.pid || null;
  refreshState.startedAt = new Date(startedAt).toISOString();
  refreshState.args = args;
  emitLog("info", "refresh_child_spawned", { pid: child.pid || null, args });

  let stdoutBuf = "";
  let stderrBuf = "";
  let stdoutLineBuf = "";
  let stderrLineBuf = "";

  function flushStdoutLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Forward the child's structured log line verbatim so it appears in
    // `docker compose logs web`. Each crawl log already includes ts/level/
    // message, so we just append a `source` tag and re-emit.
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") {
      emitLog(parsed.level || "info", parsed.message || "refresh_crawl_log", {
        ...parsed,
        source: "refresh_crawl",
        pid: child.pid || null
      });
    } else {
      emitLog("info", "refresh_crawl_stdout", {
        source: "refresh_crawl",
        pid: child.pid || null,
        line: trimmed
      });
    }
    updateRefreshProgressFromLog(trimmed);
  }

  function flushStderrLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    emitLog("error", "refresh_crawl_stderr", {
      source: "refresh_crawl",
      pid: child.pid || null,
      line: trimmed
    });
  }

  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdoutBuf += text;
      stdoutLineBuf += text;
      const parts = stdoutLineBuf.split(/\r?\n/);
      stdoutLineBuf = parts.pop() || "";
      for (const line of parts) flushStdoutLine(line);
      if (stdoutBuf.length > 6000) stdoutBuf = stdoutBuf.slice(-6000);
    });
    child.stdout.on("error", (err) => {
      emitLog("error", "refresh_child_stdout_error", { ...errorMeta(err), pid: child.pid || null });
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrBuf += text;
      stderrLineBuf += text;
      const parts = stderrLineBuf.split(/\r?\n/);
      stderrLineBuf = parts.pop() || "";
      for (const line of parts) flushStderrLine(line);
      if (stderrBuf.length > 6000) stderrBuf = stderrBuf.slice(-6000);
    });
    child.stderr.on("error", (err) => {
      emitLog("error", "refresh_child_stderr_error", { ...errorMeta(err), pid: child.pid || null });
    });
  }

  child.on("error", (err) => {
    refreshState.running = false;
    refreshState.lastError = err && err.message ? err.message : String(err);
    refreshState.lastExitCode = -1;
    refreshState.lastFinishedAt = new Date().toISOString();
    emitLog("error", "refresh_child_error", {
      pid: child.pid || null,
      args,
      durationMs: Date.now() - startedAt,
      ...errorMeta(err)
    });
  });

  child.on("close", (code, signal) => {
    if (stdoutLineBuf.trim()) flushStdoutLine(stdoutLineBuf);
    if (stderrLineBuf.trim()) flushStderrLine(stderrLineBuf);
    stdoutLineBuf = "";
    stderrLineBuf = "";
    refreshState.running = false;
    refreshState.lastExitCode = code;
    if (code === 0) {
      refreshState.lastError = null;
    } else {
      const parts = [stderrBuf.trim(), stdoutBuf.trim()].filter(Boolean);
      const tail = parts.join("\n---\n").slice(-2000);
      refreshState.lastError = tail || `Process exited with code ${code} (signal=${signal || "none"})`;
    }
    refreshState.lastFinishedAt = new Date().toISOString();
    if (refreshState.progress) {
      refreshState.progress = {
        ...refreshState.progress,
        phase: code === 0 ? "finished" : "failed",
        updatedAt: refreshState.lastFinishedAt
      };
    }
    emitLog(code === 0 ? "info" : "error", "refresh_child_exited", {
      pid: child.pid || null,
      args,
      code,
      signal: signal || null,
      durationMs: Date.now() - startedAt,
      stdoutTail: code === 0 ? null : stdoutBuf.slice(-1000) || null,
      stderrTail: code === 0 ? null : stderrBuf.slice(-1000) || null
    });
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
      progress: refreshState.progress,
      lastSaved: refreshState.lastSaved
    });
  }

  if (reqUrl.pathname === "/api/data-info" && req.method === "GET") {
    const [episodes, series, state, probe] = await Promise.all([
      statSafe(config.episodes.filePath),
      statSafe(config.series.filePath),
      statSafe(config.state.filePath),
      probeDataDirectory()
    ]);
    let storedEpisodes = null;
    let storedSeries = null;
    try {
      const data = await loadEpisodes(config.episodes.filePath);
      storedEpisodes = Array.isArray(data?.episodes) ? data.episodes.length : 0;
    } catch {
      storedEpisodes = null;
    }
    try {
      const seriesRaw = await fs.readFile(config.series.filePath, "utf8").catch(() => "{}");
      const seriesParsed = JSON.parse(seriesRaw);
      storedSeries = Array.isArray(seriesParsed?.series) ? seriesParsed.series.length : 0;
    } catch {
      storedSeries = null;
    }
    return sendJson(res, 200, {
      cwd: process.cwd(),
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      gid: typeof process.getgid === "function" ? process.getgid() : null,
      env: {
        EPISODES_FILE_PATH: config.episodes.filePath,
        SERIES_FILE_PATH: config.series.filePath,
        STATE_FILE_PATH: config.state.filePath
      },
      counts: {
        episodes: storedEpisodes,
        series: storedSeries
      },
      files: { episodes, series, state },
      writeProbe: probe,
      lastSaved: refreshState.lastSaved
    });
  }

  if (reqUrl.pathname === "/api/refresh" || reqUrl.pathname === "/api/refresh-series") {
    const isSeriesOnly = reqUrl.pathname === "/api/refresh-series";
    const action = isSeriesOnly ? "refresh_series" : "refresh_episodes";
    const args = isSeriesOnly ? ["--series-only"] : ["--once"];
    const initialPhase = isSeriesOnly ? "starting_series_scan" : "starting";

    emitLog("info", "refresh_request_received", {
      action,
      method: req.method,
      ip: req.socket?.remoteAddress || null,
      userAgent: req.headers["user-agent"] || null
    });

    if (req.method !== "POST") {
      emitLog("warn", "refresh_request_method_not_allowed", {
        action,
        method: req.method
      });
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    if (refreshState.running) {
      emitLog("warn", "refresh_request_already_running", {
        action,
        currentArgs: refreshState.args,
        currentPid: refreshState.pid,
        startedAt: refreshState.startedAt
      });
      return sendJson(res, 409, {
        error: "already_running",
        message: "A crawl is already in progress."
      });
    }

    refreshState.running = true;
    refreshState.lastError = null;
    refreshState.lastExitCode = null;
    refreshState.lastFinishedAt = null;
    refreshState.progress = { phase: initialPhase, updatedAt: new Date().toISOString() };

    try {
      startRefreshCrawl(args);
    } catch (err) {
      refreshState.running = false;
      refreshState.lastError = err instanceof Error ? err.message : String(err);
      refreshState.lastFinishedAt = new Date().toISOString();
      refreshState.lastExitCode = -1;
      emitLog("error", "refresh_spawn_failed", { action, args, ...errorMeta(err) });
      return sendJson(res, 500, { error: "spawn_failed", message: refreshState.lastError });
    }

    emitLog("info", "refresh_request_accepted", { action, args, pid: refreshState.pid });
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

async function logStartupDataState() {
  const [probe, episodes, series, state] = await Promise.all([
    probeDataDirectory(),
    statSafe(config.episodes.filePath),
    statSafe(config.series.filePath),
    statSafe(config.state.filePath)
  ]);
  const payload = {
    ts: new Date().toISOString(),
    level: probe.writable ? "info" : "error",
    message: probe.writable
      ? "data_directory_writable"
      : "data_directory_not_writable_data_will_not_persist",
    cwd: process.cwd(),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    probe,
    files: { episodes, series, state }
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

process.on("uncaughtException", (err) => {
  emitLog("error", "web_uncaught_exception", errorMeta(err));
});
process.on("unhandledRejection", (reason) => {
  emitLog("error", "web_unhandled_rejection", errorMeta(reason));
});

http
  .createServer((req, res) => {
    handler(req, res).catch((err) => {
      emitLog("error", "request_handler_failed", {
        path: req.url || null,
        method: req.method || null,
        ...errorMeta(err)
      });
      try {
        sendJson(res, 500, { error: "server_error", message: err && err.message ? err.message : String(err) });
      } catch (writeErr) {
        emitLog("error", "request_response_send_failed", errorMeta(writeErr));
      }
    });
  })
  .listen(PORT, () => {
    emitLog("info", "web_server_listening", { port: PORT, url: `http://localhost:${PORT}` });
    logStartupDataState().catch((err) => {
      emitLog("error", "startup_probe_failed", errorMeta(err));
    });
  });

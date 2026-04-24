async function postJson(url, token, data, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(data),
      signal: controller.signal
    });

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }

    if (!response.ok) {
      throw new Error(
        `sync_failed status=${response.status} body=${JSON.stringify(parsed).slice(0, 500)}`
      );
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function syncEpisodes(episodes, appConfig, logger) {
  if (!appConfig.sync.endpoint) {
    throw new Error("TARGET_SYNC_ENDPOINT is required");
  }
  if (!appConfig.sync.token) {
    throw new Error("TARGET_SYNC_TOKEN is required");
  }

  const payload = {
    source: "krmzi",
    syncedAt: new Date().toISOString(),
    episodes
  };

  logger.info("sync_request_started", {
    endpoint: appConfig.sync.endpoint,
    count: episodes.length
  });

  const result = await postJson(
    appConfig.sync.endpoint,
    appConfig.sync.token,
    payload,
    appConfig.sync.timeoutMs
  );

  logger.info("sync_request_completed", { count: episodes.length });
  return result;
}

module.exports = { syncEpisodes };

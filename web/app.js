function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatIso(value) {
  if (!value) return "";
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return "";
  try {
    return new Date(t).toLocaleString();
  } catch {
    return value;
  }
}

function appendLink(parent, { href, text, className }) {
  if (!href) return;
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text || href;
  if (className) a.className = className;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  parent.appendChild(a);
}

function setStatusText(text) {
  const el = document.getElementById("status");
  if (!el) return;
  el.className = "status";
  el.textContent = text;
}

function setStatusLoading(message) {
  const el = document.getElementById("status");
  if (!el) return;
  el.className = "status status--loading";
  el.innerHTML = "";
  const msg = document.createElement("span");
  msg.className = "status-msg";
  msg.textContent = message;
  const loader = document.createElement("span");
  loader.className = "loader";
  loader.setAttribute("role", "status");
  loader.setAttribute("aria-label", "جاري التحميل");
  el.appendChild(msg);
  el.appendChild(loader);
}

function isAllowedServerName(name) {
  const n = String(name || "").toLowerCase();
  return n === "dailymotion" || n === "ok";
}

function allowedServersForEpisode(ep) {
  return Array.isArray(ep?.playerServers)
    ? ep.playerServers.filter((s) => isAllowedServerName(s?.name))
    : [];
}

function findPlayableEpisode(ep) {
  const topServers = allowedServersForEpisode(ep);
  if (ep?.playerUrl || (topServers.length > 0 && ep?.episodeUrl)) {
    return { episode: ep, allowedServers: topServers };
  }

  const chain = Array.isArray(ep?.seriesEpisodes) ? ep.seriesEpisodes : [];
  for (const item of chain) {
    const itemServers = allowedServersForEpisode(item);
    if (item?.playerUrl || (itemServers.length > 0 && item?.episodeUrl)) {
      return { episode: item, allowedServers: itemServers };
    }
  }

  return { episode: null, allowedServers: [] };
}

async function loadEpisodes() {
  const list = document.getElementById("episodes");
  list.innerHTML = "";
  try {
    const res = await fetch("/api/episodes");
    const data = await res.json();
    const episodes = data.episodes || [];
    setStatusText(`${episodes.length} حلقة متوفرة`);

    if (!episodes.length) {
      setStatusText("لا توجد حلقات بعد. اضغط تحديث لجلب البيانات.");
      return;
    }

    for (const ep of episodes) {
      const li = document.createElement("li");
      li.className = "episode";
      const title = safeDecode(ep.title || ep.slug || ep.episodeUrl);

      const playable = findPlayableEpisode(ep);
      const playEpisode = playable.episode;
      const allowedServers = playable.allowedServers;
      const canPlay = Boolean(playEpisode?.playerUrl) || (allowedServers.length > 0 && playEpisode?.episodeUrl);
      const playUrl = canPlay
        ? `/play?url=${encodeURIComponent(playEpisode.playerUrl || "")}&title=${encodeURIComponent(
            safeDecode(playEpisode.title || title)
          )}&provider=${encodeURIComponent(
            playEpisode.playerProvider || "unknown"
          )}&playerId=${encodeURIComponent(playEpisode.playerId || "")}&episodeUrl=${encodeURIComponent(
            playEpisode.episodeUrl || ""
          )}&imageUrl=${encodeURIComponent(ep.imageUrl || "")}`
        : null;

      const row = document.createElement("div");
      row.className = "episode-row";

      const thumbWrap = document.createElement(playUrl ? "a" : "div");
      thumbWrap.className = `episode-thumb${ep.imageUrl ? "" : " episode-thumb--empty"}`;
      if (playUrl) {
        thumbWrap.href = playUrl;
      }
      if (ep.imageUrl) {
        const img = document.createElement("img");
        img.src = ep.imageUrl;
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.referrerPolicy = "no-referrer-when-downgrade";
        img.onerror = () => {
          img.remove();
          thumbWrap.classList.add("episode-thumb--empty");
        };
        thumbWrap.appendChild(img);
      }
      const badgeEpisodeNumber = playEpisode?.episodeNumber ?? ep.episodeNumber;
      if (badgeEpisodeNumber !== null && badgeEpisodeNumber !== undefined) {
        const badge = document.createElement("span");
        badge.className = "episode-badge";
        const label = document.createElement("span");
        label.className = "badge-label";
        label.textContent = "حلقة";
        const num = document.createElement("span");
        num.className = "badge-num";
        num.textContent = String(badgeEpisodeNumber);
        badge.appendChild(label);
        badge.appendChild(num);
        thumbWrap.appendChild(badge);
      }
      row.appendChild(thumbWrap);

      const body = document.createElement("div");
      body.className = "episode-body";

      const heading = document.createElement("div");
      heading.className = "episode-heading";

      if (playUrl) {
        const a = document.createElement("a");
        a.href = playUrl;
        a.textContent = title;
        heading.appendChild(a);
        const serverCount = allowedServers.length;
        if (serverCount > 0) {
          const count = document.createElement("span");
          count.className = "episode-server-count";
          count.textContent = `(${serverCount} سيرفر)`;
          heading.appendChild(count);
        }
      } else {
        const text = document.createElement("span");
        text.textContent = `${title} (المشغّل غير متاح بعد)`;
        heading.appendChild(text);
      }

      body.appendChild(heading);

      const meta = document.createElement("div");
      meta.className = "episode-meta";
      const provider = playEpisode?.playerProvider || ep.playerProvider || "unknown";
      const discovered = formatIso(ep.discoveredAt);
      const updated = formatIso(ep.updatedAt);
      meta.textContent = [
        `المزود: ${provider}`,
        discovered ? `اكتُشفت: ${discovered}` : null,
        updated ? `حُدّثت: ${updated}` : null
      ]
        .filter(Boolean)
        .join(" • ");
      body.appendChild(meta);

      const links = document.createElement("div");
      links.className = "episode-links";
      appendLink(links, { href: ep.episodeUrl, text: "الصفحة الأصلية" });
      if (links.childNodes.length > 0) body.appendChild(links);

      if (allowedServers.length > 0) {
        const serversWrap = document.createElement("div");
        serversWrap.className = "episode-servers";
        const label = document.createElement("div");
        label.className = "episode-servers-label";
        label.textContent = "السيرفرات:";
        serversWrap.appendChild(label);

        const serversRow = document.createElement("div");
        serversRow.className = "episode-servers-row";
        for (const srv of allowedServers) {
          const tag = document.createElement("span");
          tag.className = "server-tag";
          const name = String(srv?.name || "unknown");
          const id = srv?.id ? ` (${String(srv.id)})` : "";
          tag.textContent = name + id;
          serversRow.appendChild(tag);
        }
        serversWrap.appendChild(serversRow);
        body.appendChild(serversWrap);
      }

      row.appendChild(body);
      li.appendChild(row);
      list.appendChild(li);
    }
  } catch (err) {
    setStatusText(`خطأ: ${err.message}`);
  }
}

function refreshProgressText(data, fallback) {
  const progress = data?.progress || {};
  if (!progress.phase) return fallback;
  if (progress.phase === "listing_page_load_failed_retrying_mirror") {
    return `تعذر تحميل صفحة من المصدر، جاري تجربة مرآة أخرى… صفحة ${progress.pageNumber || ""}`;
  }
  if (progress.phase === "scanning_listing_pages") {
    return `جاري فحص صفحات المسلسلات… تم العثور على ${progress.totalAggregated || 0}`;
  }
  if (progress.phase === "series_candidates_discovered") {
    return `تم العثور على ${progress.count || 0} مسلسل، جاري الحفظ…`;
  }
  if (progress.phase === "series_scan_finished") {
    return `تم تحديث المسلسلات: جديد ${progress.added || 0}، موجود ${progress.skipped || 0}`;
  }
  if (progress.phase === "checking_series") {
    return `جاري فحص حلقات: ${progress.seriesName || ""}`;
  }
  if (progress.phase === "resolving_episode") {
    return `جاري جلب الحلقة ${progress.episodeNumber || ""}: ${progress.seriesName || ""}`;
  }
  if (progress.phase === "saved_series") {
    return `تم حفظ ${progress.saved || 0} حلقة من ${progress.seriesName || ""}`;
  }
  return fallback;
}

async function pollRefreshDone(loadingMessage) {
  for (;;) {
    const res = await fetch("/api/refresh-status");
    const data = await res.json();
    setStatusLoading(refreshProgressText(data, loadingMessage));
    if (!data.running) return data;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function runRefresh({ buttonId, endpoint, loadingMessage }) {
  const btn = document.getElementById(buttonId);
  const status = document.getElementById("status");
  if (!btn || !status) return;

  const buttons = [
    document.getElementById("refreshBtn"),
    document.getElementById("refreshSeriesBtn")
  ].filter(Boolean);
  for (const item of buttons) item.disabled = true;
  btn.disabled = true;
  setStatusLoading(loadingMessage);

  try {
    const res = await fetch(endpoint, { method: "POST" });
    const data = await res.json().catch(() => ({}));

    if (res.status === 409) {
      setStatusLoading(loadingMessage);
      const outcome = await pollRefreshDone(loadingMessage);
      if (outcome.lastExitCode === 0) {
        setStatusText("تم. جاري إعادة التحميل…");
        window.location.reload();
        return;
      }
      for (const item of buttons) item.disabled = false;
      return;
    }

    if (!res.ok) {
      setStatusText(data.message || `فشل التحديث (${res.status}).`);
      for (const item of buttons) item.disabled = false;
      return;
    }

    const outcome = await pollRefreshDone(loadingMessage);

    if (outcome.lastExitCode !== 0) {
      setStatusText(
        "فشل التحديث" +
          (outcome.lastError ? `: ${outcome.lastError}` : ".") +
          " راجع سجل الخادم."
      );
      for (const item of buttons) item.disabled = false;
      return;
    }

    setStatusText("تم. جاري إعادة التحميل…");
    window.location.reload();
  } catch (err) {
    setStatusText(`خطأ: ${err.message}`);
    for (const item of buttons) item.disabled = false;
  }
}

document.getElementById("refreshBtn")?.addEventListener("click", () => {
  runRefresh({
    buttonId: "refreshBtn",
    endpoint: "/api/refresh",
    loadingMessage: "جاري جلب بيانات الحلقات"
  });
});

document.getElementById("refreshSeriesBtn")?.addEventListener("click", () => {
  runRefresh({
    buttonId: "refreshSeriesBtn",
    endpoint: "/api/refresh-series",
    loadingMessage: "جاري فحص المسلسلات"
  });
});

loadEpisodes();

function normalizeUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseEpisodeNumber(text) {
  const match = String(text).match(/(?:حلقة|episode)\s*(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseSeriesName(text) {
  let value = String(text || "");
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep original text when it is not URI-encoded.
  }
  return value
    .replace(/\s*-\s*قرمزي\s*$/i, "")
    .replace(/^نهاية\s+الموسم\s+/i, "")
    .replace(/^حلقة\s*\d+\s+/i, "")
    .replace(/^episode\s*\d+\s+/i, "")
    .replace(/\s+(?:مسلسل\s*)?الحلقة\s*\d+\s*$/i, "")
    .replace(/\s+episode\s*\d+\s*$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

async function parseEpisodeLinks(page, baseUrl, maxCount) {
  // Lazy-load adapters: many themes delay populating background-image on
  // off-screen cards and keep the real URL in a data-* attribute. Trigger a
  // full-page scroll and mutate inline styles before extracting so every card
  // exposes its poster regardless of scroll position.
  try {
    await page.evaluate(async () => {
      function pickLazyUrl(el) {
        const attrs = [
          "data-bg",
          "data-bg-image",
          "data-bgset",
          "data-background",
          "data-background-image",
          "data-src",
          "data-lazy-src",
          "data-original",
          "data-image",
          "data-poster"
        ];
        for (const a of attrs) {
          const v = el.getAttribute(a);
          if (v && !v.startsWith("data:")) return v.trim().split(/\s+/)[0];
        }
        return null;
      }
      const bgEls = document.querySelectorAll(".posterThumb .imgBg, .posterThumb > .imgBg, .imgBg");
      for (const el of bgEls) {
        const style = el.getAttribute("style") || "";
        if (!/background-image\s*:\s*url\(/i.test(style)) {
          const lazy = pickLazyUrl(el);
          if (lazy) {
            el.setAttribute("style", `${style};background-image:url(${lazy})`);
          }
        }
      }
      // Scroll to force any remaining lazy loaders (IntersectionObserver etc.)
      const maxY = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
      const step = Math.max(300, Math.floor(window.innerHeight * 0.9));
      for (let y = 0; y <= maxY; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
      window.scrollTo(0, 0);
    });
  } catch {
    // Best-effort; extraction below handles whatever is present.
  }

  const links = await page.$$eval("a[href*='/episode/']", (anchors) => {
    const LAZY_ATTRS = [
      "data-bg",
      "data-bg-image",
      "data-bgset",
      "data-background",
      "data-background-image",
      "data-src",
      "data-lazy-src",
      "data-original",
      "data-image",
      "data-poster"
    ];
    function extractBgUrl(styleAttr) {
      if (!styleAttr) return null;
      const m = String(styleAttr).match(/background-image\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/i);
      return m ? m[2].trim() : null;
    }
    function extractLazyAttr(el) {
      if (!el) return null;
      for (const a of LAZY_ATTRS) {
        const v = el.getAttribute(a);
        if (v && !v.startsWith("data:")) {
          return String(v).trim().split(/\s+/)[0];
        }
      }
      return null;
    }
    function fromEl(el) {
      if (!el) return null;
      return (
        extractBgUrl(el.getAttribute("style")) ||
        extractLazyAttr(el) ||
        null
      );
    }
    function fromImgInside(container) {
      if (!container) return null;
      const img = container.querySelector("img");
      if (!img) return null;
      const src = img.getAttribute("src") || "";
      if (src && !src.startsWith("data:")) return src.trim();
      return extractLazyAttr(img);
    }
    function findPosterUrl(anchor) {
      const direct = anchor.querySelector(
        ".posterThumb .imgBg, .posterThumb > .imgBg, .imgBg"
      );
      const directUrl = fromEl(direct) || fromImgInside(anchor.querySelector(".posterThumb") || anchor);
      if (directUrl) return directUrl;
      // Walk up a few ancestors for a sibling poster (card containers).
      let node = anchor.parentElement;
      for (let i = 0; i < 4 && node; i += 1) {
        const el = node.querySelector(".posterThumb .imgBg, .imgBg");
        const u = fromEl(el) || fromImgInside(node.querySelector(".posterThumb"));
        if (u) return u;
        node = node.parentElement;
      }
      return null;
    }

    return anchors.map((a) => ({
      href: a.getAttribute("href"),
      text: (a.textContent || "").replace(/\s+/g, " ").trim(),
      title: a.getAttribute("title") || null,
      listingImageUrl: findPosterUrl(a)
    }));
  });

  const dedup = new Map();
  for (const item of links) {
    const full = item.href ? new URL(item.href, baseUrl).toString() : null;
    if (!full) continue;
    // If a duplicate with no image appeared first, allow upgrading to a card that has an image.
    const existing = dedup.get(full);
    if (existing && existing.listingImageUrl) continue;

    let listingImageUrl = null;
    try {
      listingImageUrl = item.listingImageUrl
        ? new URL(item.listingImageUrl, baseUrl).toString()
        : null;
    } catch {
      listingImageUrl = null;
    }

    const label = item.title || item.text || "";
    dedup.set(full, {
      episodeUrl: full,
      title: label || null,
      seriesName: parseSeriesName(label || full),
      episodeNumber: parseEpisodeNumber(item.text || item.title || ""),
      listingImageUrl
    });
    if (dedup.size >= maxCount) break;
  }

  // Fallback for mirrors/CDN variants where client-side rendering or anti-bot
  // behavior prevents anchor nodes from being visible to DOM queries. If we
  // found nothing via DOM selectors, parse raw HTML and recover episode links.
  if (dedup.size === 0) {
    const html = await page.content();
    const rx = /href\s*=\s*["']([^"']*\/episode\/[^"']*)["']/gi;
    let match;
    while ((match = rx.exec(html)) && dedup.size < maxCount) {
      const href = match[1];
      if (!href) continue;
      let full = null;
      try {
        full = new URL(href, baseUrl).toString();
      } catch {
        full = null;
      }
      if (!full || dedup.has(full)) continue;
      dedup.set(full, {
        episodeUrl: full,
        title: null,
        seriesName: parseSeriesName(full),
        episodeNumber: parseEpisodeNumber(full),
        listingImageUrl: null
      });
    }
  }
  return Array.from(dedup.values());
}

function extractSlugFromEpisodeUrl(episodeUrl) {
  try {
    const u = new URL(episodeUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const raw = parts[parts.length - 1] || null;
    return raw ? decodeURIComponent(raw) : null;
  } catch {
    return null;
  }
}

function extractDailymotionVideoId(url) {
  const match = String(url).match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

function detectPlayerProvider(url) {
  const value = String(url || "").toLowerCase();
  const providers = [
    { name: "dailymotion", match: /dailymotion\.com/ },
    { name: "okru", match: /ok\.ru|odnoklassniki\.ru/ },
    { name: "streamtape", match: /streamtape\.com/ },
    { name: "uqload", match: /uqload\.(com|co)/ },
    { name: "voe", match: /voe\.sx|voe-unblock/ },
    { name: "vidbom", match: /vidbom\./ },
    { name: "yourupload", match: /yourupload\./ },
    { name: "filemoon", match: /filemoon\./ },
    { name: "sibnet", match: /sibnet\./ }
  ];
  const found = providers.find((p) => p.match.test(value));
  return found ? found.name : null;
}

/**
 * The source site embeds an aggregator iframe whose query string contains a
 * base64-encoded list of direct server candidates. We decode it during crawl
 * ONLY to extract that server list — the aggregator itself is never stored,
 * referenced, or used for playback.
 */
function isSourceAggregatorUrl(url) {
  return /qesen\.net\/krmzi/i.test(String(url || ""));
}

function decodeSourceAggregatorServers(url) {
  try {
    const u = new URL(url);
    const post = u.searchParams.get("post");
    if (!post) return [];
    const normalized =
      post.includes("-") || post.includes("_") ? post.replace(/-/g, "+").replace(/_/g, "/") : post;
    const padded =
      normalized.length % 4 === 0 ? normalized : normalized + "=".repeat(4 - (normalized.length % 4));
    const raw = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    return Array.isArray(parsed.servers)
      ? parsed.servers.map((s) => ({ name: s?.name || null, id: s?.id || null }))
      : [];
  } catch {
    return [];
  }
}

function canonicalizePlayerUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function extractPlayerMetadata(url) {
  const canonicalUrl = canonicalizePlayerUrl(url);
  const aggregatorServers = isSourceAggregatorUrl(canonicalUrl)
    ? decodeSourceAggregatorServers(canonicalUrl)
    : [];
  // Aggregator is never exposed as a public provider.
  const provider = isSourceAggregatorUrl(canonicalUrl)
    ? null
    : detectPlayerProvider(canonicalUrl);
  const dailymotionId = extractDailymotionVideoId(canonicalUrl);
  const dmFromAggregator = aggregatorServers.find(
    (s) => String(s.name || "").toLowerCase() === "dailymotion"
  );

  return {
    provider,
    videoId: dailymotionId || dmFromAggregator?.id || null,
    servers: aggregatorServers
  };
}

function buildServerCandidateUrls(server) {
  const sourceId = server?.id || null;
  const sourceName = String(server?.name || "").toLowerCase();
  const out = [];

  if (typeof sourceId === "string" && /^https?:\/\//i.test(sourceId)) {
    out.push(sourceId);
  }

  if (sourceName === "dailymotion" && sourceId) {
    out.push(`https://www.dailymotion.com/video/${sourceId}`);
    out.push(`https://www.dailymotion.com/embed/video/${sourceId}`);
  }
  if (sourceName === "ok" && sourceId) {
    out.push(`https://m.ok.ru/video/${sourceId}`);
    out.push(`https://ok.ru/videoembed/${sourceId}`);
    out.push(`https://ok.ru/video/${sourceId}`);
    out.push(`https://ok.ru/live/${sourceId}`);
  }
  if (sourceName === "arab hd" && sourceId) {
    out.push(`https://arabhd.onl/embed-${sourceId}.html`);
  }
  if (sourceName === "pro hd" && sourceId) {
    out.push(`https://larhu.website/embed-${sourceId}.html`);
  }
  if (sourceName === "estream" && sourceId) {
    out.push(`https://arabveturk.com/embed-${sourceId}.html`);
  }
  if (sourceName === "red hd" && sourceId) {
    out.push(`https://iplayerhls.com/e/${sourceId}`);
    out.push(`https://iplayerhls.com/embed-${sourceId}.html`);
  }

  return out;
}

/**
 * Resolve a server list into direct embed/watch URL candidates.
 * @param {string|null} playerUrl Legacy URL input (ignored if options.servers given).
 * @param {string|null} serverQuery Optional name/id filter.
 * @param {{servers?: Array, preferDirect?: boolean}} [options]
 *   Pass `servers` to resolve purely from a prebuilt list (no URL needed).
 */
function resolveServerCandidates(playerUrl, serverQuery, options = {}) {
  const explicitServers = Array.isArray(options.servers) ? options.servers : null;
  const meta = explicitServers
    ? { provider: null, servers: explicitServers, videoId: null }
    : extractPlayerMetadata(playerUrl);

  const query = String(serverQuery || "").toLowerCase().trim();
  const preferredDefault =
    meta.servers.find((s) => String(s.name || "").toLowerCase() === "dailymotion") || null;
  const selected = query
    ? meta.servers.find(
        (s) =>
          String(s.name || "").toLowerCase() === query ||
          String(s.id || "").toLowerCase() === query
      ) || null
    : null;

  const chosen = selected || preferredDefault || meta.servers[0] || null;
  const candidates = chosen ? buildServerCandidateUrls(chosen) : [];

  return {
    provider: meta.provider,
    servers: meta.servers,
    selectedServer: chosen,
    candidates: Array.from(new Set(candidates))
  };
}

/**
 * Parse the first `url(...)` from a CSS `background` / `background-image` value
 * (e.g. krmzi episode poster: .posterThumb .imgBg style).
 */
function extractBackgroundImageUrlFromStyle(style) {
  if (!style || typeof style !== "string") return null;
  const m = /url\s*\(\s*["']?([^'")]+?)["']?\s*\)/i.exec(style);
  return m ? m[1].trim() : null;
}

/**
 * Only persist episode-poster URLs from the configured source site WordPress media library.
 * Drops qesen, player gifs, theme assets, other hosts.
 * @param {string} url
 * @param {string} [allowedHostOrBase] e.g. "https://krmzy.com" or "krmzy.com" (defaults to SOURCE_BASE_URL env).
 */
// Known mirror hosts used by the source site family. Images are often served
// from the old/legacy CDN even when the main domain has migrated (e.g. the
// listing at krmzy.com still points poster thumbs at krmzi.onl). We accept any
// of these hosts so mirrored posters are preserved.
const ALLOWED_IMAGE_HOST_SUFFIXES = ["krmzi.onl", "krmzy.com", "krmzi.org", "krmzi.com"];

function hostIsAllowedImageMirror(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  return ALLOWED_IMAGE_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

function sanitizeStoredEpisodeImageUrl(url, allowedHostOrBase) {
  if (url == null || url === "") return null;
  if (typeof url !== "string") return null;
  const t = url.trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (low.includes("qesen.net")) return null; // aggregator; never used as an image source
  if (low.includes("gotoplay")) return null;
  if (low.includes("dmxleo.com") || (low.includes("dailymotion.com") && /\.(gif|jpe?g|png|webp)/i.test(t))) {
    return null;
  }
  if (low.includes("dmcdn.")) return null;
  if (/\/wp-content\/themes\//i.test(t)) return null;
  if (/\.gif(\?|#|$|&)/i.test(t)) return null;
  if (/logo|favicon|gravatar|spinner|placeholder|pixel|emoji|avatar/i.test(low)) return null;
  let u;
  try {
    u = new URL(t);
  } catch {
    return null;
  }

  const p = u.pathname.toLowerCase();
  if (!p.includes("/wp-content/uploads/")) return null;

  // If caller passed an explicit host hint, honor it; otherwise accept any of
  // the known mirror hosts. Fall through to accept when SOURCE_BASE_URL isn't
  // usable, since the path check above already gates this to WP uploads only.
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (allowedHostOrBase) {
    let hintedHost = "";
    try {
      hintedHost = allowedHostOrBase.includes("://")
        ? new URL(allowedHostOrBase).hostname
        : allowedHostOrBase;
    } catch {
      hintedHost = "";
    }
    hintedHost = (hintedHost || "").toLowerCase().replace(/^www\./, "");
    if (hintedHost && host !== hintedHost) return null;
    return t;
  }

  if (!hostIsAllowedImageMirror(host)) return null;
  return t;
}

module.exports = {
  normalizeUrl,
  parseEpisodeLinks,
  parseEpisodeNumber,
  parseSeriesName,
  extractSlugFromEpisodeUrl,
  extractDailymotionVideoId,
  detectPlayerProvider,
  canonicalizePlayerUrl,
  extractPlayerMetadata,
  resolveServerCandidates,
  buildServerCandidateUrls,
  extractBackgroundImageUrlFromStyle,
  sanitizeStoredEpisodeImageUrl,
  isSourceAggregatorUrl,
  decodeSourceAggregatorServers
};

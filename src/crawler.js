const { chromium } = require("playwright");
const {
  parseEpisodeLinks,
  extractSlugFromEpisodeUrl,
  parseSeriesName,
  extractDailymotionVideoId,
  detectPlayerProvider,
  extractPlayerMetadata,
  canonicalizePlayerUrl,
  sanitizeStoredEpisodeImageUrl,
  isSourceAggregatorUrl
} = require("./parser");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function crawlDebugEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.CRAWL_DEBUG || "").toLowerCase()
  );
}

async function humanPause(config) {
  await sleep(randomInt(config.minDelayMs, config.maxDelayMs));
}

async function extractEpisodeImageFromPage(page, baseUrl) {
  try {
    return await page.evaluate((base) => {
      function absUrl(val) {
        if (!val || typeof val !== "string") return null;
        const trimmed = val.trim().split(/\s+/)[0];
        if (!trimmed || trimmed.startsWith("data:")) return null;
        try {
          return new URL(trimmed, base).href;
        } catch {
          return null;
        }
      }

      // Accept posters from any of the known site mirrors. The listing at
      // krmzy.com frequently links images to krmzi.onl (legacy CDN), so we
      // cannot restrict to the current page's host alone.
      const MIRROR_HOSTS = ["krmzi.onl", "krmzy.com", "krmzi.org", "krmzi.com"];
      function hostMatchesSite(href) {
        try {
          const pageHost = new URL(base).hostname.replace(/^www\./i, "");
          const uHost = new URL(href).hostname.replace(/^www\./i, "");
          if (uHost === pageHost) return true;
          return MIRROR_HOSTS.some((h) => uHost === h || uHost.endsWith(`.${h}`));
        } catch {
          return false;
        }
      }

      function isKrmziWpMediaUploads(href) {
        try {
          const u = new URL(href);
          if (!hostMatchesSite(href)) return false;
          const p = u.pathname.toLowerCase();
          if (!p.includes("/wp-content/uploads/")) return false;
          if (p.includes("/wp-content/themes/")) return false;
          return true;
        } catch {
          return false;
        }
      }

      // Player embeds, off-site CDNs, theme "go to play" gifs, etc. — never use as episode poster
      function isJunkOrPlayerAsset(href) {
        if (!href) return true;
        const h = href.toLowerCase();
        if (h.includes("qesen.net")) return true;
        if (h.includes("gotoplay")) return true;
        if ((h.includes("dmxleo.com") || h.includes("dailymotion.com")) && /\.(gif|jpe?g|png|webp)/i.test(h)) {
          return true;
        }
        if (/\/wp-content\/themes\//i.test(href)) return true;
        if (/\/pages\/assets\/.*\.gif/i.test(h)) return true;
        if (h.endsWith(".gif") || h.includes(".gif?")) {
          if (!isKrmziWpMediaUploads(href)) return true;
        }
        if (/logo|favicon|gravatar|emoji|spinner|loading|placeholder|pixel\.gif/i.test(h)) return true;
        return false;
      }

      function scoreImageUrl(href) {
        if (!href) return -9999;
        let s = 0;
        if (isKrmziWpMediaUploads(href)) s += 200;
        if (/-uzun\.(jpe?g|png|webp)(\?|$)/i.test(href)) s += 40;
        if (/\/wp-content\/uploads\/\d{4}\/\d{2}\//i.test(href)) s += 30;
        if (/-\d{2,4}x\d{2,4}\.(jpe?g|png|webp)(\?|$)/i.test(href)) {
          const m = href.match(/-(\d+)x(\d+)\.(jpe?g|png|webp)/i);
          if (m) {
            const w = Number(m[1]);
            const h = Number(m[2]);
            if (w <= 300 && h <= 300) s -= 50;
            else if (w < 500) s -= 15;
          }
        }
        if (/\.svg(\?|$)/i.test(href)) s -= 500;
        return s;
      }

      // KRMZI episode page: <div class="posterThumb"><div class="imgBg" style="background-image:url(...);">
      function urlFromCssBackgroundImage(style) {
        if (!style || typeof style !== "string") return null;
        const m = /url\s*\(\s*["']?([^'")]+?)["']?\s*\)/i.exec(style);
        if (!m) return null;
        return absUrl(m[1].trim());
      }

      function maybePosterThumbImgBg() {
        const nodes = document.querySelectorAll(".posterThumb .imgBg, .posterThumb .imgbg");
        for (const node of nodes) {
          const st = node.getAttribute("style");
          if (!st) continue;
          const u = urlFromCssBackgroundImage(st);
          if (u && isKrmziWpMediaUploads(u) && !isJunkOrPlayerAsset(u)) return u;
        }
        return null;
      }

      function maybeMetaOgImage() {
        const sels = [
          'meta[property="og:image"]',
          'meta[property="og:image:url"]',
          'meta[property="og:image:secure_url"]',
          'meta[name="twitter:image"]',
          'meta[name="twitter:image:src"]'
        ];
        for (const sel of sels) {
          const r = absUrl(document.querySelector(sel)?.getAttribute("content"));
          if (r && isKrmziWpMediaUploads(r) && !isJunkOrPlayerAsset(r)) return r;
        }
        return null;
      }

      const fromPoster = maybePosterThumbImgBg();
      if (fromPoster) return fromPoster;

      const fromMeta = maybeMetaOgImage();
      if (fromMeta) return fromMeta;

      const candidates = new Set();

      const addCandidate = (u) => {
        if (!u || isJunkOrPlayerAsset(u)) return;
        candidates.add(u);
      };

      const pushFromSrcset = (ss) => {
        if (!ss) return;
        for (const part of String(ss).split(",")) {
          const url = part.trim().split(/\s+/)[0];
          const r = absUrl(url);
          if (r) addCandidate(r);
        }
      };

      const linkImage = document.querySelector('link[rel="image_src"]');
      const fromLink = absUrl(linkImage?.getAttribute("href"));
      if (fromLink) addCandidate(fromLink);

      const imgQuery = [
        "article img",
        ".entry-content img",
        ".post-content img",
        "img.wp-post-image",
        ".attachment-post-thumbnail img",
        ".thumbnail img",
        ".featured-image img",
        ".entry-thumbnail img",
        "figure img"
      ]
        .join(", ");

      for (const img of document.querySelectorAll(imgQuery)) {
        for (const attr of ["src", "data-src", "data-lazy-src", "data-original"]) {
          const r = absUrl(img.getAttribute(attr));
          if (r) addCandidate(r);
        }
        pushFromSrcset(img.getAttribute("srcset"));
        pushFromSrcset(img.getAttribute("data-srcset"));
      }

      for (const s of document.querySelectorAll("picture source")) {
        pushFromSrcset(s.getAttribute("srcset"));
      }

      const fromUploads = [...candidates].filter((h) => isKrmziWpMediaUploads(h) && !isJunkOrPlayerAsset(h));
      if (fromUploads.length === 0) return null;
      return fromUploads.sort((a, b) => scoreImageUrl(b) - scoreImageUrl(a))[0];
    }, baseUrl);
  } catch {
    return null;
  }
}

async function runHumanInteractions(page, config, options = {}) {
  const { maxBudgetMs = 2000, alreadyHavePlayer = () => false } = options;
  const deadline = Date.now() + maxBudgetMs;
  const budgetLeft = () => Math.max(0, deadline - Date.now());

  // Highest-signal targets first: clicking the poster is what actually triggers
  // the qesen iframe to load on krmzy/krmzi episode pages.
  const clickCandidates = [
    ".posterThumb",
    ".posterThumb .imgBg",
    ".play-button",
    "button:has-text('تشغيل')"
  ];

  for (const selector of clickCandidates) {
    if (alreadyHavePlayer() || budgetLeft() < 200) break;
    const loc = page.locator(selector).first();
    if (await loc.count().catch(() => 0)) {
      try {
        await loc.click({ timeout: Math.min(500, budgetLeft()), force: true });
        break; // one real click is enough; the network listener takes over
      } catch {
        // Try the next candidate
      }
    }
  }
}

function isPlayableCandidate(url) {
  const value = String(url || "").toLowerCase();
  if (!value.startsWith("http")) return false;
  if (/\.(css|js|png|jpg|jpeg|svg|gif|webp|ico|woff2?|ttf)(\?|$)/.test(value)) {
    return false;
  }
  if (value.includes("/episode/") || value.includes("/series/") || value.includes("/tag/")) {
    return false;
  }
  // We admit the source's aggregator URL here (qesen\.net\/krmzi) only so the
  // crawler can capture its payload and extract the direct server list from it.
  // The aggregator URL itself is never stored or used for playback downstream.
  return (
    Boolean(detectPlayerProvider(value)) ||
    /(embed|player|watch|video|qesen\.net\/krmzi)/.test(value)
  );
}

function buildPageUrl(baseUrl, listPath, pageNumber) {
  const base = new URL(listPath || "/", baseUrl);
  if (pageNumber <= 1) return base.toString();
  const trimmed = base.pathname.replace(/\/+$/, "");
  base.pathname = `${trimmed}/page/${pageNumber}/`;
  return base.toString();
}

function buildMirrorBaseCandidates(baseUrl) {
  const known = ["https://krmzy.com", "https://krmzi.onl", "https://krmzi.org", "https://krmzi.com"];
  const normalized = [];
  const push = (u) => {
    try {
      const n = new URL(u).origin;
      if (!normalized.includes(n)) normalized.push(n);
    } catch {
      // ignore invalid candidate
    }
  };
  push(baseUrl);
  for (const item of known) push(item);
  return normalized;
}

async function gotoListingPageWithFallback(page, appConfig, pageNumber, activeBaseUrl, logger) {
  const candidates = buildMirrorBaseCandidates(activeBaseUrl);
  const tried = new Set();
  let lastError = null;

  for (const candidateBase of candidates) {
    if (tried.has(candidateBase)) continue;
    tried.add(candidateBase);

    const pageUrl = buildPageUrl(candidateBase, appConfig.source.listPath, pageNumber);
    try {
      const response = await page.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: appConfig.source.navigationTimeoutMs
      });
      return { response, pageUrl, activeBaseUrl: candidateBase };
    } catch (err) {
      lastError = err;
      if (logger?.warn) {
        logger.warn("listing_page_load_failed", {
          pageUrl,
          candidateBase,
          pageNumber,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  throw lastError || new Error(`Unable to load listing page ${pageNumber}`);
}

function normalizeSeriesTitle(value) {
  return parseSeriesName(value) || "";
}

async function extractSeriesEpisodesFromPage(page, episodeUrl) {
  const currentTitle = await page
    .locator("h1")
    .first()
    .textContent({ timeout: 1000 })
    .catch(() => "");
  const seriesKey = normalizeSeriesTitle(
    currentTitle || extractSlugFromEpisodeUrl(episodeUrl)
  );
  const allLinks = await parseEpisodeLinks(page, episodeUrl, 300);
  const deduped = [];
  const seen = new Set();

  for (const item of allLinks) {
    if (!item.episodeUrl || seen.has(item.episodeUrl)) continue;
    const itemKey = normalizeSeriesTitle(
      item.title || extractSlugFromEpisodeUrl(item.episodeUrl)
    );
    if (seriesKey && itemKey && itemKey !== seriesKey) continue;
    seen.add(item.episodeUrl);
    deduped.push({
      title: item.title || itemKey || null,
      seriesName: item.seriesName || itemKey || null,
      episodeUrl: item.episodeUrl,
      slug: extractSlugFromEpisodeUrl(item.episodeUrl),
      episodeNumber: item.episodeNumber ?? null,
      imageUrl: sanitizeStoredEpisodeImageUrl(item.listingImageUrl)
    });
  }

  return deduped.sort((a, b) => {
    const an = Number.isFinite(a.episodeNumber) ? a.episodeNumber : -1;
    const bn = Number.isFinite(b.episodeNumber) ? b.episodeNumber : -1;
    return bn - an;
  });
}

function urlKey(value) {
  try {
    const u = new URL(value);
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Keep the URL parser's normalized path if decoding fails.
    }
    const normalizedPath = pathname.replace(/\/+$/, "");
    return `${u.origin.toLowerCase()}${normalizedPath}${u.search}`;
  } catch {
    return String(value || "");
  }
}

function seriesChainKey(seriesEpisodes) {
  if (!Array.isArray(seriesEpisodes) || seriesEpisodes.length === 0) return null;
  const urls = seriesEpisodes.map((ep) => urlKey(ep.episodeUrl)).filter(Boolean).sort();
  return urls.length ? urls.join("|") : null;
}

function mergeHydratedSeriesEpisode(baseEpisode, resolvedEpisode) {
  return {
    ...baseEpisode,
    seriesName: baseEpisode.seriesName || resolvedEpisode.seriesName || null,
    videoUrl: resolvedEpisode.videoUrl || null,
    videoId: resolvedEpisode.videoId || null,
    playerProvider: resolvedEpisode.playerProvider || null,
    playerServers: Array.isArray(resolvedEpisode.playerServers)
      ? resolvedEpisode.playerServers
      : [],
    imageUrl:
      sanitizeStoredEpisodeImageUrl(resolvedEpisode.imageUrl) ||
      sanitizeStoredEpisodeImageUrl(baseEpisode.imageUrl)
  };
}

async function hasPaginationForNext(page, nextPageNumber) {
  return page.evaluate((nextN) => {
    const anchors = Array.from(document.querySelectorAll('.pagination a[href*="/page/"]'));
    if (!anchors.length) return false;
    const pageNumbers = anchors
      .map((a) => {
        const m = a.getAttribute("href") && a.getAttribute("href").match(/\/page\/(\d+)\/?/);
        return m ? Number(m[1]) : null;
      })
      .filter((n) => Number.isFinite(n));
    if (!pageNumbers.length) return false;
    const maxN = Math.max(...pageNumbers);
    return nextN <= maxN;
  }, nextPageNumber);
}

async function crawlListingPage(page, appConfig, logger) {
  const maxEpisodes = appConfig.source.maxEpisodesPerRun;
  const maxPages = appConfig.source.maxListPages;
  const aggregated = new Map();
  const debug = crawlDebugEnabled();
  let activeBaseUrl = appConfig.source.baseUrl;

  for (let pageN = 1; pageN <= maxPages && aggregated.size < maxEpisodes; pageN += 1) {
    const nav = await gotoListingPageWithFallback(page, appConfig, pageN, activeBaseUrl, logger);
    let pageUrl = nav.pageUrl;
    let response = nav.response;
    activeBaseUrl = nav.activeBaseUrl;
    await humanPause(appConfig.crawler);

    if (logger && debug) {
      const html = await page.content().catch(() => "");
      const evalInfo = await page
        .evaluate(() => ({
          title: document.title || "",
          hrefCount: document.querySelectorAll("a[href]").length,
          episodeHrefCount: document.querySelectorAll("a[href*='/episode/']").length,
          bodyTextSample: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 180)
        }))
        .catch(() => ({
          title: "",
          hrefCount: -1,
          episodeHrefCount: -1,
          bodyTextSample: ""
        }));

      logger.info("listing_page_debug", {
        pageUrl,
        requestedHost: new URL(pageUrl).host,
        finalUrl: page.url(),
        finalHost: (() => {
          try {
            return new URL(page.url()).host;
          } catch {
            return null;
          }
        })(),
        responseStatus: response ? response.status() : null,
        responseOk: response ? response.ok() : null,
        contentLength: html.length,
        title: evalInfo.title,
        hrefCount: evalInfo.hrefCount,
        episodeHrefCount: evalInfo.episodeHrefCount,
        bodyTextSample: evalInfo.bodyTextSample
      });
    }

    const remaining = maxEpisodes - aggregated.size;
    let items = await parseEpisodeLinks(page, activeBaseUrl, Math.max(remaining * 4, remaining));

    // If the first listing page is empty, probe known mirrors automatically.
    if (items.length === 0 && pageN === 1) {
      const candidates = buildMirrorBaseCandidates(activeBaseUrl).filter(
        (candidate) => candidate !== new URL(activeBaseUrl).origin
      );
      for (const candidateBase of candidates) {
        const candidateUrl = buildPageUrl(candidateBase, appConfig.source.listPath, pageN);
        const candidateResponse = await page.goto(candidateUrl, {
          waitUntil: "domcontentloaded",
          timeout: appConfig.source.navigationTimeoutMs
        });
        await humanPause(appConfig.crawler);
        const candidateItems = await parseEpisodeLinks(
          page,
          candidateBase,
          Math.max(remaining * 4, remaining)
        );

        if (logger) {
          logger.info("listing_mirror_probe", {
            fromBase: activeBaseUrl,
            candidateBase,
            candidateUrl,
            status: candidateResponse ? candidateResponse.status() : null,
            found: candidateItems.length
          });
        }

        if (candidateItems.length > 0) {
          activeBaseUrl = candidateBase;
          pageUrl = candidateUrl;
          items = candidateItems;
          break;
        }
      }
    }
    const before = aggregated.size;
    for (const it of items) {
      const key = it.seriesName || normalizeSeriesTitle(it.title || it.episodeUrl) || it.episodeUrl;
      if (!aggregated.has(key)) aggregated.set(key, it);
      if (aggregated.size >= maxEpisodes) break;
    }

    if (logger) {
      logger.info("list_page_scanned", {
        pageUrl,
        pageFound: items.length,
        newlyAdded: aggregated.size - before,
        totalAggregated: aggregated.size
      });
    }

    if (aggregated.size >= maxEpisodes) break;
    if (items.length === 0) break; // page returned zero items => stop
    const hasNext = await hasPaginationForNext(page, pageN + 1);
    if (!hasNext) break;
  }

  return Array.from(aggregated.values());
}

async function resolveEpisodeVideo(
  page,
  episodeUrl,
  appConfig,
  listingImageUrl = null,
  options = {}
) {
  const includeSeriesEpisodes = options.includeSeriesEpisodes !== false;
  const candidates = [];
  const seen = new Set();
  let playerCandidateResolver = null;
  const playerCandidateSignal = new Promise((resolve) => {
    playerCandidateResolver = resolve;
  });
  const addCandidate = (url, source) => {
    if (!isPlayableCandidate(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    const provider = detectPlayerProvider(url);
    const aggregator = isSourceAggregatorUrl(url);
    candidates.push({ url, source, provider, aggregator });
    // Wake early if we see either a direct provider URL or the source aggregator
    // (we still read the aggregator's payload internally to get the server list).
    if ((provider || aggregator) && playerCandidateResolver) {
      const r = playerCandidateResolver;
      playerCandidateResolver = null;
      r();
    }
  };

  const trackRequest = (req) => addCandidate(req.url(), "request");
  const trackResponse = (res) => addCandidate(res.url(), "response");
  const onPopup = (popup) => {
    addCandidate(popup.url(), "popup");
    popup.on("request", (req) => addCandidate(req.url(), "popup_request"));
    popup.on("response", (res) => addCandidate(res.url(), "popup_response"));
  };

  page.on("request", trackRequest);
  page.on("response", trackResponse);
  page.on("popup", onPopup);

  const hasPlayerCandidate = () =>
    candidates.some((c) => c.provider || c.aggregator);

  try {
    const tStart = Date.now();
    await page.goto(episodeUrl, {
      waitUntil: "domcontentloaded",
      timeout: appConfig.source.navigationTimeoutMs
    });
    const tAfterGoto = Date.now();

    // Prefer the poster URL extracted from the listing card; fall back to episode-page extraction.
    const listingImage = sanitizeStoredEpisodeImageUrl(listingImageUrl) || null;
    let imageUrl = listingImage;
    if (!imageUrl) {
      try {
        await page.waitForSelector(".posterThumb .imgBg", { state: "attached", timeout: 4000 });
      } catch {
        // Best-effort; fallbacks handle missing markup
      }
      const rawImage = await extractEpisodeImageFromPage(page, episodeUrl);
      imageUrl = sanitizeStoredEpisodeImageUrl(rawImage) || null;
    }
    const tAfterImage = Date.now();
    const seriesEpisodes = includeSeriesEpisodes
      ? await extractSeriesEpisodesFromPage(page, episodeUrl)
      : [];

    // Some pages auto-load the iframe on DOMContentLoaded; give it a tiny head start.
    if (!hasPlayerCandidate()) {
      await Promise.race([playerCandidateSignal, sleep(400)]);
    }
    const tAfterWaitReq = Date.now();

    // Most krmzy/krmzi pages are lazy: clicking the poster is what triggers the
    // qesen iframe load. Do that, then wait for the player request to arrive.
    if (!hasPlayerCandidate()) {
      await runHumanInteractions(page, appConfig.crawler, {
        maxBudgetMs: 1500,
        alreadyHavePlayer: hasPlayerCandidate
      });
      if (!hasPlayerCandidate()) {
        await Promise.race([playerCandidateSignal, sleep(2500)]);
      }
    }
    const tAfterInteract = Date.now();

    addCandidate(page.url(), "page_url");

    for (const frame of page.frames()) {
      addCandidate(frame.url(), "frame_url");
    }

    // Skip the heavy DOM sweeps if we already have a valid player candidate.
    if (!hasPlayerCandidate()) {
      const hrefs = await page.$$eval("a[href]", (anchors) =>
        anchors.map((a) => a.href).filter(Boolean)
      );
      for (const href of hrefs) addCandidate(href, "anchor_href");

      const srcs = await page.$$eval("[src]", (nodes) =>
        nodes.map((n) => n.getAttribute("src")).filter(Boolean)
      );
      for (const src of srcs) addCandidate(src, "element_src");
    }
    const tEnd = Date.now();

    if (process.env.CRAWL_TIMINGS === "1") {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          episodeUrl,
          ms: {
            total: tEnd - tStart,
            goto: tAfterGoto - tStart,
            image: tAfterImage - tAfterGoto,
            waitPlayerReq: tAfterWaitReq - tAfterImage,
            interact: tAfterInteract - tAfterWaitReq,
            domSweep: tEnd - tAfterInteract
          },
          haveImage: Boolean(imageUrl),
          havePlayer: hasPlayerCandidate()
        })
      );
    }

    // Prefer a direct playable candidate; the source aggregator is only used
    // internally to extract the server list, never stored or played back.
    const directCandidate =
      candidates.find((c) => c.provider) ||
      candidates.find((c) => !c.aggregator && /(embed|player|watch|video)/i.test(c.url)) ||
      null;
    const aggregatorCandidate = candidates.find((c) => c.aggregator) || null;

    const aggregatorMeta = aggregatorCandidate
      ? extractPlayerMetadata(aggregatorCandidate.url)
      : null;
    const servers = aggregatorMeta?.servers || [];

    const directUrl = directCandidate ? canonicalizePlayerUrl(directCandidate.url) : null;
    const dailymotionFromAggregator = aggregatorMeta?.videoId
      ? `https://www.dailymotion.com/video/${aggregatorMeta.videoId}`
      : null;

    const videoUrl = directUrl || dailymotionFromAggregator || null;
    const videoId =
      (directCandidate && extractDailymotionVideoId(directCandidate.url)) ||
      aggregatorMeta?.videoId ||
      null;
    const playerProvider =
      directCandidate?.provider ||
      (dailymotionFromAggregator ? "dailymotion" : null);

    return {
      episodeUrl,
      videoUrl,
      videoId,
      playerProvider,
      playerServers: servers,
      imageUrl,
      seriesEpisodes
    };
  } finally {
    page.off("request", trackRequest);
    page.off("response", trackResponse);
    page.off("popup", onPopup);
  }
}

async function extractSeriesEpisodeList(page, seriesRef, appConfig) {
  if (!seriesRef?.latestEpisodeUrl) return [];
  await page.goto(seriesRef.latestEpisodeUrl, {
    waitUntil: "domcontentloaded",
    timeout: appConfig.source.navigationTimeoutMs
  });
  return extractSeriesEpisodesFromPage(page, seriesRef.latestEpisodeUrl);
}

function knownForSeries(knownSeries, seriesName) {
  const bySeries = knownSeries?.episodesBySeries || {};
  return bySeries[seriesName] || { episodeUrls: [], episodeNumbers: [] };
}

function isKnownSeriesEpisode(item, known) {
  if (!item) return false;
  const urls = new Set((known.episodeUrls || []).map((u) => urlKey(u)));
  const nums = new Set(
    (known.episodeNumbers || [])
      .filter((n) => Number.isFinite(n))
      .map((n) => Number(n))
  );
  if (item.episodeUrl && urls.has(urlKey(item.episodeUrl))) return true;
  if (Number.isFinite(item.episodeNumber) && nums.has(Number(item.episodeNumber))) return true;
  return false;
}

async function hydrateSeriesEpisodes(
  page,
  parentEpisode,
  resolvedEpisode,
  appConfig,
  logger,
  options = {}
) {
  const basicChain = Array.isArray(resolvedEpisode.seriesEpisodes)
    ? resolvedEpisode.seriesEpisodes
    : [];
  if (basicChain.length === 0) return [];

  const hydrated = [];
  const currentKey = urlKey(parentEpisode.episodeUrl);
  const knownEpisodeUrls = options.knownEpisodeUrls instanceof Set
    ? options.knownEpisodeUrls
    : new Set();
  const knownEpisodeNumbers = options.knownEpisodeNumbers instanceof Set
    ? options.knownEpisodeNumbers
    : new Set();

  for (const item of basicChain) {
    if (!item?.episodeUrl) continue;
    const itemKey = urlKey(item.episodeUrl);
    if (itemKey === currentKey) {
      hydrated.push(mergeHydratedSeriesEpisode(item, resolvedEpisode));
      continue;
    }
    if (knownEpisodeUrls.has(itemKey)) {
      hydrated.push(item);
      continue;
    }
    if (Number.isFinite(item.episodeNumber) && knownEpisodeNumbers.has(Number(item.episodeNumber))) {
      hydrated.push(item);
      continue;
    }

    try {
      const itemResolved = await withRetry(
        async (attempt) => {
          logger.info("resolving_series_episode", {
            episodeUrl: item.episodeUrl,
            parentEpisodeUrl: parentEpisode.episodeUrl,
            attempt
          });
          return resolveEpisodeVideo(
            page,
            item.episodeUrl,
            appConfig,
            item.imageUrl || null,
            { includeSeriesEpisodes: false }
          );
        },
        appConfig.crawler.retries
      );
      hydrated.push(mergeHydratedSeriesEpisode(item, itemResolved));
      await humanPause(appConfig.crawler);
    } catch (err) {
      if (logger?.warn) {
        logger.warn("series_episode_resolve_failed", {
          episodeUrl: item.episodeUrl,
          parentEpisodeUrl: parentEpisode.episodeUrl,
          message: err instanceof Error ? err.message : String(err)
        });
      }
      hydrated.push(item);
    }
  }

  return hydrated;
}

async function withRetry(fn, retries, logger) {
  let lastError = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      return await fn(i + 1);
    } catch (err) {
      lastError = err;
      if (logger?.warn && i + 1 < retries) {
        logger.warn("retry_attempt_failed", {
          attempt: i + 1,
          remaining: retries - i - 1,
          ...crawlerErrorMeta(err)
        });
      }
    }
  }
  throw lastError;
}

async function runCrawl(appConfig, logger, options = {}) {
  const browser = await chromium.launch({ headless: appConfig.crawler.headless });
  const context = await browser.newContext({
    locale: "ar",
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  try {
    const episodes = options.singleEpisodeUrl
      ? [
          {
            episodeUrl: options.singleEpisodeUrl,
            title: null,
            episodeNumber: null
          }
        ]
      : await crawlListingPage(page, appConfig, logger);
    logger.info("discovered_episodes", { count: episodes.length });
    const results = [];
    const hydratedChains = new Map();
    const knownSeriesNames = new Set(options.knownSeries?.seriesNames || []);
    const knownEpisodeUrls = new Set(
      (options.knownSeries?.episodeUrls || []).map((u) => urlKey(u))
    );

    for (const episode of episodes) {
      const seriesName =
        episode.seriesName || normalizeSeriesTitle(episode.title || episode.episodeUrl);
      const knownSeries = seriesName && knownSeriesNames.has(seriesName);
      const listingEpisodeKnown = knownEpisodeUrls.has(urlKey(episode.episodeUrl));
      if (knownSeries && listingEpisodeKnown) {
        logger.info("skipping_known_series_episode", {
          seriesName,
          episodeUrl: episode.episodeUrl
        });
        continue;
      }

      const resolved = await withRetry(
        async (attempt) => {
          logger.info("resolving_episode", {
            episodeUrl: episode.episodeUrl,
            attempt
          });
          return resolveEpisodeVideo(
            page,
            episode.episodeUrl,
            appConfig,
            episode.listingImageUrl || null,
            { includeSeriesEpisodes: true }
          );
        },
        appConfig.crawler.retries
      );

      const chainKey = seriesChainKey(resolved.seriesEpisodes);
      if (chainKey) {
        if (hydratedChains.has(chainKey)) {
          resolved.seriesEpisodes = hydratedChains.get(chainKey);
        } else {
          resolved.seriesEpisodes = await hydrateSeriesEpisodes(
            page,
            episode,
            resolved,
            appConfig,
            logger,
            { knownEpisodeUrls: knownSeries ? knownEpisodeUrls : new Set() }
          );
          hydratedChains.set(chainKey, resolved.seriesEpisodes);
        }
      }

      results.push({ ...episode, ...resolved });
      await humanPause(appConfig.crawler);
    }
    return results;
  } finally {
    await context.close();
    await browser.close();
  }
}

function crawlerErrorMeta(err) {
  if (!err) return { error: "unknown" };
  if (err instanceof Error) {
    return {
      error: err.message,
      name: err.name,
      stack: err.stack ? String(err.stack).split("\n").slice(0, 6).join("\n") : null
    };
  }
  return { error: String(err) };
}

async function runSeriesEpisodeRefresh(appConfig, logger, seriesRef, knownSeries = {}) {
  logger.info("series_episode_refresh_browser_starting", {
    headless: appConfig.crawler.headless
  });
  const browser = await chromium.launch({ headless: appConfig.crawler.headless });
  const context = await browser.newContext({
    locale: "ar",
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => {
    logger.warn("series_episode_refresh_page_error", crawlerErrorMeta(err));
  });

  try {
    const results = [];
    const allSeries = Array.isArray(seriesRef?.series) ? seriesRef.series : [];
    let processed = 0;
    let failedSeriesCount = 0;
    for (const series of allSeries) {
      if (!series?.seriesName || !series.latestEpisodeUrl) {
        logger.warn("series_skipped_invalid_entry", {
          seriesName: series?.seriesName || null,
          hasLatestEpisodeUrl: Boolean(series?.latestEpisodeUrl)
        });
        continue;
      }
      processed += 1;
      const seriesStartedAt = Date.now();
      logger.info("checking_series_episodes", {
        seriesName: series.seriesName,
        latestEpisodeUrl: series.latestEpisodeUrl,
        processed,
        total: allSeries.length
      });

      let basicChain;
      try {
        basicChain = await withRetry(
          () => extractSeriesEpisodeList(page, series, appConfig),
          appConfig.crawler.retries,
          logger
        );
      } catch (err) {
        failedSeriesCount += 1;
        logger.error("series_episode_list_extract_failed", {
          seriesName: series.seriesName,
          latestEpisodeUrl: series.latestEpisodeUrl,
          processed,
          total: allSeries.length,
          ...crawlerErrorMeta(err)
        });
        await humanPause(appConfig.crawler);
        continue;
      }
      const known = knownForSeries(knownSeries, series.seriesName);
      const missing = basicChain.filter((item) => !isKnownSeriesEpisode(item, known));

      if (missing.length === 0) {
        logger.info("series_episodes_already_complete", {
          seriesName: series.seriesName,
          total: basicChain.length,
          processed,
          seriesTotal: allSeries.length,
          durationMs: Date.now() - seriesStartedAt
        });
        await humanPause(appConfig.crawler);
        continue;
      }

      logger.info("series_has_missing_episodes", {
        seriesName: series.seriesName,
        chainSize: basicChain.length,
        knownEpisodeUrls: (known.episodeUrls || []).length,
        missing: missing.length,
        processed,
        total: allSeries.length
      });

      const hydrated = [];
      let resolvedSuccess = 0;
      let resolvedFailures = 0;
      for (const item of missing) {
        try {
          const resolved = await withRetry(
            async (attempt) => {
              logger.info("resolving_missing_series_episode", {
                seriesName: series.seriesName,
                episodeUrl: item.episodeUrl,
                episodeNumber: item.episodeNumber,
                attempt
              });
              return resolveEpisodeVideo(
                page,
                item.episodeUrl,
                appConfig,
                item.imageUrl || series.imageUrl || null,
                { includeSeriesEpisodes: false }
              );
            },
            appConfig.crawler.retries,
            logger
          );
          hydrated.push(mergeHydratedSeriesEpisode(
            { ...item, seriesName: series.seriesName },
            resolved
          ));
          resolvedSuccess += 1;
          await humanPause(appConfig.crawler);
        } catch (err) {
          resolvedFailures += 1;
          logger.warn("missing_series_episode_resolve_failed", {
            seriesName: series.seriesName,
            episodeUrl: item.episodeUrl,
            episodeNumber: item.episodeNumber,
            ...crawlerErrorMeta(err)
          });
          hydrated.push({ ...item, seriesName: series.seriesName });
        }
      }

      const latest = basicChain[0] || missing[0] || null;
      const seriesResult = {
        title: series.seriesName,
        seriesName: series.seriesName,
        episodeUrl: latest?.episodeUrl || series.latestEpisodeUrl,
        episodeNumber: latest?.episodeNumber ?? series.latestEpisodeNumber ?? null,
        imageUrl: series.imageUrl || null,
        seriesEpisodes: hydrated
      };
      results.push(seriesResult);
      if (typeof knownSeries.onSeriesResult === "function") {
        try {
          await knownSeries.onSeriesResult(seriesResult, {
            seriesName: series.seriesName,
            processed,
            total: allSeries.length,
            missing: missing.length,
            saved: hydrated.length
          });
        } catch (err) {
          logger.error("series_progress_callback_failed", {
            seriesName: series.seriesName,
            processed,
            total: allSeries.length,
            ...crawlerErrorMeta(err)
          });
          throw err;
        }
      }
      logger.info("series_processed", {
        seriesName: series.seriesName,
        processed,
        total: allSeries.length,
        missing: missing.length,
        resolvedSuccess,
        resolvedFailures,
        durationMs: Date.now() - seriesStartedAt
      });
      await humanPause(appConfig.crawler);
    }
    logger.info("series_episode_refresh_completed", {
      total: allSeries.length,
      processed,
      results: results.length,
      failedSeriesCount
    });
    return results;
  } finally {
    try {
      await context.close();
    } catch (err) {
      logger.warn("series_episode_refresh_context_close_failed", crawlerErrorMeta(err));
    }
    try {
      await browser.close();
    } catch (err) {
      logger.warn("series_episode_refresh_browser_close_failed", crawlerErrorMeta(err));
    }
  }
}

async function runSeriesDiscovery(appConfig, logger) {
  logger.info("series_discovery_browser_starting", { headless: appConfig.crawler.headless });
  const browser = await chromium.launch({ headless: appConfig.crawler.headless });
  const context = await browser.newContext({
    locale: "ar",
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => {
    logger.warn("series_discovery_page_error", crawlerErrorMeta(err));
  });

  try {
    const episodes = await crawlListingPage(page, appConfig, logger);
    logger.info("discovered_series_candidates", { count: episodes.length });
    return episodes;
  } catch (err) {
    logger.error("series_discovery_failed", crawlerErrorMeta(err));
    throw err;
  } finally {
    try {
      await context.close();
    } catch (err) {
      logger.warn("series_discovery_context_close_failed", crawlerErrorMeta(err));
    }
    try {
      await browser.close();
    } catch (err) {
      logger.warn("series_discovery_browser_close_failed", crawlerErrorMeta(err));
    }
  }
}

module.exports = { runCrawl, runSeriesDiscovery, runSeriesEpisodeRefresh };

/**
 * Standalone probe: validates listing parser + pagination + poster extraction.
 * Does NOT visit episode pages (fast).
 *
 * Run: node scripts/probe-listing.js [maxEpisodes] [maxPages]
 */
const { chromium } = require("playwright");
const appConfig = require("../src/config");
const { parseEpisodeLinks, sanitizeStoredEpisodeImageUrl } = require("../src/parser");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function buildPageUrl(baseUrl, listPath, pageNumber) {
  const base = new URL(listPath || "/", baseUrl);
  if (pageNumber <= 1) return base.toString();
  const trimmed = base.pathname.replace(/\/+$/, "");
  base.pathname = `${trimmed}/page/${pageNumber}/`;
  return base.toString();
}

async function hasPaginationForNext(page, nextN) {
  return page.evaluate((n) => {
    const anchors = Array.from(document.querySelectorAll('.pagination a[href*="/page/"]'));
    const nums = anchors
      .map((a) => {
        const m = a.getAttribute("href") && a.getAttribute("href").match(/\/page\/(\d+)\/?/);
        return m ? Number(m[1]) : null;
      })
      .filter((x) => Number.isFinite(x));
    return nums.length ? n <= Math.max(...nums) : false;
  }, nextN);
}

(async () => {
  const maxEpisodes = Number(process.argv[2] || 25);
  const maxPages = Number(process.argv[3] || 3);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "ar",
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  try {
    const aggregated = new Map();
    for (let n = 1; n <= maxPages && aggregated.size < maxEpisodes; n += 1) {
      const pageUrl = buildPageUrl(appConfig.source.baseUrl, appConfig.source.listPath, n);
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(400);

      const finalUrl = page.url();
      const remaining = maxEpisodes - aggregated.size;
      const items = await parseEpisodeLinks(page, appConfig.source.baseUrl, remaining);
      const before = aggregated.size;
      for (const it of items) {
        if (!aggregated.has(it.episodeUrl)) aggregated.set(it.episodeUrl, it);
        if (aggregated.size >= maxEpisodes) break;
      }
      console.log(
        JSON.stringify({
          pageN: n,
          pageUrl,
          finalUrl,
          itemsOnPage: items.length,
          newlyAdded: aggregated.size - before,
          total: aggregated.size
        })
      );
      if (aggregated.size >= maxEpisodes) break;
      if (aggregated.size === before) {
        console.log(JSON.stringify({ stop: "no_new_items_on_page", n }));
        break;
      }
      const hasNext = await hasPaginationForNext(page, n + 1);
      console.log(JSON.stringify({ pageN: n, hasNext }));
      if (!hasNext) break;
    }
    console.log("\nFinal aggregated episodes:");
    for (const ep of aggregated.values()) {
      const sanitized = sanitizeStoredEpisodeImageUrl(ep.listingImageUrl);
      console.log(
        "-",
        "ep#" + ep.episodeNumber,
        "| title:", (ep.title || "").slice(0, 60),
        "\n   episodeUrl:", ep.episodeUrl,
        "\n   listingImageUrl (raw):", ep.listingImageUrl,
        "\n   listingImageUrl (sanitized):", sanitized
      );
    }
    console.log("\nTotal:", aggregated.size);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

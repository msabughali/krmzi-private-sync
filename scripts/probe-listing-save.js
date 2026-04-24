/**
 * Fast probe: crawls the source main page ONLY, extracts poster imageUrl from each card,
 * and upserts into data/episodes.json (preserves existing fields). Does NOT resolve videos.
 *
 * Run: SOURCE_BASE_URL=https://krmzy.com node scripts/probe-listing-save.js [maxEpisodes]
 */
const { chromium } = require("playwright");
const appConfig = require("../src/config");
const { parseEpisodeLinks, sanitizeStoredEpisodeImageUrl } = require("../src/parser");
const { loadEpisodes, saveEpisodes, upsertEpisodes } = require("../src/episodesStore");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const maxEpisodes = Number(process.argv[2] || 10);
  const listUrl = new URL(appConfig.source.listPath || "/", appConfig.source.baseUrl).toString();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "ar",
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  try {
    console.log("→ Navigating to", listUrl);
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(500);

    const items = await parseEpisodeLinks(page, appConfig.source.baseUrl, maxEpisodes);
    console.log(`→ Parsed ${items.length} episode cards from page 1`);

    const nowIso = new Date().toISOString();
    const incoming = items.map((it) => ({
      episodeUrl: it.episodeUrl,
      title: it.title || null,
      episodeNumber: it.episodeNumber || null,
      imageUrl: sanitizeStoredEpisodeImageUrl(it.listingImageUrl) || null,
      discoveredAt: nowIso
    }));

    const data = await loadEpisodes(appConfig.episodes.filePath);
    const merged = upsertEpisodes(data.episodes, incoming);
    await saveEpisodes(appConfig.episodes.filePath, { episodes: merged });

    console.log("\n→ Saved to", appConfig.episodes.filePath);
    console.log("\n=== Upserted entries (page 1) ===");
    for (const it of incoming) {
      console.log(
        `ep#${it.episodeNumber} | ${it.title}\n  episodeUrl: ${it.episodeUrl}\n  imageUrl  : ${it.imageUrl}\n`
      );
    }
    console.log(`Total entries in episodes.json: ${merged.length}`);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

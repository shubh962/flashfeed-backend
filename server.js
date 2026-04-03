const express = require("express");
const Parser = require("rss-parser");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
const parser = new Parser();
app.use(cors());
app.use(express.json());

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();          // { cat -> { data, time } }
const enrichDone = new Set();     // tracks which cats are fully enriched
const CACHE_TTL = 15 * 60 * 1000;

// ── Axios ─────────────────────────────────────────────────────────────────────
const bot = axios.create({
  timeout: 2000,
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  maxContentLength: 200000,
});

// ── RSS Sources ───────────────────────────────────────────────────────────────
const RSS_SOURCES = {
  india:         ["https://feeds.feedburner.com/ndtvnews-india-news", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", "https://www.thehindu.com/news/national/feeder/default.rss", "https://indianexpress.com/feed/"],
  world:         ["https://feeds.bbci.co.uk/news/world/rss.xml", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", "https://feeds.feedburner.com/ndtvnews-world-news"],
  technology:    ["https://feeds.feedburner.com/gadgets360-latest", "https://techcrunch.com/feed/", "https://www.theverge.com/rss/index.xml"],
  business:      ["https://economictimes.indiatimes.com/rssfeedstopstories.cms", "https://www.livemint.com/rss/money", "https://feeds.feedburner.com/ndtvprofit-latest-news"],
  sports:        ["https://feeds.feedburner.com/ndtvsports-latest", "https://feeds.bbci.co.uk/sport/rss.xml", "https://timesofindia.indiatimes.com/rssfeeds/4719148.cms"],
  entertainment: ["https://timesofindia.indiatimes.com/rssfeeds/-2128672765.cms", "https://feeds.feedburner.com/ndtvmovies-latest"],
  science:       ["https://www.sciencedaily.com/rss/all.xml", "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml"],
  health:        ["https://feeds.bbci.co.uk/news/health/rss.xml", "https://timesofindia.indiatimes.com/rssfeeds/3908999.cms"],
  all:           ["https://feeds.feedburner.com/ndtvnews-top-stories", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", "https://feeds.bbci.co.uk/news/rss.xml", "https://indianexpress.com/feed/"],
};

const FALLBACK_IMAGES = {
  india:         "https://images.unsplash.com/photo-1524492412937-b28074a5d7da?w=800",
  world:         "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800",
  technology:    "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800",
  business:      "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800",
  sports:        "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?w=800",
  entertainment: "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=800",
  science:       "https://images.unsplash.com/photo-1507413245164-6160d8298b31?w=800",
  health:        "https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=800",
  all:           "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800",
};

// ── FEATURE 1: 60-65 word summary from article content ───────────────────────
function makeSummary(text) {
  if (!text) return "";
  // Clean the text
  const clean = text
    .replace(/\s+/g, " ")
    .replace(/\[.*?\]/g, "")
    .trim();

  const words = clean.split(" ");
  if (words.length <= 65) return clean;

  // Take 62 words, end at last complete sentence within range
  const slice = words.slice(0, 65).join(" ");
  const lastDot = Math.max(
    slice.lastIndexOf("."),
    slice.lastIndexOf("!"),
    slice.lastIndexOf("?")
  );
  return lastDot > 100 ? slice.substring(0, lastDot + 1) : slice + "...";
}

// ── FEATURE 2: Scrape real image + body content ───────────────────────────────
async function scrapeDeep(url, category) {
  try {
    // Resolve Google News redirect
    let finalUrl = url;
    if (url.includes("news.google.com")) {
      try {
        const res = await bot.get(url, { maxRedirects: 5 });
        finalUrl = res.request?.res?.responseUrl || url;
      } catch { finalUrl = url; }
    }

    const { data } = await bot.get(finalUrl);
    const $ = cheerio.load(data);

    // Real image
    let img =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      $('meta[itemprop="image"]').attr("content") || "";

    // Fix relative URLs
    if (img && img.startsWith("/")) {
      try { img = `${new URL(finalUrl).origin}${img}`; } catch {}
    }

    // Reject bad images
    if (!img || img.length < 15 || /google\.com|gstatic|favicon|logo|icon/i.test(img)) {
      img = FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all;
    }

    // FEATURE 1: Extract article body for 60-65 word summary
    const sentences = [];
    const selectors = ["article p", ".article-body p", ".story-body p", ".content p", "p"];
    for (const sel of selectors) {
      $(sel).each((_, el) => {
        if (sentences.length >= 8) return false;
        const txt = $(el).text().trim();
        if (txt.length < 40) return;
        if (/cookie|subscribe|advertis|copyright|all rights|click here|sign up|newsletter|follow us|paywall/i.test(txt)) return;
        if (!sentences.includes(txt)) sentences.push(txt);
      });
      if (sentences.length >= 4) break;
    }

    // FEATURE 1: Make 60-65 word summary
    const summary = makeSummary(sentences.join(" "));

    // FEATURE 2: Real source name from og:site_name or domain
    const siteName =
      $('meta[property="og:site_name"]').attr("content") ||
      $('meta[name="application-name"]').attr("content") || "";

    return { img, summary, siteName };
  } catch {
    return { img: FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all, summary: "", siteName: "" };
  }
}

// ── Background enrichment ─────────────────────────────────────────────────────
async function enrichArticles(articles, cat) {
  enrichDone.delete(cat);
  const BATCH = 5;
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.all(batch.map(async (art) => {
      const details = await scrapeDeep(art.link, cat);
      if (details.img)      art.imageUrl    = details.img;
      if (details.summary)  art.description = details.summary;   // 60-65 words
      if (details.siteName) art.source      = details.siteName;  // Real source name
    }));
    // Save partial progress — Flutter gets updates chunk by chunk
    cache.set(cat, { data: [...articles], time: cache.get(cat)?.time || Date.now() });
  }
  enrichDone.add(cat);
  console.log(`✅ [${cat}] fully enriched`);
}

// ── /news — paginated for chunk loading ──────────────────────────────────────
// FEATURE 3: Pagination → Flutter loads in chunks as user scrolls
app.get("/news", async (req, res) => {
  const cat   = (req.query.category || "all").toLowerCase();
  const page  = parseInt(req.query.page  || "1");
  const limit = parseInt(req.query.limit || "15");   // 15 at a time

  // Cache hit → instant (works even after app reopen — FEATURE 4)
  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) {
      const start = (page - 1) * limit;
      const slice = entry.data.slice(start, start + limit);
      return res.json({
        articles: slice,
        total: entry.data.length,
        page,
        hasMore: start + limit < entry.data.length,
        enriched: enrichDone.has(cat),  // Flutter knows if images are ready
      });
    }
  }

  try {
    const sources = RSS_SOURCES[cat] || RSS_SOURCES.all;
    const feedResults = await Promise.allSettled(
      sources.map(s =>
        Promise.race([
          parser.parseURL(s),
          new Promise((_, rej) => setTimeout(() => rej("timeout"), 4000))
        ])
      )
    );

    let items = feedResults
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value?.items || [])
      .filter(it => it.title && it.link);

    // Deduplicate
    const seen = new Set();
    items = items.filter(it => {
      const key = it.title.substring(0, 30).toLowerCase();
      return seen.has(key) ? false : seen.add(key);
    });

    // FEATURE 5: Shuffle for new news every refresh
    items = items.sort(() => Math.random() - 0.5).slice(0, 50);

    let articles = items.map((it, idx) => {
      // FEATURE 2: Extract source from title " - Source Name" pattern
      const parts  = it.title.split(" - ");
      const title  = parts[0].trim();
      const source = parts.length > 1 ? parts[parts.length - 1].trim() : "News";

      return {
        id:          `${cat}-${idx}-${Date.now()}`,
        title,
        source,                                          // Real source name
        sourceUrl:   it.link,                            // FEATURE 2: Original URL for "Read More"
        description: it.contentSnippet?.substring(0, 200) || "",
        link:        it.link,
        imageUrl:    FALLBACK_IMAGES[cat] || FALLBACK_IMAGES.all,
        category:    cat,
        publishedAt: it.pubDate || "",
      };
    });

    // Save + respond instantly with page 1
    cache.set(cat, { data: articles, time: Date.now() });
    enrichDone.delete(cat);

    const start = (page - 1) * limit;
    res.json({
      articles:  articles.slice(start, start + limit),
      total:     articles.length,
      page,
      hasMore:   start + limit < articles.length,
      enriched:  false,
    });

    // Background: get real images + 60-65 word summaries
    enrichArticles(articles, cat);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /images — Flutter polls after 6s for enriched data ───────────────────────
app.get("/images", (req, res) => {
  const cat   = (req.query.category || "all").toLowerCase();
  const page  = parseInt(req.query.page  || "1");
  const limit = parseInt(req.query.limit || "15");
  const entry = cache.get(cat);
  if (!entry) return res.json({ articles: [], enriched: false });
  const start = (page - 1) * limit;
  res.json({
    articles: entry.data.slice(start, start + limit),
    total:    entry.data.length,
    enriched: enrichDone.has(cat),
  });
});

// ── /categories ───────────────────────────────────────────────────────────────
app.get("/categories", (_, res) => res.json(Object.keys(RSS_SOURCES)));

// ── /health ───────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status:  "ok",
  cached:  [...cache.keys()],
  enriched:[...enrichDone],
  uptime:  Math.floor(process.uptime()) + "s",
}));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ FlashFeed Live on ${PORT}`);
  setTimeout(() => {
    ["all", "india", "sports", "technology"].forEach(cat =>
      axios.get(`http://127.0.0.1:${PORT}/news?category=${cat}`).catch(() => {})
    );
  }, 500);
});

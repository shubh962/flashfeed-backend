const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const parser = new Parser();
app.use(cors());
app.use(express.json());

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const RSS_SOURCES = {
  india: [
    "https://feeds.feedburner.com/ndtvnews-india-news",
    "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
    "https://www.thehindu.com/news/national/feeder/default.rss",
    "https://indianexpress.com/feed/",
    "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml",
  ],
  world: [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    "https://feeds.feedburner.com/ndtvnews-world-news",
    "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms",
  ],
  technology: [
    "https://feeds.feedburner.com/gadgets360-latest",
    "https://techcrunch.com/feed/",
    "https://www.theverge.com/rss/index.xml",
    "https://feeds.arstechnica.com/arstechnica/technology-lab",
  ],
  business: [
    "https://feeds.feedburner.com/ndtvprofit-latest-news",
    "https://economictimes.indiatimes.com/rssfeedstopstories.cms",
    "https://www.livemint.com/rss/money",
    "https://feeds.bbci.co.uk/news/business/rss.xml",
  ],
  sports: [
    "https://feeds.feedburner.com/ndtvsports-latest",
    "https://timesofindia.indiatimes.com/rssfeeds/4719148.cms",
    "https://www.espncricinfo.com/rss/content/story/feeds/0.xml",
    "https://feeds.bbci.co.uk/sport/rss.xml",
  ],
  entertainment: [
    "https://timesofindia.indiatimes.com/rssfeeds/-2128672765.cms",
    "https://feeds.feedburner.com/ndtvmovies-latest",
    "https://www.hindustantimes.com/feeds/rss/entertainment/rssfeed.xml",
  ],
  science: [
    "https://www.sciencedaily.com/rss/all.xml",
    "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
  ],
  health: [
    "https://feeds.bbci.co.uk/news/health/rss.xml",
    "https://timesofindia.indiatimes.com/rssfeeds/3908999.cms",
  ],
  all: [
    "https://feeds.feedburner.com/ndtvnews-top-stories",
    "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
    "https://feeds.bbci.co.uk/news/rss.xml",
    "https://indianexpress.com/feed/",
    "https://www.thehindu.com/feeder/default.rss",
  ],
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

// ── SPEED 1: Shared axios instance with keep-alive ────────────────────────────
const axiosInstance = axios.create({
  timeout: 1500,                          // Hard 1.5s limit per request
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
  },
  maxContentLength: 150000,              // Only first 150KB — enough for OG + content
  maxRedirects: 3,
  decompress: true,
});

// ── SPEED 2: Resolve Google URL fast ─────────────────────────────────────────
async function resolveUrl(url) {
  if (!url.includes("news.google.com")) return url;
  try {
    const res = await axiosInstance.get(url, { maxRedirects: 3 });
    return res.request?.res?.responseUrl || url;
  } catch { return url; }
}

// ── SPEED 3: Fast fetch — image + content in one shot ────────────────────────
async function fetchDetails(rawUrl, category) {
  try {
    const url = await resolveUrl(rawUrl);
    const { data } = await axiosInstance.get(url);
    const $ = cheerio.load(data);

    // Image
    let img =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      $('meta[itemprop="image"]').attr("content") || "";

    if (img && img.startsWith("/")) {
      try { img = `${new URL(url).origin}${img}`; } catch {}
    }

    const isBadImage = !img || img.length < 15 ||
      /google\.com|gstatic|favicon|logo|icon/i.test(img);

    if (isBadImage) img = FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all;

    // Content — 5 clean sentences
    const sentences = [];
    const selectors = ["article p", ".article-body p", ".story-body p", "p"];

    for (const sel of selectors) {
      $(sel).each((_, el) => {
        if (sentences.length >= 5) return false;
        const txt = $(el).text().trim();
        if (txt.length < 40) return;
        if (/cookie|subscribe|advertis|copyright|all rights|click here|read more|sign up|newsletter|follow us/i.test(txt)) return;
        if (!sentences.includes(txt)) sentences.push(txt);
      });
      if (sentences.length >= 3) break;
    }

    return {
      img,
      bodyText: sentences.slice(0, 5).join(" ").substring(0, 700),
    };
  } catch {
    return { img: FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all, bodyText: "" };
  }
}

// ── SPEED 4: Process ALL articles at once — 15 parallel ──────────────────────
async function processArticlesBackground(articles, cat) {
  const BATCH = 15;                        // Was 5, now 15 — 3x faster
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    const details = await Promise.all(batch.map(a => fetchDetails(a.link, cat)));
    details.forEach((det, j) => {
      const idx = i + j;
      articles[idx].imageUrl = det.img;
      if (det.bodyText?.length > 50) articles[idx].description = det.bodyText;
    });
  }
  cache.set(cat, { data: articles, time: Date.now() });
  console.log(`✅ [${cat}] ready — ${articles.length} articles`);
}

// ── SPEED 5: RSS fetch with tight timeout ────────────────────────────────────
async function fetchRSS(sources) {
  const results = await Promise.allSettled(
    sources.map(url =>
      Promise.race([
        parser.parseURL(url),
        new Promise((_, rej) => setTimeout(() => rej("timeout"), 4000)) // 4s max per feed
      ])
    )
  );
  return results
    .filter(r => r.status === "fulfilled")
    .flatMap(r => r.value?.items || [])
    .filter(it => it.title && it.link);
}

// ── /news ─────────────────────────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();

  // Cache hit → instant
  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) {
      console.log(`⚡ Cache hit [${cat}]`);
      return res.json({ articles: entry.data });
    }
  }

  try {
    const sources = RSS_SOURCES[cat] || RSS_SOURCES.all;
    let items = await fetchRSS(sources);

    // Deduplicate
    const seen = new Set();
    items = items.filter(it => {
      const key = it.title.substring(0, 35).toLowerCase();
      return seen.has(key) ? false : seen.add(key);
    }).slice(0, 40);

    // Map articles instantly
    let articles = items.map((it, idx) => ({
      id: `${cat}-${idx}-${Date.now()}`,
      title: it.title.split(" - ")[0].trim(),
      source: it.title.split(" - ").pop().trim() || "FlashFeed",
      description: it.contentSnippet?.substring(0, 200) || "",
      link: it.link,
      imageUrl: FALLBACK_IMAGES[cat] || FALLBACK_IMAGES.all,
      category: cat,
    }));

    // Save + respond instantly
    cache.set(cat, { data: articles, time: Date.now() });
    res.json({ articles });

    // Background: enrich with real images + content
    processArticlesBackground([...articles], cat);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /images — Flutter polls after 6s ─────────────────────────────────────────
app.get("/images", (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();
  const entry = cache.get(cat);
  if (!entry) return res.json({ articles: [] });
  res.json({ articles: entry.data });
});

// ── /categories ───────────────────────────────────────────────────────────────
app.get("/categories", (_, res) => res.json(Object.keys(RSS_SOURCES)));

// ── /health ───────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "ok",
  cached: [...cache.keys()],
  uptime: Math.floor(process.uptime()) + "s",
}));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ FlashFeed TURBO on port ${PORT}`);

  // Warm up top categories on startup
  setTimeout(() => {
    ["all", "india", "sports", "technology"].forEach(cat =>
      axios.get(`http://127.0.0.1:${PORT}/news?category=${cat}`).catch(() => {})
    );
  }, 500);
});


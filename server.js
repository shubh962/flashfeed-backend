const express = require("express");
const Parser = require("rss-parser");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
const parser = new Parser();
app.use(cors());
app.use(express.json());

// ── Cache Settings ────────────────────────────────────────────────────────────
const cache = new Map();
const enrichDone = new Set();
const CACHE_TTL = 15 * 60 * 1000; // 15 Minutes

// ── Axios Instance (Fast & Reliable) ──────────────────────────────────────────
const bot = axios.create({
  timeout: 3000,
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  maxContentLength: 300000,
});

// ── RSS Sources ───────────────────────────────────────────────────────────────
const RSS_SOURCES = {
  india: ["https://feeds.feedburner.com/ndtvnews-india-news", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", "https://www.thehindu.com/news/national/feeder/default.rss", "https://indianexpress.com/feed/"],
  world: ["https://feeds.bbci.co.uk/news/world/rss.xml", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", "https://feeds.feedburner.com/ndtvnews-world-news"],
  technology: ["https://feeds.feedburner.com/gadgets360-latest", "https://techcrunch.com/feed/", "https://www.theverge.com/rss/index.xml"],
  business: ["https://economictimes.indiatimes.com/rssfeedstopstories.cms", "https://www.livemint.com/rss/money", "https://feeds.feedburner.com/ndtvprofit-latest-news"],
  sports: ["https://feeds.feedburner.com/ndtvsports-latest", "https://feeds.bbci.co.uk/sport/rss.xml", "https://timesofindia.indiatimes.com/rssfeeds/4719148.cms"],
  entertainment: ["https://timesofindia.indiatimes.com/rssfeeds/-2128672765.cms", "https://feeds.feedburner.com/ndtvmovies-latest"],
  science: ["https://www.sciencedaily.com/rss/all.xml", "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml"],
  health: ["https://feeds.bbci.co.uk/news/health/rss.xml", "https://timesofindia.indiatimes.com/rssfeeds/3908999.cms"],
  all: ["https://feeds.feedburner.com/ndtvnews-top-stories", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", "https://feeds.bbci.co.uk/news/rss.xml", "https://indianexpress.com/feed/"],
};

const FALLBACK_IMAGES = {
  all: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800",
};

// ── FEATURE 1: 100 Word Summary (5-6 Lines) ──────────────────────────────────
function makeSummary(text) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").replace(/\[.*?\]/g, "").trim();
  const words = clean.split(" ");
  
  // 🔥 Limit set to 100 words for deep content
  if (words.length <= 100) return clean;

  const slice = words.slice(0, 100).join(" ");
  const lastDot = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  return lastDot > 150 ? slice.substring(0, lastDot + 1) : slice + "...";
}

// ── FEATURE 2: Real Image & Site Name Scraping ───────────────────────────────
async function scrapeDeep(url, category) {
  try {
    let finalUrl = url;
    if (url.includes("news.google.com")) {
      const res = await bot.get(url, { maxRedirects: 5 });
      finalUrl = res.request?.res?.responseUrl || url;
    }

    const { data } = await bot.get(finalUrl);
    const $ = cheerio.load(data);

    let img = $('meta[property="og:image"]').attr("content") || 
              $('meta[name="twitter:image"]').attr("content") || "";

    if (img && img.startsWith("/")) {
      try { img = `${new URL(finalUrl).origin}${img}`; } catch {}
    }

    if (!img || img.length < 15 || /google\.com|gstatic|favicon|logo|icon/i.test(img)) {
      img = FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all;
    }

    const sentences = [];
    const selectors = ["article p", ".article-body p", ".story-body p", "p"];
    for (const sel of selectors) {
      $(sel).each((_, el) => {
        if (sentences.length >= 10) return false;
        const txt = $(el).text().trim();
        if (txt.length < 50 || /cookie|subscribe|advertis|copyright/i.test(txt)) return;
        if (!sentences.includes(txt)) sentences.push(txt);
      });
      if (sentences.length >= 5) break;
    }

    const summary = makeSummary(sentences.join(" "));
    const siteName = $('meta[property="og:site_name"]').attr("content") || "";

    return { img, summary, siteName };
  } catch {
    return { img: FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all, summary: "", siteName: "" };
  }
}

// ── Background Enrichment (Batch Processing) ──────────────────────────────────
async function enrichArticles(articles, cat) {
  enrichDone.delete(cat);
  const BATCH = 5;
  // Start from index 8 because first 8 are already enriched in /news
  for (let i = 8; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.all(batch.map(async (art) => {
      const details = await scrapeDeep(art.link, cat);
      if (details.img) art.imageUrl = details.img;
      if (details.summary) art.description = details.summary;
      if (details.siteName) art.source = details.siteName;
    }));
    cache.set(cat, { data: [...articles], time: cache.get(cat)?.time || Date.now() });
  }
  enrichDone.add(cat);
  console.log(`✅ [${cat}] background enrichment complete`);
}

// ── /news Endpoint (Optimized for Instant UI) ─────────────────────────────────
app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();
  const page = parseInt(req.query.page || "1");
  const limit = parseInt(req.query.limit || "15");

  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) {
      const start = (page - 1) * limit;
      return res.json({
        articles: entry.data.slice(start, start + limit),
        total: entry.data.length,
        hasMore: start + limit < entry.data.length,
        enriched: true
      });
    }
  }

  try {
    const sources = RSS_SOURCES[cat] || RSS_SOURCES.all;
    const feeds = await Promise.allSettled(sources.map(s => parser.parseURL(s)));
    let items = feeds.filter(f => f.status === "fulfilled").flatMap(f => f.value?.items || []);

    const seen = new Set();
    items = items.filter(it => {
      const key = it.title.substring(0, 30).toLowerCase();
      return seen.has(key) ? false : seen.add(key);
    });

    // 🔥 FEATURE 5: Shuffle for fresh news every time
    items = items.sort(() => Math.random() - 0.5).slice(0, 45);

    let articles = items.map((it, idx) => {
      const parts = it.title.split(" - ");
      return {
        id: `${cat}-${idx}-${Date.now()}`,
        title: parts[0].trim(),
        source: parts.length > 1 ? parts[parts.length - 1].trim() : "News", //
        sourceUrl: it.link,
        description: it.contentSnippet?.substring(0, 200) || "",
        link: it.link,
        imageUrl: FALLBACK_IMAGES.all,
        category: cat,
      };
    });

    // 🔥 SPEED FIX: Enrich first 8 articles IMMEDIATELY before sending response
    const priorityBatch = articles.slice(0, 8);
    await Promise.all(priorityBatch.map(async (art) => {
      const details = await scrapeDeep(art.link, cat);
      if (details.img) art.imageUrl = details.img;
      if (details.summary) art.description = details.summary;
      if (details.siteName) art.source = details.siteName;
    }));

    cache.set(cat, { data: articles, time: Date.now() });
    
    res.json({
      articles: articles.slice(0, limit),
      total: articles.length,
      hasMore: true,
      enriched: false
    });

    // Start background enrichment for the rest
    enrichArticles(articles, cat);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/categories", (_, res) => res.json(Object.keys(RSS_SOURCES)));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 FlashFeed Turbo Live on ${PORT}`));

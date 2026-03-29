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
const CACHE_TTL = 5 * 60 * 1000;

function getCache(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

const RSS_SOURCES = {
  india: [
    "https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en",
    "https://feeds.feedburner.com/ndtvnews-india-news",
    "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
    "https://www.thehindu.com/news/national/feeder/default.rss",
    "https://indianexpress.com/feed/",
  ],
  world: [
    "https://news.google.com/rss/search?q=world+news&hl=en-IN&gl=IN&ceid=IN:en",
    "https://feeds.bbci.co.uk/news/world/rss.xml",
  ],
  technology: [
    "https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en",
    "https://feeds.feedburner.com/gadgets360-latest",
    "https://techcrunch.com/feed/",
    "https://www.theverge.com/rss/index.xml",
  ],
  business: [
    "https://news.google.com/rss/search?q=business+india&hl=en-IN&gl=IN&ceid=IN:en",
    "https://feeds.feedburner.com/ndtvprofit-latest-news",
    "https://economictimes.indiatimes.com/rssfeedstopstories.cms",
  ],
  sports: [
    "https://news.google.com/rss/search?q=cricket+ipl+sports&hl=en-IN&gl=IN&ceid=IN:en",
    "https://feeds.feedburner.com/ndtvsports-latest",
  ],
  entertainment: [
    "https://news.google.com/rss/search?q=bollywood+entertainment&hl=en-IN&gl=IN&ceid=IN:en",
    "https://timesofindia.indiatimes.com/rssfeeds/-2128672765.cms",
  ],
  science: [
    "https://news.google.com/rss/search?q=science+isro+space&hl=en-IN&gl=IN&ceid=IN:en",
  ],
  health: [
    "https://news.google.com/rss/search?q=health+medical+india&hl=en-IN&gl=IN&ceid=IN:en",
  ],
  all: [
    "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en",
    "https://feeds.feedburner.com/ndtvnews-top-stories",
    "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
    "https://feeds.bbci.co.uk/news/rss.xml",
    "https://indianexpress.com/feed/",
  ],
};

// Curated fallback images per category (Unsplash — always loads)
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

// ── FIX 1: Resolve Google News redirect → get real article URL ───────────────
async function resolveGoogleNewsUrl(url) {
  try {
    if (!url.includes("news.google.com")) return url;
    const res = await axios.get(url, {
      timeout: 3000,
      maxRedirects: 5,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
      validateStatus: () => true,
    });
    // axios follows redirects automatically — res.request.res.responseUrl has final URL
    return res.request?.res?.responseUrl || res.config?.url || url;
  } catch {
    return url;
  }
}

// ── FIX 2: Fetch OG image from REAL article URL ───────────────────────────────
async function fetchOgImage(rawUrl) {
  try {
    const url = await resolveGoogleNewsUrl(rawUrl);
    const { data } = await axios.get(url, {
      timeout: 2000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html",
      },
      maxContentLength: 300000,
    });
    const $ = cheerio.load(data);
    const img =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      $('meta[itemprop="image"]').attr("content") ||
      $('article img').first().attr("src") ||
      "";

    // Reject Google logos, icons, tiny images
    if (
      img.includes("google.com") ||
      img.includes("gstatic.com") ||
      img.includes("favicon") ||
      img.includes("logo") ||
      img.length < 10
    ) return "";

    return img;
  } catch {
    return "";
  }
}

// Parallel image fetch — 8 at a time
async function fetchImagesParallel(items, category) {
  const results = [...items];
  const BATCH = 8;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const images = await Promise.all(batch.map(item => fetchOgImage(item.link)));
    images.forEach((img, j) => {
      results[i + j].imageUrl = img || FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all;
    });
  }
  return results;
}

// ── FIX 3: Clean description — remove duplicate headlines ────────────────────
function cleanDescription(raw = "") {
  if (!raw) return "";
  // Google News contentSnippet has multiple headlines separated by newlines
  // Take only the first clean sentence
  const lines = raw.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
  // Pick first line that isn't just a source name
  const firstLine = lines[0] || "";
  // Remove source attribution at end (e.g., " France 24")
  return firstLine.replace(/\s{2,}[A-Z][\w\s]+$/, "").trim();
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  try {
    const diff = Math.floor((Date.now() - new Date(dateStr)) / 1000);
    if (diff < 60)    return "Just now";
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch { return ""; }
}

function isBreaking(dateStr) {
  try { return (Date.now() - new Date(dateStr)) < 2 * 60 * 60 * 1000; }
  catch { return false; }
}

function guessSentiment(title = "") {
  const t = title.toLowerCase();
  if (t.match(/killed|dead|crash|war|attack|flood|crisis|falls|drops|ban|collapse|explosion/)) return "negative";
  if (t.match(/wins|launches|record|breakthrough|inaugurates|rises|success|celebrates/))        return "positive";
  return "neutral";
}

function deduplicate(items) {
  const seen = new Map();
  for (const item of items) {
    const key = (item.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
    if (key && !seen.has(key)) seen.set(key, item);
  }
  return Array.from(seen.values());
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── /categories ──────────────────────────────────────────────────────────────
app.get("/categories", (_, res) => {
  res.json(Object.keys(RSS_SOURCES));
});

// ── /news ─────────────────────────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  const category = (req.query.category || "all").toLowerCase();
  const page     = parseInt(req.query.page  || "1");
  const limit    = parseInt(req.query.limit || "20");

  // Cache hit → instant response
  const cached = getCache(category);
  if (cached) {
    const start = (page - 1) * limit;
    return res.json({
      articles: cached.slice(start, start + limit),
      total: cached.length,
      hasMore: start + limit < cached.length,
      fromCache: true,
    });
  }

  try {
    const sources = RSS_SOURCES[category] || RSS_SOURCES.all;

    const feedResults = await Promise.allSettled(
      sources.map(url => parser.parseURL(url))
    );

    let allItems = feedResults
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value.items || [])
      .filter(item => item.title && item.link);

    allItems = deduplicate(allItems);
    allItems = shuffle(allItems).slice(0, 100);

    let articles = allItems.map((item, idx) => {
      const parts  = (item.title || "").split(" - ");
      const title  = parts[0]?.trim() || item.title;
      const source = parts[parts.length - 1]?.trim() || "News";

      return {
        id:          `${category}-${idx}-${Date.now()}`,
        title,
        source,
        // FIX 3: Clean description
        description: cleanDescription(item.contentSnippet),
        link:        item.link,
        date:        formatDate(item.pubDate),
        imageUrl:    FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all,
        category,
        sentiment:   guessSentiment(title),
        isBreaking:  isBreaking(item.pubDate),
      };
    });

    // Fetch real images (FIX 1 + 2 applied inside)
    articles = await fetchImagesParallel(articles, category);

    setCache(category, articles);

    const start = (page - 1) * limit;
    res.json({
      articles: articles.slice(start, start + limit),
      total: articles.length,
      hasMore: start + limit < articles.length,
      fromCache: false,
    });

  } catch (e) {
    console.error("Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /prefetch ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

app.post("/prefetch", (req, res) => {
  const { categories = [] } = req.body;
  res.json({ status: "prefetching" });
  categories.forEach(cat => {
    if (!getCache(cat))
      axios.get(`http://127.0.0.1:${PORT}/news?category=${cat}&limit=100`).catch(() => {});
  });
});

// ── /health ──────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => {
  res.json({ status: "ok", cached: [...cache.keys()], uptime: process.uptime() });
});

// ── Start + warm cache ────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ FlashFeed running on port ${PORT}`);
  setTimeout(() => {
    ["india", "sports", "technology"].forEach(cat =>
      axios.get(`http://127.0.0.1:${PORT}/news?category=${cat}`).catch(() => {})
    );
  }, 1000);
});

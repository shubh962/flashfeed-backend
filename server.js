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
  india: ["https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-india-news"],
  world: ["https://news.google.com/rss/search?q=world+news&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  technology: ["https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en", "https://techcrunch.com/feed/"],
  business: ["https://news.google.com/rss/search?q=business+india&hl=en-IN&gl=IN&ceid=IN:en", "https://economictimes.indiatimes.com/rssfeedstopstories.cms"],
  sports: ["https://news.google.com/rss/search?q=cricket+ipl+sports&hl=en-IN&gl=IN&ceid=IN:en"],
  all: ["https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-top-stories"]
};

const FALLBACK_IMAGES = {
  india:      "https://images.unsplash.com/photo-1524492412937-b28074a5d7da?w=800",
  world:      "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800",
  technology: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800",
  business:   "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800",
  sports:     "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?w=800",
  all:        "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800",
};

// ── RESOLVE GOOGLE URL ───────────────────────────────────────────────────────
async function resolveUrl(url) {
  try {
    if (!url.includes("news.google.com")) return url;
    const res = await axios.get(url, { timeout: 2500, maxRedirects: 5 });
    return res.request?.res?.responseUrl || url;
  } catch { return url; }
}

// ── FETCH IMAGE & BODY ───────────────────────────────────────────────────────
async function fetchDetails(rawUrl, category) {
  try {
    const url = await resolveUrl(rawUrl);
    const { data } = await axios.get(url, {
      timeout: 3500,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    const $ = cheerio.load(data);

    let img =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") || "";

    // ── FIX 1: Reject Google logo / icons / bad images ───────────────────────
    const isBadImage =
      !img ||
      img.includes("google.com") ||
      img.includes("gstatic.com") ||
      img.includes("favicon") ||
      img.includes("logo") ||
      img.includes("icon") ||
      img.length < 15;

    if (isBadImage) img = FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all;

    // Body text
    let bodyText = "";
    $('p').each((i, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 80 && bodyText.length < 450) bodyText += txt + " ";
    });

    return { img, bodyText: bodyText.trim() };
  } catch {
    return { img: FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all, bodyText: "" };
  }
}

// ── PROCESS ARTICLES IN BACKGROUND (lazy load) ──────────────────────────────
async function processArticlesBackground(articles, cat) {
  const BATCH = 5;
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    const details = await Promise.all(batch.map(a => fetchDetails(a.link, cat)));
    details.forEach((det, j) => {
      const idx = i + j;
      articles[idx].imageUrl = det.img;
      if (det.bodyText && det.bodyText.length > 50) {
        articles[idx].description = det.bodyText;
      }
    });
  }
  // Update cache with enriched data
  cache.set(cat, { data: articles, time: Date.now() });
  console.log(`✅ Images loaded for [${cat}]`);
}

// ── /news ENDPOINT ───────────────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();

  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) return res.json({ articles: entry.data });
  }

  try {
    const sources = RSS_SOURCES[cat] || RSS_SOURCES.all;
    const feeds = await Promise.allSettled(sources.map(s => parser.parseURL(s)));

    let items = feeds.filter(f => f.status === "fulfilled").flatMap(f => f.value.items || []);

    // Deduplicate
    const seen = new Set();
    items = items.filter(it => {
      const key = it.title.substring(0, 35).toLowerCase();
      return seen.has(key) ? false : seen.add(key);
    }).slice(0, 40);

    // ── FIX 2: Return articles INSTANTLY with fallback image ─────────────────
    // Flutter gets data immediately, no waiting for images
    let articles = items.map((it, idx) => ({
      id: `${cat}-${idx}`,
      title: it.title.split(" - ")[0],
      source: it.title.split(" - ").pop() || "FlashFeed",
      description: it.contentSnippet || "",
      link: it.link,
      imageUrl: FALLBACK_IMAGES[cat] || FALLBACK_IMAGES.all, // nice fallback first
      category: cat
    }));

    // Save to cache immediately so Flutter gets it fast
    cache.set(cat, { data: articles, time: Date.now() });

    // Send response NOW — don't wait for images
    res.json({ articles });

    // Then fetch real images in background (lazy load)
    processArticlesBackground(articles, cat);

  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /images endpoint — Flutter polls this after 5s to get updated images ─────
app.get("/images", (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();
  const entry = cache.get(cat);
  if (!entry) return res.json({ articles: [] });
  res.json({ articles: entry.data });
});

app.listen(5000, "0.0.0.0", () => console.log("🚀 Server Live on 5000"));

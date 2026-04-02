const express = require("express");
const Parser = require("rss-parser");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
const parser = new Parser();
app.use(cors());
app.use(express.json());

const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 Minutes Cache

// Axios Instance with tight timeouts for speed
const bot = axios.create({
  timeout: 2000, 
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
});

const RSS_SOURCES = {
  india: ["https://feeds.feedburner.com/ndtvnews-india-news", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"],
  world: ["https://feeds.bbci.co.uk/news/world/rss.xml", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"],
  technology: ["https://feeds.feedburner.com/gadgets360-latest", "https://techcrunch.com/feed/"],
  business: ["https://economictimes.indiatimes.com/rssfeedstopstories.cms", "https://www.livemint.com/rss/money"],
  sports: ["https://feeds.feedburner.com/ndtvsports-latest", "https://feeds.bbci.co.uk/sport/rss.xml"],
  all: ["https://feeds.feedburner.com/ndtvnews-top-stories", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"]
};

const FALLBACK_IMAGES = {
  all: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800"
};

// ── Helper: Extract 5-6 lines of content ─────────────────────────────────────
async function scrapeDeep(url, category) {
  try {
    const { data } = await bot.get(url);
    const $ = cheerio.load(data);
    
    const img = $('meta[property="og:image"]').attr("content") || "";
    
    let content = [];
    $('p').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 90 && content.length < 6) content.push(txt); // 🔥 Target 6 lines
    });

    return { img, body: content.join(" ") };
  } catch {
    return { img: "", body: "" };
  }
}

// ── Background Worker: Scrapes in small chunks ───────────────────────────────
async function enrichArticles(articles, cat) {
  const BATCH_SIZE = 4; // 🚀 Small batches to avoid Render freezing
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (art) => {
      const details = await scrapeDeep(art.link, cat);
      if (details.img) art.imageUrl = details.img;
      if (details.body) art.description = details.body;
    }));
    // Save partial progress to cache
    cache.set(cat, { data: articles, time: Date.now() });
  }
}

// ── /news Endpoint ──────────────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();

  // 1. Instant Cache Return
  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) {
      return res.json({ articles: entry.data });
    }
  }

  try {
    const sources = RSS_SOURCES[cat] || RSS_SOURCES.all;
    const feedResults = await Promise.allSettled(sources.map(s => parser.parseURL(s)));
    
    let items = feedResults.filter(r => r.status === "fulfilled").flatMap(r => r.value.items || []);
    
    // Deduplicate
    const seen = new Set();
    let articles = items.filter(it => {
      const key = it.title.substring(0, 30).toLowerCase();
      return seen.has(key) ? false : seen.add(key);
    }).slice(0, 30).map((it, idx) => ({
      id: `${cat}-${idx}-${Date.now()}`,
      title: it.title.split(" - ")[0].trim(),
      source: it.title.split(" - ").pop().trim() || "News Source", // 🔥 Source Name Included
      description: it.contentSnippet?.substring(0, 180) + "...", 
      link: it.link,
      imageUrl: FALLBACK_IMAGES.all,
      category: cat
    }));

    // 2. Respond INSTANTLY with RSS data
    res.json({ articles });

    // 3. Start Deep Scraping in Background (Images + 6 lines)
    enrichArticles(articles, cat);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 FlashFeed Turbo Live on ${PORT}`));

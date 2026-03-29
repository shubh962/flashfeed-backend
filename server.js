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
const CACHE_TTL = 10 * 60 * 1000; // Increase to 10 mins

function getCache(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  return null;
}

const RSS_SOURCES = {
  india: ["https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"],
  technology: ["https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en", "https://techcrunch.com/feed/"],
  sports: ["https://news.google.com/rss/search?q=cricket+ipl+sports&hl=en-IN&gl=IN&ceid=IN:en"],
  world: ["https://news.google.com/rss/search?q=world+news&hl=en-IN&gl=IN&ceid=IN:en"],
  business: ["https://news.google.com/rss/search?q=business+india&hl=en-IN&gl=IN&ceid=IN:en"],
  all: ["https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en"]
};

// ⚡ Instant Unsplash Fallbacks (Premium Look)
const FALLBACKS = {
  india: "https://images.unsplash.com/photo-1524492412937-b28074a5d7da?w=800",
  technology: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800",
  sports: "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?w=800",
  business: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800",
  all: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800"
};

async function fetchOgImage(url) {
  try {
    const { data } = await axios.get(url, { timeout: 1200, headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(data);
    return $('meta[property="og:image"]').attr("content") || "";
  } catch { return ""; }
}

app.get("/news", async (req, res) => {
  const category = (req.query.category || "all").toLowerCase();
  const page = parseInt(req.query.page || "1");
  const limit = 20;

  const cached = getCache(category);
  if (cached) {
    const start = (page - 1) * limit;
    return res.json({ articles: cached.slice(start, start + limit), total: cached.length });
  }

  try {
    const sources = RSS_SOURCES[category] || RSS_SOURCES.all;
    const feed = await parser.parseURL(sources[0]);
    
    // 🚀 Faster processing: Only scrape images for the top 5 articles per request
    // The rest use the beautiful Unsplash fallbacks to save time
    let rawItems = feed.items.slice(0, 60); 

    const articles = await Promise.all(rawItems.map(async (item, idx) => {
      let img = "";
      if (idx < 5) { // Only scrape top 5 for speed
        img = await fetchOgImage(item.link);
      }

      return {
        id: `${category}-${idx}`,
        title: item.title.split(" - ")[0],
        source: item.title.split(" - ")[1] || "FlashFeed",
        description: item.contentSnippet || "",
        link: item.link,
        date: "Just now",
        imageUrl: img || (FALLBACKS[category] || FALLBACKS.all),
        category,
        sentiment: "neutral"
      };
    }));

    cache.set(category, { data: articles, time: Date.now() });
    res.json({ articles: articles.slice(0, limit), total: articles.length });
  } catch (e) {
    res.status(500).json({ error: "Server too busy. Try again." });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Fast Server on ${PORT}`));

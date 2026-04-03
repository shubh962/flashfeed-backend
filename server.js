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
const CACHE_TTL = 15 * 60 * 1000; 

const bot = axios.create({
  timeout: 5000, 
  headers: { 
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  }
});

const RSS_SOURCES = {
  india: ["https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-india-news"],
  world: ["https://news.google.com/rss/search?q=world&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  technology: ["https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en", "https://techcrunch.com/feed/"],
  business: ["https://news.google.com/rss/search?q=business&hl=en-IN&gl=IN&ceid=IN:en", "https://economictimes.indiatimes.com/rssfeedstopstories.cms"],
  sports: ["https://news.google.com/rss/search?q=sports&hl=en-IN&gl=IN&ceid=IN:en"],
  all: ["https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-top-stories", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"]
};

const FALLBACK_IMAGES = { all: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800" };

// ── Strict 85-Word Formatting ─────────────────────────────────────────────
function formatText(text, rssSnippet) {
  const baseText = (text && text.length > 150) ? text : (rssSnippet || "");
  const clean = baseText.replace(/\s+/g, " ").replace(/\[.*?\]/g, "").trim();
  const words = clean.split(" ");
  if (words.length <= 85) return clean;
  return words.slice(0, 85).join(" ") + "...";
}

// ── Deep Scraper with Multi-Source Fallback ───────────────────────────────
async function scrapeDeep(url, rssSnippet, rssSource, category) {
  try {
    let finalUrl = url;
    if (url.includes("news.google.com")) {
      const res = await bot.get(url, { maxRedirects: 5 });
      finalUrl = res.request?.res?.responseUrl || url;
    }

    const { data } = await bot.get(finalUrl);
    const $ = cheerio.load(data);

    // 1. Image Fix: Check multiple tags
    let img = $('meta[property="og:image"]').attr("content") || 
              $('meta[name="twitter:image"]').attr("content") || 
              $('meta[itemprop="image"]').attr("content") || "";
    
    // 2. Source Name Fix: Check multiple tags
    let siteName = $('meta[property="og:site_name"]').attr("content") || 
                   $('meta[name="application-name"]').attr("content") || 
                   rssSource; // Fallback to RSS source if scraping fails

    let paragraphs = [];
    $('p').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 80 && paragraphs.length < 12) paragraphs.push(txt);
    });

    return { 
      img: (img && img.startsWith("http")) ? img : (FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all), 
      summary: formatText(paragraphs.join(" "), rssSnippet),
      siteName: siteName.trim() || "FlashFeed" 
    };
  } catch {
    return { img: FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all, summary: formatText("", rssSnippet), siteName: rssSource };
  }
}

// ── Background Auto-Enricher ──────────────────────────────────────────────
async function enrichAll(articles, cat) {
  const BATCH_SIZE = 3; 
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (art) => {
      const details = await scrapeDeep(art.link, art.description, art.source, cat);
      art.imageUrl = details.img;
      art.description = details.summary;
      art.source = details.siteName; // Updates source name in background
    }));
    cache.set(cat, { data: articles, time: Date.now() });
  }
}

// ── Main Endpoint ─────────────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();

  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) {
      return res.json({ articles: [...entry.data].sort(() => Math.random() - 0.5) }); // Shuffle
    }
  }

  try {
    const sources = RSS_SOURCES[cat] || RSS_SOURCES.all;
    const feeds = await Promise.allSettled(sources.map(s => parser.parseURL(s)));
    let items = feeds.filter(f => f.status === "fulfilled").flatMap(f => f.value.items || []);

    const seen = new Set();
    let articles = items.filter(it => {
      const key = it.title.substring(0, 35).toLowerCase();
      return seen.has(key) ? false : seen.add(key);
    }).map((it, idx) => {
      // Extract source from RSS title "Title - Source"
      const parts = it.title.split(" - ");
      const sourceFromRSS = parts.length > 1 ? parts[parts.length - 1].trim() : "FlashFeed";

      return {
        id: `${cat}-${idx}-${Date.now()}`,
        title: parts[0].trim(),
        source: sourceFromRSS, // Initial source from RSS
        description: it.contentSnippet || "",
        link: it.link,
        imageUrl: FALLBACK_IMAGES.all,
        category: cat
      };
    });

    // Send initial results (Shuffle for fresh feel)
    res.json({ articles: [...articles].sort(() => Math.random() - 0.5) });

    // Background Enrichment for 100% professional look
    enrichAll(articles, cat);

  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (_, res) => res.json({ status: "ok" }));
app.listen(5000, "0.0.0.0", () => console.log("🚀 Server Live"));

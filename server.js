const express = require("express");
const Parser = require("rss-parser");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
const parser = new Parser();
app.use(cors());
app.use(express.json());

// ── CACHE SETTINGS ────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 Minutes Cache

// ── FAST AXIOS INSTANCE ───────────────────────────────────────────────────────
const bot = axios.create({
  timeout: 5000, 
  headers: { 
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
  }
});

// ── RSS SOURCES (Hindi + English) ─────────────────────────────────────────────
const RSS_SOURCES = {
  india: ["https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-india-news"],
  world: ["https://news.google.com/rss/search?q=world&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  technology: ["https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en", "https://techcrunch.com/feed/"],
  business: ["https://news.google.com/rss/search?q=business&hl=en-IN&gl=IN&ceid=IN:en", "https://economictimes.indiatimes.com/rssfeedstopstories.cms"],
  sports: ["https://news.google.com/rss/search?q=sports&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvsports-latest"],
  hindi: [
    "https://news.google.com/rss/search?q=top+stories&hl=hi&gl=IN&ceid=IN:hi", 
    "https://ndtv.in/rss/top-stories", 
    "https://feeds.feedburner.com/aajtak",
    "https://www.bhaskar.com/rss/v1/2157"
  ],
  all: ["https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-top-stories"]
};

const FALLBACK_IMAGES = { 
  india: "https://images.unsplash.com/photo-1524492412937-b28074a5d7da?w=800",
  world: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800",
  technology: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800",
  business: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800",
  sports: "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?w=800",
  hindi: "https://images.unsplash.com/photo-1585675100414-22cb7f78e470?w=800",
  all: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800" 
};

// ── STRICT 85-WORD FORMATTING (5-6 LINES) ───────────────────────────────────
function formatProfessional(text, rssSnippet) {
  const content = (text && text.length > 120) ? text : (rssSnippet || "");
  const clean = content.replace(/\s+/g, " ").replace(/\[.*?\]/g, "").trim();
  const words = clean.split(" ");
  
  if (words.length <= 85) return clean;
  return words.slice(0, 85).join(" ") + "...";
}

// ── BULLETPROOF SCRAPER (No Missing Images/Sources) ─────────────────────────
async function scrapeDeep(url, category, rssSnippet, rssSource) {
  try {
    let finalUrl = url;
    if (url.includes("news.google.com")) {
      // Keep maxRedirects low for speed
      const res = await bot.get(url, { maxRedirects: 3 }); 
      finalUrl = res.request?.res?.responseUrl || url;
    }

    const { data } = await bot.get(finalUrl);
    const $ = cheerio.load(data);

    // Multi-tag Image Search
    const img = $('meta[property="og:image"]').attr("content") || 
                $('meta[name="twitter:image"]').attr("content") || "";
    
    // Multi-tag Source Search
    const siteName = $('meta[property="og:site_name"]').attr("content") || 
                     $('meta[name="application-name"]').attr("content") || 
                     rssSource;

    let paragraphs = [];
    $('p').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 80 && paragraphs.length < 8) paragraphs.push(txt);
    });

    // Valid Image Check
    const finalImage = (img && img.startsWith("http")) ? img : FALLBACK_IMAGES[category];

    return { 
      img: finalImage || FALLBACK_IMAGES.all, 
      summary: formatProfessional(paragraphs.join(" "), rssSnippet),
      siteName: siteName || "FlashFeed"
    };
  } catch {
    // If blocked, STRICTLY return fallbacks
    return { 
      img: FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all, 
      summary: formatProfessional("", rssSnippet), 
      siteName: rssSource 
    };
  }
}

// ── BACKGROUND AUTO-LOADER (Strict Image Replacement Lock) ──────────────────
async function autoLoadNext(articles, cat) {
  const BATCH = 3; 
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.all(batch.map(async (art) => {
      const details = await scrapeDeep(art.link, cat, art.description, art.source);
      
      // 🔥 THE LOCK: Update image ONLY if a valid new one was found
      if (details.img && details.img.length > 10) {
        art.imageUrl = details.img;
      }
      
      if (details.summary) art.description = details.summary;
      if (details.siteName) art.source = details.siteName;
    }));
    
    // Push progress to cache so next refresh gets enriched data
    cache.set(cat, { data: articles, time: Date.now() });
  }
}

// ── MAIN /news ENDPOINT ───────────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();

  // 1. Return Instant Cache (if available) with Shuffle
  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) {
      const shuffled = [...entry.data].sort(() => Math.random() - 0.5);
      return res.json({ articles: shuffled });
    }
  }

  // 2. Fetch Fresh Data
  try {
    const sources = RSS_SOURCES[cat] || RSS_SOURCES.all;
    const feeds = await Promise.allSettled(sources.map(s => parser.parseURL(s)));
    let items = feeds.filter(f => f.status === "fulfilled").flatMap(f => f.value.items || []);

    const seen = new Set();
    let articles = items.filter(it => {
      const key = it.title.substring(0, 35).toLowerCase();
      return seen.has(key) ? false : seen.add(key);
    }).map((it, idx) => {
      const parts = it.title.split(" - ");
      const sourceFromRSS = parts.length > 1 ? parts[parts.length - 1].trim() : "FlashFeed";

      return {
        id: `${cat}-${idx}-${Date.now()}`,
        title: parts[0].trim(),
        source: sourceFromRSS, 
        description: it.contentSnippet || "", 
        link: it.link,
        imageUrl: FALLBACK_IMAGES[cat] || FALLBACK_IMAGES.all, // Initial Fallback Setup
        category: cat
      };
    });

    // 3. Send FAST Initial Response (Shuffled)
    const initialResponse = [...articles].sort(() => Math.random() - 0.5);
    res.json({ articles: initialResponse });

    // 4. Start Background Deep Scrape
    autoLoadNext(articles, cat);

  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// ── UTILITY ENDPOINTS ─────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.get("/categories", (_, res) => res.json(Object.keys(RSS_SOURCES)));

// ── SERVER START ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 FlashFeed Turbo Live on Port ${PORT}`);
});

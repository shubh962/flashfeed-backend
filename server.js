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
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
  }
});

// ── RSS Sources with New HINDI Category ──────────────────────────────────────
const RSS_SOURCES = {
  india: ["https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-india-news"],
  world: ["https://news.google.com/rss/search?q=world&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  technology: ["https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en", "https://techcrunch.com/feed/"],
  business: ["https://news.google.com/rss/search?q=business&hl=en-IN&gl=IN&ceid=IN:en", "https://economictimes.indiatimes.com/rssfeedstopstories.cms"],
  sports: ["https://news.google.com/rss/search?q=sports&hl=en-IN&gl=IN&ceid=IN:en"],
  hindi: [
    "https://news.google.com/rss/search?q=top+stories&hl=hi&gl=IN&ceid=IN:hi", 
    "https://ndtv.in/rss/top-stories", 
    "https://feeds.feedburner.com/aajtak",
    "https://www.bhaskar.com/rss/v1/2157"
  ],
  all: ["https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-top-stories"]
};

const FALLBACK_IMAGES = { all: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800" };

// ── FEATURE: Professional 85-Word Formatting ────────────────────────────────
function formatProfessional(text, rssSnippet) {
  const content = (text && text.length > 120) ? text : (rssSnippet || "");
  const clean = content.replace(/\s+/g, " ").replace(/\[.*?\]/g, "").trim();
  const words = clean.split(" ");
  
  // 🔥 Strict Format: Har news 85 words ki hogi (approx 5-6 lines)
  if (words.length <= 85) return clean;
  return words.slice(0, 85).join(" ") + "...";
}

// ── FEATURE: Deep Scrape with High Priority for Images & Source ─────────────
async function scrapeDeep(url, category, rssSnippet, rssSource) {
  try {
    let finalUrl = url;
    if (url.includes("news.google.com")) {
      const res = await bot.get(url, { maxRedirects: 5 });
      finalUrl = res.request?.res?.responseUrl || url;
    }

    const { data } = await bot.get(finalUrl);
    const $ = cheerio.load(data);

    // Image Extraction (Multiple Selectors)
    const img = $('meta[property="og:image"]').attr("content") || 
                $('meta[name="twitter:image"]').attr("content") || 
                $('meta[itemprop="image"]').attr("content") || "";
    
    // Source Extraction
    const siteName = $('meta[property="og:site_name"]').attr("content") || 
                     $('meta[name="application-name"]').attr("content") || 
                     rssSource;

    let paragraphs = [];
    $('p').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 80 && paragraphs.length < 10) paragraphs.push(txt);
    });

    return { 
      img: (img && img.startsWith("http")) ? img : (FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all), 
      summary: formatProfessional(paragraphs.join(" "), rssSnippet),
      siteName: siteName || "FlashFeed"
    };
  } catch {
    return { img: FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all, summary: formatProfessional("", rssSnippet), siteName: rssSource };
  }
}

// ── FEATURE: Auto-Loading in Background ──────────────────────────────────────
async function autoLoadNext(articles, cat) {
  const BATCH = 3; 
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.all(batch.map(async (art) => {
      const details = await scrapeDeep(art.link, cat, art.description, art.source);
      art.imageUrl = details.img;
      art.description = details.summary;
      art.source = details.siteName;
    }));
    cache.set(cat, { data: articles, time: Date.now() });
  }
}

// ── MAIN ENDPOINT ────────────────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();

  // 1. Instant Cache Return with Shuffle
  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) {
      const shuffled = [...entry.data].sort(() => Math.random() - 0.5);
      return res.json({ articles: shuffled });
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
      const parts = it.title.split(" - ");
      return {
        id: `${cat}-${idx}-${Date.now()}`,
        title: parts[0].trim(),
        source: parts.length > 1 ? parts[parts.length - 1].trim() : "News",
        description: it.contentSnippet || "",
        link: it.link,
        imageUrl: FALLBACK_IMAGES.all,
        category: cat
      };
    });

    // 2. Respond FAST with RSS titles
    const initialResponse = [...articles].sort(() => Math.random() - 0.5);
    res.json({ articles: initialResponse });

    // 3. Start Background Enrichment (Deep Scrape)
    autoLoadNext(articles, cat);

  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.get("/categories", (_, res) => res.json(Object.keys(RSS_SOURCES)));

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 FlashFeed Live on ${PORT}`));

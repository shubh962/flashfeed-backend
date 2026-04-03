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
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
  },
  maxContentLength: 1000000, // Increased to 1MB for deep scraping
});

const RSS_SOURCES = {
  india: ["https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-india-news", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"],
  world: ["https://news.google.com/rss/search?q=world&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  technology: ["https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en", "https://techcrunch.com/feed/"],
  business: ["https://news.google.com/rss/search?q=business&hl=en-IN&gl=IN&ceid=IN:en", "https://economictimes.indiatimes.com/rssfeedstopstories.cms"],
  sports: ["https://news.google.com/rss/search?q=sports&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvsports-latest"],
  all: ["https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-top-stories", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"]
};

const FALLBACK_IMAGES = {
  all: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800"
};

// ── PROFESSIONAL FORMATTING (Strict 85 Words) ─────────────────────────────
function formatText(text, rssSnippet) {
  const baseText = (text && text.length > 150) ? text : (rssSnippet || "");
  const clean = baseText.replace(/\s+/g, " ").replace(/\[.*?\]/g, "").trim();
  const words = clean.split(" ");
  
  // Har news ko professional 85 words ka block banata hai
  if (words.length <= 85) return clean;
  return words.slice(0, 85).join(" ") + "...";
}

// ── DEEP SCRAPER (Images + Full Content) ──────────────────────────────────
async function scrapeDeep(url, rssSnippet) {
  try {
    let finalUrl = url;
    if (url.includes("news.google.com")) {
      const res = await bot.get(url, { maxRedirects: 5 });
      finalUrl = res.request?.res?.responseUrl || url;
    }

    const { data } = await bot.get(finalUrl);
    const $ = cheerio.load(data);

    // Multiple image selectors for better success rate
    const img = $('meta[property="og:image"]').attr("content") || 
                $('meta[name="twitter:image"]').attr("content") || 
                $('meta[itemprop="image"]').attr("content") || 
                $('article img').first().attr("src") || "";
    
    let paragraphs = [];
    $('p').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 80 && paragraphs.length < 12) paragraphs.push(txt);
    });

    const fullText = paragraphs.join(" ");
    return { 
      img: (img && img.startsWith("http")) ? img : "", 
      summary: formatText(fullText, rssSnippet),
      siteName: $('meta[property="og:site_name"]').attr("content") || "" 
    };
  } catch (e) {
    return { img: "", summary: formatText("", rssSnippet), siteName: "" };
  }
}

// ── AUTO-ENRICHER (Infinite Load in Background) ───────────────────────────
async function enrichAll(articles, cat) {
  const BATCH_SIZE = 3; 
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (art) => {
      // Sirf unhe enrich karo jo abhi tak fallback par hain
      const details = await scrapeDeep(art.link, art.description);
      if (details.img) art.imageUrl = details.img;
      art.description = details.summary; // 5-6 lines content
      if (details.siteName) art.source = details.siteName;
    }));
    // Har batch ke baad cache update karo taaki user ko result milte rahein
    cache.set(cat, { data: articles, time: Date.now() });
  }
}

// ── MAIN ROUTE ────────────────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();

  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) {
      // Shuffle on every refresh for "New News" feel
      const shuffled = [...entry.data].sort(() => Math.random() - 0.5);
      return res.json({ articles: shuffled });
    }
  }

  try {
    const sources = RSS_SOURCES[cat] || RSS_SOURCES.all;
    const feedResults = await Promise.allSettled(sources.map(s => parser.parseURL(s)));
    let items = feedResults.filter(r => r.status === "fulfilled").flatMap(r => r.value.items || []);

    const seen = new Set();
    let articles = items.filter(it => {
      const key = it.title.substring(0, 35).toLowerCase();
      return seen.has(key) ? false : seen.add(key);
    }).map((it, idx) => ({
      id: `${cat}-${idx}-${Date.now()}`,
      title: it.title.split(" - ")[0].trim(),
      source: it.title.split(" - ").pop().trim() || "FlashFeed",
      description: it.contentSnippet || "",
      link: it.link,
      imageUrl: FALLBACK_IMAGES.all,
      category: cat
    }));

    // Respond INSTANTLY to user
    res.json({ articles: [...articles].sort(() => Math.random() - 0.5) });

    // Start full enrichment in background
    enrichAll(articles, cat);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ FlashFeed MAX running on ${PORT}`);
});

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
const CACHE_TTL = 10 * 60 * 1000; // 10 min cache for stability

const RSS_SOURCES = {
  india: ["https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-india-news"],
  world: ["https://news.google.com/rss/search?q=world+news&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  technology: ["https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en", "https://techcrunch.com/feed/"],
  business: ["https://news.google.com/rss/search?q=business+india&hl=en-IN&gl=IN&ceid=IN:en", "https://economictimes.indiatimes.com/rssfeedstopstories.cms"],
  sports: ["https://news.google.com/rss/search?q=cricket+ipl+sports&hl=en-IN&gl=IN&ceid=IN:en"],
  all: ["https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-top-stories"]
};

const FALLBACK_IMAGES = {
  all: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800"
};

// ── RESOLVE GOOGLE URL ──────────────────────────────────────────────────────
async function resolveUrl(url) {
  try {
    if (!url.includes("news.google.com")) return url;
    const res = await axios.get(url, { timeout: 2500, maxRedirects: 5 });
    return res.request?.res?.responseUrl || url;
  } catch { return url; }
}

// ── FETCH IMAGE & BODY (STABLE VERSION) ──────────────────────────────────────
async function fetchDetails(rawUrl) {
  try {
    const url = await resolveUrl(rawUrl);
    const { data } = await axios.get(url, { 
      timeout: 3500, // Balanced timeout
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    const $ = cheerio.load(data);
    
    // 1. Image Priority
    const img = $('meta[property="og:image"]').attr("content") || 
                $('meta[name="twitter:image"]').attr("content") || "";

    // 2. Body Text (4-5 lines logic)
    let bodyText = "";
    $('p').each((i, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 80 && bodyText.length < 450) bodyText += txt + " ";
    });

    return { img, bodyText: bodyText.trim() };
  } catch { return { img: "", bodyText: "" }; }
}

// ── PARALLEL PROCESSING (BATCH SIZE 5 FOR STABILITY) ────────────────────────
async function processArticles(articles, category) {
  const BATCH = 5; 
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    const details = await Promise.all(batch.map(a => fetchDetails(a.link)));
    
    details.forEach((det, j) => {
      const idx = i + j;
      articles[idx].imageUrl = det.img || FALLBACK_IMAGES.all;
      if (det.bodyText && det.bodyText.length > 50) {
        articles[idx].description = det.bodyText;
      }
    });
  }
  return articles;
}

// ── ENDPOINT ────────────────────────────────────────────────────────────────
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

    let articles = items.map((it, idx) => ({
      id: `${cat}-${idx}`,
      title: it.title.split(" - ")[0],
      source: it.title.split(" - ").pop() || "FlashFeed",
      description: it.contentSnippet || "",
      link: it.link,
      imageUrl: FALLBACK_IMAGES.all,
      category: cat
    }));

    articles = await processArticles(articles, cat);
    cache.set(cat, { data: articles, time: Date.now() });

    res.json({ articles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(5000, "0.0.0.0", () => console.log("🚀 Server Live on 5000"));

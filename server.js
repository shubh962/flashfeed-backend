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
const CACHE_TTL = 10 * 60 * 1000; 

const bot = axios.create({
  timeout: 4000, // Timeout thoda badhaya taaki content miss na ho
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  maxContentLength: 500000,
});

const RSS_SOURCES = {
  india: ["https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-india-news"],
  world: ["https://news.google.com/rss/search?q=world&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  technology: ["https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en", "https://techcrunch.com/feed/"],
  business: ["https://news.google.com/rss/search?q=business&hl=en-IN&gl=IN&ceid=IN:en", "https://economictimes.indiatimes.com/rssfeedstopstories.cms"],
  sports: ["https://news.google.com/rss/search?q=sports&hl=en-IN&gl=IN&ceid=IN:en"],
  all: ["https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-top-stories"],
};

const FALLBACK_IMAGES = { all: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800" };

// ── Shuffle Function ────────────────────────────────────────────────────────
function getShuffled(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

// ── Summary Logic (80-100 words target) ─────────────────────────────────────
function makeSummary(text, fallback = "") {
  if (!text || text.length < 50) return fallback; 
  const clean = text.replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  if (words.length <= 100) return clean;
  return words.slice(0, 100).join(" ") + "...";
}

// ── Deep Scrape Fix ─────────────────────────────────────────────────────────
async function scrapeDeep(url, category, rssSnippet = "") {
  try {
    let finalUrl = url;
    if (url.includes("news.google.com")) {
      const res = await bot.get(url, { maxRedirects: 5 });
      finalUrl = res.request?.res?.responseUrl || url;
    }

    const { data } = await bot.get(finalUrl);
    const $ = cheerio.load(data);

    const img = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
    
    let paragraphs = [];
    $('p').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 80 && paragraphs.length < 8) paragraphs.push(txt);
    });

    const bodyText = paragraphs.join(" ");
    // Agar scraping se kuch nahi mila, toh RSS snippet use karo
    const summary = makeSummary(bodyText, rssSnippet);
    const siteName = $('meta[property="og:site_name"]').attr("content") || "";

    return { img, summary, siteName };
  } catch {
    return { img: "", summary: rssSnippet, siteName: "" };
  }
}

// ── Background Worker ───────────────────────────────────────────────────────
async function enrichArticles(articles, cat) {
  const BATCH = 4;
  for (let i = 5; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.all(batch.map(async (art) => {
      const details = await scrapeDeep(art.link, cat, art.description);
      if (details.img) art.imageUrl = details.img;
      if (details.summary) art.description = details.summary;
      if (details.siteName) art.source = details.siteName;
    }));
    cache.set(cat, { data: articles, time: Date.now() });
  }
}

// ── /news Route ─────────────────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();

  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) {
      // 🔥 Fix: Har refresh par shuffle karke bhejo
      return res.json({ articles: getShuffled(entry.data).slice(0, 20) });
    }
  }

  try {
    const sources = RSS_SOURCES[cat] || RSS_SOURCES.all;
    const feeds = await Promise.allSettled(sources.map(s => parser.parseURL(s)));
    let items = feeds.filter(f => f.status === "fulfilled").flatMap(f => f.value?.items || []);

    const seen = new Set();
    let articles = items.filter(it => {
      const key = it.title.substring(0, 30).toLowerCase();
      return seen.has(key) ? false : seen.add(key);
    }).map((it, idx) => ({
      id: `${cat}-${idx}-${Date.now()}`,
      title: it.title.split(" - ")[0].trim(),
      source: it.title.split(" - ").pop().trim() || "News",
      description: it.contentSnippet || "", // Fallback initial
      link: it.link,
      imageUrl: FALLBACK_IMAGES.all,
      category: cat
    }));

    // 🔥 Pehle 5 news turant enrich karo (Images + Long Text)
    const topBatch = articles.slice(0, 5);
    await Promise.all(topBatch.map(async (art) => {
      const details = await scrapeDeep(art.link, cat, art.description);
      if (details.img) art.imageUrl = details.img;
      if (details.summary) art.description = details.summary;
    }));

    cache.set(cat, { data: articles, time: Date.now() });
    res.json({ articles: getShuffled(articles).slice(0, 20) });

    enrichArticles(articles, cat);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (_, res) => res.json({ status: "ok" }));
app.listen(5000, "0.0.0.0", () => console.log("🚀 Turbo Server Ready"));

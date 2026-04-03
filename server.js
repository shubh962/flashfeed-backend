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
  timeout: 5000, // Increased for stability
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  maxContentLength: 600000,
});

// ── FEATURE: Professional Formatting (Strict 80-90 Words) ──────────────────
function formatProfessional(text, fallback) {
  const content = (text && text.length > 100) ? text : fallback;
  const clean = content.replace(/\s+/g, " ").replace(/\[.*?\]/g, "").trim();
  const words = clean.split(" ");
  
  // 🔥 Strict Format: Har news 85 words ki hogi (approx 6 lines)
  if (words.length <= 85) return clean;
  return words.slice(0, 85).join(" ") + "...";
}

// ── FEATURE: Deep Scrape with High Priority for Images ──────────────────────
async function scrapeDeep(url, category, rssSnippet = "") {
  try {
    let finalUrl = url;
    if (url.includes("news.google.com")) {
      const res = await bot.get(url, { maxRedirects: 5 });
      finalUrl = res.request?.res?.responseUrl || url;
    }

    const { data } = await bot.get(finalUrl);
    const $ = cheerio.load(data);

    // Image extraction logic
    const img = $('meta[property="og:image"]').attr("content") || 
                $('meta[name="twitter:image"]').attr("content") || 
                $('meta[itemprop="image"]').attr("content") || "";
    
    let paragraphs = [];
    $('p').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.length > 60 && paragraphs.length < 10) paragraphs.push(txt);
    });

    const fullText = paragraphs.join(" ");
    return { 
      img: img.startsWith("http") ? img : "", 
      summary: formatProfessional(fullText, rssSnippet),
      siteName: $('meta[property="og:site_name"]').attr("content") || "" 
    };
  } catch {
    return { img: "", summary: formatProfessional("", rssSnippet), siteName: "" };
  }
}

// ── FEATURE: Auto-Loading / Background Enrichment ───────────────────────────
async function autoLoadNext(articles, cat) {
  // 🚀 Process in small chunks to keep server responsive
  for (let i = 0; i < articles.length; i += 3) {
    const batch = articles.slice(i, i + 3);
    await Promise.all(batch.map(async (art) => {
      if (art.description.length < 200 || art.imageUrl.includes("unsplash")) {
        const details = await scrapeDeep(art.link, cat, art.description);
        if (details.img) art.imageUrl = details.img;
        art.description = details.summary;
        if (details.siteName) art.source = details.siteName;
      }
    }));
    // Save progress so user sees images while scrolling
    cache.set(cat, { data: articles, time: Date.now() });
  }
}

app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();

  if (cache.has(cat)) {
    const entry = cache.get(cat);
    if (Date.now() - entry.time < CACHE_TTL) {
      // Shuffle for freshness on every refresh
      const shuffled = [...entry.data].sort(() => Math.random() - 0.5);
      return res.json({ articles: shuffled });
    }
  }

  try {
    const sources = RSS_SOURCES[cat] || RSS_SOURCES.all;
    const feeds = await Promise.allSettled(sources.map(s => parser.parseURL(s)));
    let items = feeds.filter(f => f.status === "fulfilled").flatMap(f => f.value?.items || []);

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
      imageUrl: FALLBACK_IMAGES[cat] || FALLBACK_IMAGES.all,
      category: cat
    }));

    // 🔥 Fix: Send initial response FAST, then enrich in background
    res.json({ articles: articles.sort(() => Math.random() - 0.5) });

    // Start background enrichment (Auto-load images/content)
    autoLoadNext(articles, cat);

  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (_, res) => res.json({ status: "ok" }));
app.listen(5000, "0.0.0.0", () => console.log("🚀 Turbo Server Live"));

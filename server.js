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
const CACHE_TTL = 5 * 60 * 1000;

function getCache(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

const RSS_SOURCES = {
  india: ["https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-india-news"],
  world: ["https://news.google.com/rss/search?q=world+news&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  technology: ["https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en", "https://techcrunch.com/feed/"],
  business: ["https://news.google.com/rss/search?q=business+india&hl=en-IN&gl=IN&ceid=IN:en", "https://economictimes.indiatimes.com/rssfeedstopstories.cms"],
  sports: ["https://news.google.com/rss/search?q=cricket+ipl+sports&hl=en-IN&gl=IN&ceid=IN:en"],
  entertainment: ["https://news.google.com/rss/search?q=bollywood+entertainment&hl=en-IN&gl=IN&ceid=IN:en"],
  science: ["https://news.google.com/rss/search?q=science+isro+space&hl=en-IN&gl=IN&ceid=IN:en"],
  health: ["https://news.google.com/rss/search?q=health+medical+india&hl=en-IN&gl=IN&ceid=IN:en"],
  all: ["https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-top-stories"],
};

const FALLBACK_IMAGES = {
  all: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800",
};

// ── FIX 1: Resolve Google News URL ──────────────────────────────────────────
async function resolveGoogleNewsUrl(url) {
  try {
    if (!url.includes("news.google.com")) return url;
    const res = await axios.get(url, { timeout: 3000, maxRedirects: 5, headers: { "User-Agent": "Mozilla/5.0" } });
    return res.request?.res?.responseUrl || res.config?.url || url;
  } catch { return url; }
}

// ── FIX 2: Better Image & Content Extraction ────────────────────────────────
async function fetchDetails(rawUrl) {
  try {
    const url = await resolveGoogleNewsUrl(rawUrl);
    const { data } = await axios.get(url, { timeout: 3000, headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(data);
    
    const img = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
    
    // 🔥 NEW: Extract the first substantial paragraph for more depth
    let bodyText = "";
    $('p').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 100 && bodyText.length < 300) bodyText += text + " ";
    });

    return { img, bodyText: bodyText.trim() };
  } catch { return { img: "", bodyText: "" }; }
}

// ── FIX 3: 4-5 Lines Clean Summary Logic ────────────────────────────────────
function cleanDescription(itemContent, scrapedBody = "") {
  // Prefer scraped body text if available, else fallback to RSS snippet
  let text = scrapedBody.length > 50 ? scrapedBody : (itemContent || "");
  
  // Clean HTML and remove common RSS junk
  let clean = text.replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').trim();
  
  // If it's still too short, we return a combined version
  if (clean.length < 150 && itemContent) {
     clean = itemContent.replace(/<[^>]*>?/gm, '').split('\n')[0];
  }

  // Return exactly around 350-450 chars for 4-5 lines on mobile
  return clean.length > 450 ? clean.substring(0, 450) + "..." : clean;
}

async function fetchImagesParallel(articles, category) {
  const BATCH = 8;
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    const details = await Promise.all(batch.map(a => fetchDetails(a.link)));
    details.forEach((det, j) => {
      articles[i + j].imageUrl = det.img || FALLBACK_IMAGES[category] || FALLBACK_IMAGES.all;
      // 🔥 Update description with deeper content if found
      if (det.bodyText) articles[i + j].description = cleanDescription("", det.bodyText);
    });
  }
  return articles;
}

// ── /news Endpoint ──────────────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  const category = (req.query.category || "all").toLowerCase();
  const page = parseInt(req.query.page || "1");
  const limit = parseInt(req.query.limit || "20");

  const cached = getCache(category);
  if (cached) {
    const start = (page - 1) * limit;
    return res.json({ articles: cached.slice(start, start + limit), total: cached.length, hasMore: start + limit < cached.length });
  }

  try {
    const sources = RSS_SOURCES[category] || RSS_SOURCES.all;
    const feedResults = await Promise.allSettled(sources.map(url => parser.parseURL(url)));
    
    let allItems = feedResults.filter(r => r.status === "fulfilled").flatMap(r => r.value.items || []);
    
    // Deduplicate and slice
    const seen = new Set();
    allItems = allItems.filter(item => {
      const key = item.title.toLowerCase().substring(0, 30);
      return seen.has(key) ? false : seen.add(key);
    }).slice(0, 60);

    let articles = allItems.map((item, idx) => ({
      id: `${category}-${idx}-${Date.now()}`,
      title: item.title.split(" - ")[0],
      source: item.title.split(" - ").pop() || "News",
      description: cleanDescription(item.contentSnippet || item.content),
      link: item.link,
      date: item.pubDate,
      imageUrl: FALLBACK_IMAGES.all,
      category
    }));

    articles = await fetchImagesParallel(articles, category);
    setCache(category, articles);

    const start = (page - 1) * limit;
    res.json({ articles: articles.slice(start, start + limit), total: articles.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`⚡ FlashFeed Live on ${PORT}`));

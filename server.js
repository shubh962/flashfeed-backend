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

// 🟢 Sources list to get 100+ news items
const SOURCES = {
  all: ["https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"],
  india: ["https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en", "https://feeds.feedburner.com/ndtvnews-india-news"],
  technology: ["https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en", "https://techcrunch.com/feed/"]
};

async function fetchRealImage(url) {
  try {
    const { data } = await axios.get(url, { timeout: 1500, headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(data);
    return $('meta[property="og:image"]').attr("content") || "";
  } catch { return ""; }
}

app.get("/news", async (req, res) => {
  const cat = (req.query.category || "all").toLowerCase();
  
  try {
    const urls = SOURCES[cat] || SOURCES.all;
    const feedResults = await Promise.all(urls.map(u => parser.parseURL(u)));
    let items = feedResults.flatMap(f => f.items);

    // 1. DEDUPLICATION: Remove repeat news
    const uniqueMap = new Map();
    items.forEach(item => uniqueMap.set(item.title, item));
    const uniqueList = Array.from(uniqueMap.values()).slice(0, 100);

    // 2. IMAGE LOGIC: Real Scrape for top 10, Unique Random for rest
    const articles = await Promise.all(uniqueList.map(async (item, i) => {
      let img = "";
      if (i < 10) img = await fetchRealImage(item.link);

      return {
        id: Buffer.from(item.title).toString('base64').substring(0, 10), // Unique ID
        title: item.title.split(" - ")[0],
        source: item.title.split(" - ")[1] || "FlashFeed",
        description: item.contentSnippet || "",
        link: item.link,
        date: "Recently",
        // 🔥 FIX: Using 'seed' ensures every article gets a DIFFERENT random image if scrape fails
        imageUrl: img || `https://picsum.photos/seed/${encodeURIComponent(item.title)}/800/500`,
        category: cat
      };
    }));

    res.json({ articles });
  } catch (e) {
    res.status(500).json({ error: "Fetch failed" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Unlimited News Server Live`));

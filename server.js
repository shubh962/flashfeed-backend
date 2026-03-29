const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const googleTrends = require("google-trends-api");

const app = express();
const parser = new Parser();

// 1. Enable CORS for all origins (Crucial for Flutter Web)
app.use(cors());

/* ---------------- IMAGE EXTRACT ---------------- */
async function getImageFromArticle(url) {
  try {
    // Some sites block axios; we use a User-Agent to look like a browser
    const { data } = await axios.get(url, { 
      timeout: 3000,
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    const $ = cheerio.load(data);
    const ogImage = $('meta[property="og:image"]').attr("content");
    return ogImage || "";
  } catch {
    return "";
  }
}

/* ---------------- TRENDING ---------------- */
async function getTrendingTopics() {
  try {
    const data = await googleTrends.dailyTrends({ geo: "IN" });
    const parsed = JSON.parse(data);
    const trends = parsed.default.trendingSearchesDays[0].trendingSearches;
    return trends.slice(0, 8).map((t) => t.title.query);
  } catch (e) {
    return ["India", "Cricket", "Technology", "Bollywood", "Finance"];
  }
}

/* ---------------- NEWS API ---------------- */
app.get("/news", async (req, res) => {
  try {
    let category = (req.query.category || "all").toLowerCase();
    let keywordsToSearch = [];

    if (category === "all") {
      keywordsToSearch = await getTrendingTopics();
    } else {
      keywordsToSearch = [category];
    }

    const newsResults = [];

    // Fetch news for each keyword
    for (let keyword of keywordsToSearch) {
      try {
        const feed = await parser.parseURL(
          `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=en-IN&gl=IN&ceid=IN:en`
        );

        // Limit articles per keyword to keep response fast
        const limit = category === "all" ? 2 : 10;
        const items = await Promise.all(
          feed.items.slice(0, limit).map(async (item) => {
            let image = await getImageFromArticle(item.link);
            
            return {
              title: item.title || "",
              description: item.contentSnippet || "",
              link: item.link || "",
              date: item.pubDate || "",
              imageUrl: image || `https://picsum.photos/600/400?random=${Math.random()}`,
              keyword: keyword, // 🔥 FIXED: Always include keyword for Flutter mapping
            };
          })
        );
        newsResults.push(...items);
      } catch (err) {
        console.log(`❌ Keyword ${keyword} failed`);
      }
    }

    res.json(newsResults);

  } catch (error) {
    console.error("🔥 API ERROR:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/", (req, res) => {
  res.send("🚀 FlashFeed Backend is Live!");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

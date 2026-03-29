const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const googleTrends = require("google-trends-api");

const app = express();
const parser = new Parser();

app.use(cors());

/* ---------------- ENHANCED IMAGE SCRAPER ---------------- */
async function getImageFromArticle(url) {
  try {
    // Mimic a real browser to avoid being blocked
    const { data } = await axios.get(url, { 
      timeout: 5000, 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
      } 
    });
    const $ = cheerio.load(data);
    
    // Priority 1: Open Graph Image
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) return ogImage;

    // Priority 2: Twitter Image
    const twitterImage = $('meta[name="twitter:image"]').attr("content");
    if (twitterImage) return twitterImage;

    return "";
  } catch {
    return "";
  }
}

/* ---------------- TRENDING LOGIC ---------------- */
async function getTrendingTopics() {
  try {
    const data = await googleTrends.dailyTrends({ geo: "IN" });
    const parsed = JSON.parse(data);
    const trends = parsed.default.trendingSearchesDays[0].trendingSearches;
    return trends.slice(0, 8).map((t) => t.title.query);
  } catch (e) {
    return ["India", "World News", "Tech", "Sports", "Stocks"];
  }
}

/* ---------------- NEWS API ---------------- */
app.get("/news", async (req, res) => {
  try {
    let category = (req.query.category || "all").toLowerCase();
    let searchKeywords = (category === "all") ? await getTrendingTopics() : [category];

    const results = [];

    for (let keyword of searchKeywords) {
      try {
        const feed = await parser.parseURL(
          `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=en-IN&gl=IN&ceid=IN:en`
        );

        // Map items with images
        const limit = (category === "all") ? 2 : 12;
        const items = await Promise.all(
          feed.items.slice(0, limit).map(async (item) => {
            const image = await getImageFromArticle(item.link);
            
            return {
              title: item.title || "",
              description: item.contentSnippet || "",
              link: item.link || "",
              date: item.pubDate || "",
              imageUrl: image || `https://picsum.photos/seed/${Math.random()}/600/400`,
              keyword: keyword,
            };
          })
        );
        results.push(...items);
      } catch (err) {
        console.log(`Failed for ${keyword}`);
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
});

app.get("/", (req, res) => res.send("FlashFeed API v2 - Inshorts Mode"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Port ${PORT}`));

const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const parser = new Parser();
app.use(cors());

async function fetchImage(url) {
  try {
    const { data } = await axios.get(url, { 
      timeout: 2000, // Very fast timeout to keep the 100+ loop moving
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    const $ = cheerio.load(data);
    return $('meta[property="og:image"]').attr("content") || "";
  } catch { return ""; }
}

app.get("/news", async (req, res) => {
  try {
    const category = (req.query.category || "india").toLowerCase();
    
    // 🚀 MEGA FETCH: We pull from 3 different localized RSS feeds to get 100+ unique items
    const sources = [
      `https://news.google.com/rss/search?q=${category}&hl=en-IN&gl=IN&ceid=IN:en`,
      `https://news.google.com/rss/search?q=${category}&hl=en-US&gl=US&ceid=US:en`,
      `https://news.google.com/rss/search?q=${category}&hl=en-GB&gl=GB&ceid=GB:en`
    ];

    const feeds = await Promise.all(sources.map(url => parser.parseURL(url)));
    let allItems = feeds.flatMap(f => f.items);

    // Remove duplicates based on title
    const uniqueItems = Array.from(new Map(allItems.map(item => [item.title, item])).values());
    
    // Shuffle for a "New Every Time" feel
    const shuffled = uniqueItems.sort(() => Math.random() - 0.5).slice(0, 120);

    const newsItems = await Promise.all(
      shuffled.map(async (item) => {
        const image = await fetchImage(item.link);
        const parts = item.title.split(" - ");
        return {
          title: parts[0] || "",
          source: parts[1] || "Global News",
          description: item.contentSnippet || "",
          link: item.link,
          date: item.pubDate,
          imageUrl: image || `https://picsum.photos/seed/${Math.random()}/800/500`,
          keyword: category
        };
      })
    );

    res.json(newsItems);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch 100+ items" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Mega-Scraper Active`));

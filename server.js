const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");

const app = express();
const parser = new Parser();

app.use(cors());

// 👉 News API
app.get("/news", async (req, res) => {
  try {
    const category = (req.query.category || "general").toLowerCase();

    const urls = {
      business: "https://news.google.com/rss/search?q=business&hl=en-IN&gl=IN&ceid=IN:en",
      technology: "https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en",
      sports: "https://news.google.com/rss/search?q=sports&hl=en-IN&gl=IN&ceid=IN:en",
      india: "https://news.google.com/rss/search?q=india&hl=en-IN&gl=IN&ceid=IN:en",
      world: "https://news.google.com/rss/search?q=world&hl=en-IN&gl=IN&ceid=IN:en",
      entertainment: "https://news.google.com/rss/search?q=entertainment&hl=en-IN&gl=IN&ceid=IN:en",
      science: "https://news.google.com/rss/search?q=science&hl=en-IN&gl=IN&ceid=IN:en",
      health: "https://news.google.com/rss/search?q=health&hl=en-IN&gl=IN&ceid=IN:en",
      general: "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en"
    };

    const feedUrl = urls[category] || urls["general"];
    const feed = await parser.parseURL(feedUrl);

    // 🔥 FINAL CLEAN LOGIC
    const news = feed.items.slice(0, 10).map((item, index) => {

      // ✅ unique + fast image
      const image = `https://picsum.photos/600/400?random=${Date.now() + index}`;

      return {
        title: item.title || "",
        description: item.contentSnippet || "",
        link: item.link || "",
        date: item.pubDate || "",
        imageUrl: image
      };
    });

    res.json(news);

  } catch (error) {
    console.error("Error fetching news:", error);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

// 👉 Root route
app.get("/", (req, res) => {
  res.send("News API is running 🚀");
});

// 👉 Start server
app.listen(5000, "0.0.0.0", () => {
  console.log("Server running on http://0.0.0.0:5000");
});
const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const parser = new Parser();

app.use(cors());

// 🔥 Extract image from article
async function getImageFromArticle(url) {
  try {
    const { data } = await axios.get(url, { timeout: 4000 });
    const $ = cheerio.load(data);

    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) return ogImage;

    const img = $("img").first().attr("src");
    return img || "";
  } catch (e) {
    return "";
  }
}

// 👉 API
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

    const feedUrl = urls[category] || urls.general;

    const feed = await parser.parseURL(feedUrl);

    const news = await Promise.all(
      feed.items.slice(0, 5).map(async (item) => {

        let image = "";

        if (item.enclosure?.url) {
          image = item.enclosure.url;
        }

        if (!image && item.link) {
          image = await getImageFromArticle(item.link);
        }

        if (!image) {
          image = `https://picsum.photos/600/400?random=${Math.random()}`;
        }

        return {
          title: item.title || "",
          description: item.contentSnippet || "",
          link: item.link || "",
          date: item.pubDate || "",
          imageUrl: image
        };
      })
    );

    res.json(news);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

// root
app.get("/", (req, res) => {
  res.send("News API is running 🚀");
});

// 🔥 FIX HERE (IMPORTANT)
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

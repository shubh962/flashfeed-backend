const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const googleTrends = require("google-trends-api");

const app = express();
const parser = new Parser();

app.use(cors());

// 🔥 Get image
async function getImageFromArticle(url) {
  try {
    const { data } = await axios.get(url, { timeout: 4000 });
    const $ = cheerio.load(data);

    return $('meta[property="og:image"]').attr("content") || "";
  } catch {
    return "";
  }
}

// 🔥 Get trending topics (India)
async function getTrendingTopics() {
  try {
    const data = await googleTrends.dailyTrends({
      geo: "IN",
    });

    const parsed = JSON.parse(data);

    const trends =
      parsed.default.trendingSearchesDays[0].trendingSearches;

    return trends.slice(0, 5).map((t) => t.title.query);
  } catch (e) {
    console.log("Trends error:", e);
    return ["India", "Technology", "Business"];
  }
}

// 👉 API
app.get("/news", async (req, res) => {
  try {
    let category = (req.query.category || "general").toLowerCase();

    if (category === "all") {
      // 🔥 DYNAMIC TRENDING NEWS
      const trends = await getTrendingTopics();

      const news = [];

      for (let keyword of trends) {
        const feed = await parser.parseURL(
          `https://news.google.com/rss/search?q=${encodeURIComponent(
            keyword
          )}&hl=en-IN&gl=IN&ceid=IN:en`
        );

        const items = await Promise.all(
          feed.items.slice(0, 1).map(async (item) => {
            let image = await getImageFromArticle(item.link);

            if (!image) {
              image = `https://picsum.photos/600/400?random=${Math.random()}`;
            }

            return {
              title: item.title,
              description: item.contentSnippet,
              link: item.link,
              date: item.pubDate,
              imageUrl: image,
              keyword: keyword, // 🔥 show trend
            };
          })
        );

        news.push(...items);
      }

      return res.json(news);
    }

    // 👉 NORMAL CATEGORY NEWS
    const feed = await parser.parseURL(
      `https://news.google.com/rss/search?q=${category}&hl=en-IN&gl=IN&ceid=IN:en`
    );

    const news = await Promise.all(
      feed.items.slice(0, 5).map(async (item) => {
        let image = await getImageFromArticle(item.link);

        if (!image) {
          image = `https://picsum.photos/600/400?random=${Math.random()}`;
        }

        return {
          title: item.title,
          description: item.contentSnippet,
          link: item.link,
          date: item.pubDate,
          imageUrl: image,
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
  res.send("🔥 FlashFeed AI Trending API running");
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
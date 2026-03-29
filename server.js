const express = require("express");
const Parser = require("rss-parser");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const googleTrends = require("google-trends-api");

const app = express();
const parser = new Parser();

app.use(cors());

/* ---------------- IMAGE EXTRACT ---------------- */
async function getImageFromArticle(url) {
  try {
    const { data } = await axios.get(url, { timeout: 4000 });
    const $ = cheerio.load(data);

    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) return ogImage;

    return "";
  } catch {
    return "";
  }
}

/* ---------------- TRENDING ---------------- */
async function getTrendingTopics() {
  try {
    const data = await googleTrends.dailyTrends({ geo: "IN" });
    const parsed = JSON.parse(data);

    const trends =
      parsed.default.trendingSearchesDays[0].trendingSearches;

    return trends.slice(0, 5).map((t) => t.title.query);
  } catch (e) {
    console.log("🔥 Trends failed, using fallback");

    return [
      "India",
      "Cricket",
      "Technology",
      "Bollywood",
      "Stock Market",
    ];
  }
}

/* ---------------- NEWS API ---------------- */
app.get("/news", async (req, res) => {
  try {
    let category = (req.query.category || "general").toLowerCase();

    /* -------- ALL (TRENDING) -------- */
    if (category === "all") {
      const trends = await getTrendingTopics();
      const news = [];

      for (let keyword of trends) {
        try {
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
                title: item.title || "",
                description: item.contentSnippet || "",
                link: item.link || "",
                date: item.pubDate || "",
                imageUrl: image,
                keyword,
              };
            })
          );

          news.push(...items);
        } catch (err) {
          console.log("❌ keyword failed:", keyword);
        }
      }

      return res.json(news);
    }

    /* -------- CATEGORY -------- */
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
          title: item.title || "",
          description: item.contentSnippet || "",
          link: item.link || "",
          date: item.pubDate || "",
          imageUrl: image,
        };
      })
    );

    res.json(news);

  } catch (error) {
    console.error("🔥 API ERROR:", error);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

/* ---------------- ROOT ---------------- */
app.get("/", (req, res) => {
  res.send("🔥 FlashFeed AI Trending API running");
});

/* ---------------- SERVER ---------------- */
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

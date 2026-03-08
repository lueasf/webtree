import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { crawl } from "./crawler.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

const crawlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests, try again in a minute." });
  },
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/crawl", crawlLimiter, async (req, res) => {
  const { url, hops, maxPerDomain } = req.query;

  // Validate url
  let startUrl;
  try {
    startUrl = new URL(url);
    if (startUrl.protocol !== "http:" && startUrl.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  // Validate params
  const maxHops = Math.min(Math.max(parseInt(hops) || 10, 1), 100);
  const domainCap = Math.min(Math.max(parseInt(maxPerDomain) || 3, 1), 50);

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Abort controller — if client disconnects, stop crawling
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  try {
    await crawl(startUrl.href, maxHops, domainCap, send, controller.signal);
  } catch (err) {
    send({ type: "error", message: err.message });
  }

  res.end();
});

app.listen(PORT, () => {
  console.log(`webtree backend running on http://localhost:${PORT}`);
});

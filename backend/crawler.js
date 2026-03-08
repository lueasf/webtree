import axios from "axios";
import * as cheerio from "cheerio";
import tldts from "tldts";
import { isBanned, normalizeUrl } from "./blacklist.js";

const { getDomainWithoutSuffix } = tldts;

// Anchor texts that signal navigation/utility links — not worth following
const BORING_ANCHORS = new Set([
  "home", "back", "next", "previous", "prev", "more", "read more", "see more",
  "click here", "here", "link", "this", "page", "go", "ok", "yes", "no",
  "contact", "about", "faq", "help", "support", "search", "menu", "close",
  "open", "skip", "top", "share", "tweet", "print", "email", "download",
  "subscribe", "follow", "like", "comment", "login", "sign in", "sign up",
  "register", "log in", "log out", "logout", "continue", "submit", "send",
  "buy", "shop", "cart", "checkout", "privacy", "terms", "cookies", "legal",
  "sitemap", "rss", "feed", "newsletter", "advertise", "press", "careers",
  "source", "edit", "view", "show", "hide", "expand", "collapse", "all",
  "english", "français", "deutsch", "español", "italiano", "português",
]);

function isBoringAnchor(text) {
  if (!text || text.length < 3) return true;
  if (text.length > 120) return true; // banner/ad text
  if (/^\d+$/.test(text)) return true; // pure numbers (pagination)
  return BORING_ANCHORS.has(text.toLowerCase());
}

// Higher = more content-like link
function anchorScore(text) {
  if (!text) return 0;
  const words = text.split(/\s+/).length;
  const hasUpperCase = /[A-Z]/.test(text);
  const hasMixedCase = hasUpperCase && /[a-z]/.test(text);
  return words * 2 + (hasMixedCase ? 3 : 0) + Math.min(text.length / 10, 5);
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 6000;

function randomDelay() {
  return new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
}

// Returns { links: string[], title: string|null }
async function fetchPage(url) {
  const res = await axios.get(url, {
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 4,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    validateStatus: (s) => s < 500,
  });

  if (res.status !== 200) return { links: [], title: null };

  const contentType = res.headers["content-type"] || "";
  if (!contentType.includes("text/html")) return { links: [], title: null };

  const $ = cheerio.load(res.data);

  // Clean title: strip " | Site name" suffixes
  const rawTitle = $("title").first().text().trim();
  const title = rawTitle
    ? rawTitle.replace(/\s*[|\-—–]\s*.{1,60}$/, "").trim().slice(0, 80) || rawTitle.slice(0, 80)
    : null;

  const seen = new Set();
  const links = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const normalized = normalizeUrl(href, url);
    if (!normalized || isBanned(normalized) || seen.has(normalized)) return;
    const anchor = $(el).text().trim().replace(/\s+/g, " ");
    if (isBoringAnchor(anchor)) return;
    seen.add(normalized);
    links.push({ url: normalized, anchor });
  });

  // Sort by anchor quality so the crawler prefers content-like links
  links.sort((a, b) => anchorScore(b.anchor) - anchorScore(a.anchor));

  return { links: links.map((l) => l.url), title };
}

function domainKey(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  // Clé = nom de domaine sans TLD, peu importe l'extension.
  // lemonde.fr et lemonde.com → "lemonde" (même compteur)
  // microsoft.com et microsoft.org → "microsoft" (même compteur)
  return getDomainWithoutSuffix(hostname) ?? hostname;
}

/**
 * Crawl starting from `startUrl` for `maxHops` hops.
 * `maxPerDomain` — max times the bot may visit pages from the same domain.
 *   Once a domain hits the cap its links are filtered out (forced to jump away).
 * `emit(event)` is called for each SSE event.
 */
export async function crawl(startUrl, maxHops, maxPerDomain, emit, signal) {
  const visited = new Set();
  const domainCount = new Map(); // hostname → visit count
  let currentUrl = startUrl;
  let depth = 0;
  const stack = [];

  emit({ type: "start", url: startUrl });

  while (depth < maxHops) {
    if (signal?.aborted) break;

    // Mark visited and increment domain counter
    visited.add(currentUrl);
    const curHost = domainKey(currentUrl);
    domainCount.set(curHost, (domainCount.get(curHost) || 0) + 1);

    let links, title;
    try {
      ({ links, title } = await fetchPage(currentUrl));
    } catch {
      links = []; title = null;
    }

    // Emit page title for this node
    if (title) emit({ type: "title", url: currentUrl, title });

    // Filter already-visited and domain-capped links
    const freshLinks = links.filter((l) => {
      if (visited.has(l)) return false;
      const h = domainKey(l);
      return (domainCount.get(h) || 0) < maxPerDomain;
    });

    if (freshLinks.length === 0) {
      // Dead end or domain cap reached — backtrack
      if (stack.length === 0) break;
      const parent = stack.pop();
      emit({ type: "backtrack", from: currentUrl, to: parent.url, depth });
      currentUrl = parent.url;
      continue;
    }

    // Pick randomly from the top half of scored links (already sorted by fetchPage)
    const pool = freshLinks.slice(0, Math.max(1, Math.ceil(freshLinks.length / 2)));
    const next = pool[Math.floor(Math.random() * pool.length)];

    stack.push({ url: currentUrl });
    emit({ type: "visit", from: currentUrl, to: next, depth });
    depth++;
    currentUrl = next;

    await randomDelay();
  }

  emit({ type: "done", depth });
}

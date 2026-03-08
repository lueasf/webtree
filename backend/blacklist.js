export const BANNED_DOMAINS = new Set([
  // Social media
  "twitter.com", "x.com", "facebook.com", "instagram.com", "tiktok.com",
  "linkedin.com", "pinterest.com", "snapchat.com", "tumblr.com", "reddit.com",
  "discord.com", "telegram.org", "whatsapp.com", "threads.net", "mastodon.social",
  "bsky.app",
  // Auth walls / big tech dead ends
  "accounts.google.com", "gmail.com", "outlook.com", "live.com",
  "github.com", "gitlab.com",
  // URL shorteners — useless for exploration
  "bit.ly", "t.co", "tinyurl.com", "ow.ly", "buff.ly", "dlvr.it",
  "ift.tt", "goo.gl", "shorturl.at", "rb.gy", "tiny.cc", "cutt.ly",
  "is.gd", "shorte.st", "adf.ly", "linktr.ee",
  // News paywalls
  "nytimes.com", "wsj.com", "ft.com", "bloomberg.com", "economist.com",
  // Misc infra / noise
  "paypal.com", "stripe.com", "cloudflare.com", "akamai.com",
  "feedburner.com",
]);

// URL path patterns that indicate dead ends
const BANNED_PATH_PATTERNS = [
  /\/(login|signin|sign-in|signup|sign-up|register|auth|logout|checkout|cart|account|password|reset)/i,
  /\/(cdn-cgi|wp-admin|wp-login)/i,
  /\/(privacy|terms|cookies|gdpr|legal|disclaimer|dmca|copyright)/i,
  /\/(contact|about|faq|help|support|feedback|advertise|press|careers|jobs)/i,
  /\/(sitemap|feed|rss|newsletter|subscribe|unsubscribe)/i,
  /\/(tag|tags|category|categories|author|topic|label|archive)\/[^/]+$/i,
  /\/(page|p)\/\d+/i,
  /[?&](page|p|paged|offset)=\d+/i,
];

// File extensions to skip
const BANNED_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|svg|webp|mp4|mp3|zip|exe|dmg|iso|css|js|xml|json|rss|atom)$/i;

export function isBanned(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const hostname = parsed.hostname.replace(/^www\./, "");

  // Match exact domain or any subdomain of it
  if (BANNED_DOMAINS.has(hostname)) return true;
  for (const banned of BANNED_DOMAINS) {
    if (hostname.endsWith("." + banned)) return true;
  }

  for (const pattern of BANNED_PATH_PATTERNS) {
    if (pattern.test(parsed.pathname)) return true;
  }

  if (BANNED_EXTENSIONS.test(parsed.pathname)) return true;

  return false;
}

export function normalizeUrl(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    // Only http/https
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Strip fragment and trailing slash
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

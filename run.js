// run.js

// Crawls real business websites per category, visits multiple internal pages per
// site, and extracts a STRUCTURE-ONLY layout tree for each page: box sizes,
// positions, colors, backgrounds, spacing, layout direction, and repeated-group
// collapsing (e.g. "7 cards" instead of 7 near-identical trees).
//
// Deliberately excluded from output: actual text content, image src URLs.
// Everything else (geometry + real colors) is kept exact.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ============================================================
// CRASH RESILIENCE ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a single dead tab/browser must never take down a
// multi-hour, 100+ category run. Playwright sometimes rejects a promise
// asynchronously when a page/browser dies unexpectedly (crash, forced close
// by a hostile site, OOM), outside the immediate try/catch that's awaiting
// something else ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â which otherwise kills the whole Node process. Log it and
// keep going instead; the per-site try/catch + page-health check below
// handle actually recovering.
// ============================================================
process.on('unhandledRejection', (reason) => {
  console.log(`  [warn] unhandled rejection, continuing: ${reason && reason.message ? reason.message : reason}`);
});
process.on('uncaughtException', (err) => {
  console.log(`  [warn] uncaught exception, continuing: ${err && err.message ? err.message : err}`);
});

// ============================================================
// 00a ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· CONNECTIVITY HANDLING
// ============================================================
// A wifi drop (commute, train tunnel, laptop reconnecting) throws the same
// kind of error Playwright throws for a genuinely broken/unreachable site.
// We don't want those two cases treated the same way: a broken site should
// be recorded and skipped; a dead network should just pause and retry once
// the connection is back, without burning the candidate.

const CONNECTIVITY_ERROR_PATTERNS = [
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_NAME_NOT_RESOLVED',   // DNS server unreachable (not "this domain doesn't exist")
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_ADDRESS_UNREACHABLE',
  'net::ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_SOCKET_NOT_CONNECTED',
  'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', // node-level DNS/socket failures
];

function isLikelyConnectivityError(err) {
  const msg = (err && err.message) ? err.message : String(err);
  return CONNECTIVITY_ERROR_PATTERNS.some(pattern => msg.includes(pattern));
}

async function isCaptchaOrBotCheck(page) {
  try {
    const signals = await page.evaluate(() => {
      const title = (document.title || '').trim().toLowerCase();
      const bodyText = (document.body?.innerText || '').trim().toLowerCase();
      const visibleText = bodyText.slice(0, 1000);
      const pageText = `${title}\n${visibleText}`;
      const scriptSources = Array.from(document.scripts)
        .map(script => script.src || '')
        .join('\n')
        .toLowerCase();

      return {
        title,
        visibleText,
        pageText,
        scriptSources,
      };
    });

    if (/just a moment|checking your browser|attention required|cf-browser-verification/.test(signals.pageText)) {
      return true;
    }
    if (/verify you are human|i['’]?m not a robot|unusual traffic/.test(signals.pageText)) {
      return true;
    }
    if (/\bcaptcha\b|\brecaptcha\b|\bhcaptcha\b/.test(signals.title)) {
      return true;
    }
    if (/\bcaptcha\b|\brecaptcha\b|\bhcaptcha\b/.test(signals.scriptSources)) {
      return true;
    }
    if (/\baccess denied\b/.test(signals.pageText) && signals.visibleText.length < 500) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Polls a known-reliable endpoint until it responds, instead of guessing a
// fixed sleep time ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a commute wifi gap could be 2 minutes or 20.
async function isOnline(page) {
  try {
    await page.evaluate(async () => {
      const res = await fetch('https://www.google.com/generate_204', { cache: 'no-store' });
      return res.ok || res.status === 204;
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForConnectivity(page, { pollMs = 15000, maxWaitMs = 30 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isOnline(page)) {
      console.log('  [network] back online, resuming.');
      return true;
    }
    console.log(`  [network] still offline, checking again in ${pollMs / 1000}s...`);
    await page.waitForTimeout(pollMs).catch(() => {});
  }
  console.log(`  [network] still offline after ${maxWaitMs / 60000} min - giving up waiting and moving to the next link.`);
  return false;
}

// ============================================================
// 00 ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· CONFIG
// ============================================================

const MAX_PER_PLATFORM = 3;          // cap on how many sites from the same template platform (Shopify, Wix, etc.) count toward a category
const MAX_PAGES_PER_SITE = 10;       // internal pages to crawl per site (incl. homepage)
const MAX_DEPTH_PER_NODE = 6;        // how deep the DOM walk recurses
const NAV_TIMEOUT = 15000;
// Viewports to capture per page, so responsiveness is data, not a guess.
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet:  { width: 834,  height: 1112 },
  mobile:  { width: 390,  height: 844 },
};

const OUTPUT_DIR = 'output';
const OUTPUT_INDEX_FILE = path.join(OUTPUT_DIR, 'index.json');
const URL_REGISTRY_FILE = path.join(OUTPUT_DIR, 'url-registry.json');

function safeOutputPart(value, fallback = 'unnamed') {
  const safe = String(value)
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[. ]+$/g, '');
  return safe || fallback;
}

function siteOutputPath(category, siteOrigin, suffix = '') {
  const hostname = new URL(siteOrigin).hostname;
  const suffixPart = suffix ? `-${safeOutputPart(suffix)}` : '';
  return path.join(OUTPUT_DIR, safeOutputPart(category), `${safeOutputPart(hostname)}${suffixPart}.json`);
}

function normalizeSiteUrl(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${hostname}${pathname}${parsed.search}`;
}

function relativeOutputPath(filePath) {
  return path.relative(OUTPUT_DIR, filePath).split(path.sep).join('/');
}

// URL patterns to skip when following internal links (junk, not real pages)
const SKIP_PATH_PATTERNS = [
  /\/(login|signin|sign-in|signup|sign-up|register|cart|checkout|account|logout)(\/|$)/i,
  /\/(search|tag|tags|category|categories)\?/i,
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|mp4|mp3|doc|docx|xls|xlsx)$/i,
  /^mailto:|^tel:|^javascript:/i,
  /#/, // anchor-only links, avoid re-scraping the same page
];

// ============================================================
// 01 ? INPUT LINKS
// ============================================================
const LINKS_FILE = '119_categories_unique_links_completed.txt';
const MAX_RUNTIME_MS = 5.5 * 60 * 60 * 1000;

function loadCategoryLinks() {
  const raw = fs.readFileSync(LINKS_FILE, 'utf-8');
  const categories = new Map();
  let currentCategory = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const header = trimmed.match(/^\d+\.\s*(.+)$/);
    if (header) {
      currentCategory = header[1]
        .replace(/\s+[\u2012\u2013\u2014-]\s+\d+\s+unique links\s*$/i, '')
        .trim();
      categories.set(currentCategory, []);
      continue;
    }
    if (currentCategory && /^https?:\/\//i.test(trimmed)) {
      categories.get(currentCategory).push(trimmed);
    }
  }
  return categories;
}

// 02 ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· JUNK FILTERING
// ============================================================

const GLOBAL_JUNK_DOMAINS = [
  'wikipedia.org', 'britannica.com', 'forbes.com', 'investopedia.com',
  'unirank.org', 'universityguru.com', 'expertmarket.com', 'g2.com',
  'capterra.com', 'trustpilot.com', 'reddit.com', 'quora.com',
  'youtube.com', 'medium.com', 'bing.com', 'duckduckgo.com',
  'microsoft.com', 'go.microsoft.com', 'facebook.com', 'instagram.com',
  'twitter.com', 'x.com', 'linkedin.com', 'pinterest.com', 'yelp.com',
  // website builders / template marketplaces ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â these serve DEMO template
  // pages (e.g. weblium.com/templates/architecture-firm-website-design-120)
  // or per-user free-tier sites that look like a real business to a search
  // query, but aren't one. Bare domains AND their free-subdomain patterns
  // both included (e.g. 'wix.com' + 'wixsite.com' ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the subdomain string is
  // NOT a substring of the bare domain, so it needs its own entry).
  'weblium.com', 'wix.com', 'wixsite.com',
  'squarespace.com', // covers *.squarespace.com subdomains too (substring match)
  'weebly.com', 'weeblysite.com',
  'webflow.com', 'webflow.io',
  'canva.com',
  'strikingly.com',
  'godaddy.com', 'godaddysites.com',
  'site123.com', 'jimdo.com', 'ucraft.com',
  'duda.co', 'webnode.com', 'tilda.cc',
  'zyro.com', 'hostinger.com',
  'format.com', 'pagecloud.com',
  'carrd.co',
  'themeforest.net', 'templatemonster.com', 'elementor.com', 'divi.com',
  'wordpress.com', // .org (self-hosted software) intentionally NOT blocked
  'shopify.com', 'bigcommerce.com', 'squareup.com',
  // generic dev-hosting subdomains ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â often personal/demo/portfolio projects
  // rather than a real business's actual site
  'github.io', 'netlify.app', 'vercel.app', 'glitch.me', 'replit.app', 'repl.co',
  // design-inspiration / gallery / showcase sites ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â feature OTHER people's
  // real sites via screenshots/embeds; the URL itself isn't the business
  'dribbble.com', 'behance.net', 'awwwards.com', 'land-book.com',
  'siteinspire.com', 'lapa.ninja', 'csswinner.com', 'onepagelove.com',
  '99designs.com', 'designspiration.com',
  'httpster.net', 'thefwa.com', 'cssdesignawards.com', 'minimal.gallery',
  'godly.website', 'bestwebsite.gallery', 'webdesign-inspiration.com',
  'niiice.works', 'mobbin.com',
  'tripadvisor.com', 'glassdoor.com', 'indeed.com', 'crunchbase.com',
  // media/reference sites that pass every other check (real, functioning,
  // have contact info) but are never themselves the business a category
  // is looking for ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â they write ABOUT firms, or answer unrelated queries.
  'archdaily.com', 'dezeen.com', 'designboom.com', 'archello.com',
  'architizer.com', 'biblehub.com', 'gotquestions.org', 'biblewisdomhub.org',
  'bibleparadise.org', 'crosstalk.ai',
];

function isJunkUrl(url) {
  if (GLOBAL_JUNK_DOMAINS.some(domain => url.includes(domain))) return true;
  return isTemplateOrDemoPath(url);
}

// ============================================================
// 02a-i ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· PATH-PATTERN JUNK DETECTION (domain-agnostic)
// ============================================================
// The recurring failure mode: a search for e.g. "construction company
// official website" doesn't return a builder's OWN domain (which the
// domain list would catch) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â it returns someone's marketing/template/demo
// page ABOUT construction-company websites, hosted anywhere, on a domain
// that will never appear in any blocklist because it's not "a builder",
// it's a one-off gallery/portfolio/agency page showcasing template mockups.
// A domain list can never keep up with this; the URL PATH almost always
// gives it away regardless of what domain it's hosted on.
const JUNK_PATH_PATTERNS = [
  /\/templates?\//i,
  /\/themes?\//i,
  /\/demo(s)?\//i,
  /\/showcase\//i,
  /\/inspiration\//i,
  /\/portfolio-template/i,
  /website-templates?/i,
  /website-design-\d+/i,      // e.g. weblium.com/templates/architecture-firm-website-design-120
  /\bmockup(s)?\b/i,
  /\bwebsite-builder\b/i,
  /\bsite-builder\b/i,
  /\/blog\//i,                 // blog posts (e.g. "10 best construction websites") not the business itself
  /\/case-studies?\//i,
  /\/examples?\//i,
  // listicle/directory/aggregator pages ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â "Top 10 X Companies", "Best X
  // Firms 2026" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â these are ABOUT businesses, not one, and were slipping
  // past the template filter entirely since their path has nothing
  // builder-related in it.
  /\/(top|best)-\d+/i,
  /\d+-(best|top)-/i,
  /\/directory\//i,
  /\/(companies|firms|agencies|providers)-in-/i,
  /\/reviews?\//i,
  /\bvs\b.*\bcompar/i,
];

function isTemplateOrDemoPath(url) {
  try {
    const u = new URL(url);
    const pathAndQuery = (u.pathname + u.search).toLowerCase();
    return JUNK_PATH_PATTERNS.some(re => re.test(pathAndQuery));
  } catch {
    return JUNK_PATH_PATTERNS.some(re => re.test(url.toLowerCase()));
  }
}


// ============================================================
// 02a ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ADULT-CONTENT FILTER (hard block, separate from general junk)
// ============================================================
// A generic query can occasionally surface adult sites in results (this
// happened live ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â pornhub.com, xvideos.com, xhamster.com, freeones.com,
// tubepleasure.com all came back for an unrelated category query). This is
// blocked at two levels: an explicit domain list for the sites known to
// show up, PLUS a keyword heuristic on the hostname/path so new/unlisted
// adult domains don't slip through just because they're not named yet.
const ADULT_DOMAINS = [
  'pornhub.com', 'xvideos.com', 'xhamster.com', 'xnxx.com', 'redtube.com',
  'youporn.com', 'freeones.com', 'tubepleasure.com', 'spankbang.com',
  'brazzers.com', 'onlyfans.com', 'chaturbate.com', 'stripchat.com',
  'txxx.com', 'tube8.com', 'beeg.com', 'porn.com', 'pornone.com',
  'eporner.com', 'motherless.com', 'thumbzilla.com', 'porntrex.com',
  'hclips.com', 'upornia.com', 'xhand.com', 'fapster.xxx',
];

const ADULT_KEYWORDS = [
  'porn', 'xxx', 'xvideos', 'xhamster', 'hentai', 'camgirl', 'webcam-sex',
  'nsfw', 'escort', 'adultfriendfinder', 'livejasmin', 'nude', 'fetish',
];

function isAdultUrl(url) {
  const lower = url.toLowerCase();
  if (ADULT_DOMAINS.some(domain => lower.includes(domain))) return true;
  // keyword check on the domain/path only, not blocking a legit business
  // whose page just happens to mention an unrelated word somewhere
  try {
    const u = new URL(url);
    const hostAndPath = (u.hostname + u.pathname).toLowerCase();
    return ADULT_KEYWORDS.some(kw => hostAndPath.includes(kw));
  } catch {
    return ADULT_KEYWORDS.some(kw => lower.includes(kw));
  }
}


// ============================================================
// 02b ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· TEMPLATE-PLATFORM DETECTION (so a category doesn't fill up
// with 15 near-identical Shopify/Wix/Squarespace storefronts)
// ============================================================
// This is NOT a blocklist ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â those sites are still real businesses and get
// crawled. It's a per-category cap: once MAX_PER_PLATFORM sites on the same
// platform have been captured, further candidates on that platform are
// skipped so the search keeps digging for independently-built sites instead
// of stopping at the first page of generic SaaS storefronts.
const PLATFORM_HOST_PATTERNS = [
  { name: 'shopify', re: /\.myshopify\.com/i },
  { name: 'wix', re: /\.wixsite\.com|wix\.com\/website/i },
  { name: 'squarespace', re: /\.squarespace\.com/i },
  { name: 'weebly', re: /\.weebly\.com/i },
  { name: 'webflow', re: /\.webflow\.io/i },
  { name: 'godaddy-sites', re: /\.godaddysites\.com/i },
  { name: 'carrd', re: /\.carrd\.co/i },
];

// A site can also be self-hosted on its own domain but still be a Shopify
// storefront under the hood; that's fine to keep as-is ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the platform cap
// only needs to catch the obvious "hosted on the platform's own subdomain"
// case, which is what dominates generic search results.
function detectPlatform(url) {
  const match = PLATFORM_HOST_PATTERNS.find(p => p.re.test(url));
  return match ? match.name : null;
}

// ============================================================
// 02c ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· LIVE PAGE FINGERPRINTING (evidence-based, not a name list)
// ============================================================
// Instead of only trusting GLOBAL_JUNK_DOMAINS / PLATFORM_HOST_PATTERNS
// (which need a human to notice and add every new builder/gallery site by
// name), check what the PAGE ITSELF admits once it's loaded: builder
// platforms (Wix, Squarespace, Webflow, WordPress.com, Shopify, Site123,
// Duda, Jimdo, etc.) almost always leave a fingerprint in
// <meta name="generator"> or in their injected script/link tags, even
// when self-hosted on a custom domain that would never appear in a
// domain blocklist. This catches NEW builder sites you've never seen,
// with zero maintenance.
const BUILDER_FINGERPRINTS = [
  { name: 'wix', re: /wix\.com|_wixCssPriorityOverrideHash|wixstatic\.com/i },
  { name: 'squarespace', re: /squarespace/i },
  { name: 'webflow', re: /webflow/i },
  { name: 'wordpress-com', re: /wordpress\.com|wp-content.*wpcomstaticassets/i },
  { name: 'wordpress-generic', re: /wordpress/i }, // still real businesses; only used for the platform CAP, never a hard block
  { name: 'shopify', re: /shopify|cdn\.shopify\.com/i },
  { name: 'site123', re: /site123/i },
  { name: 'duda', re: /duda(one)?|irp\.cdn-website\.com/i },
  { name: 'jimdo', re: /jimdo/i },
  { name: 'weebly', re: /weebly/i },
  { name: 'godaddy', re: /godaddy|websitebuilder/i },
  { name: 'carrd', re: /carrd\.co/i },
  { name: 'strikingly', re: /strikingly/i },
  { name: 'tilda', re: /tilda/i },
  { name: 'ucraft', re: /ucraft/i },
];

// Cheap, ~instant check run right after the homepage loads ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â reads the
// generator meta tag and a handful of script/link src attributes already
// on the page, no extra navigation needed.
async function detectBuilderFingerprintOnPage(page) {
  try {
    const signals = await page.evaluate(() => {
      const generator = document.querySelector('meta[name="generator"]')?.content || '';
      const scriptSrcs = Array.from(document.scripts).map(s => s.src).filter(Boolean).join(' ');
      const linkHrefs = Array.from(document.querySelectorAll('link[href]')).map(l => l.href).join(' ');
      return `${generator} ${scriptSrcs} ${linkHrefs}`;
    });
    for (const fp of BUILDER_FINGERPRINTS) {
      if (fp.re.test(signals)) return fp.name;
    }
  } catch { /* if this fails for any reason, just fall through ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â not fatal */ }
  return null;
}

// Adult content isn't always obvious from the URL ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â check the loaded
// page's own title/meta description too, cheap and catches sites whose
// domain gives no hint at all.
async function pageLooksAdultOnLoad(page) {
  try {
    const text = await page.evaluate(() => {
      const title = document.title || '';
      const desc = document.querySelector('meta[name="description"]')?.content || '';
      return `${title} ${desc}`.toLowerCase();
    });
    return ADULT_KEYWORDS.some(kw => text.includes(kw));
  } catch {
    return false;
  }
}

// ============================================================
// 02d ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· POSITIVE BUSINESS-SITE VERIFICATION
// ============================================================
// Everything above is negative filtering (block what looks bad). This is
// the opposite: verify the loaded page actually looks like a real,
// operating business before spending the full 3-viewport crawl on it.
// Real business sites almost always have SOME of: a phone/mailto link,
// a physical address, a copyright/company-name footer line, more than a
// token amount of body text. Template-marketplace pages, listicles, and
// builder demo pages selling/showing a template usually have NONE of
// these, but DO have giveaway CTA language ("start your free trial",
// "use this template", "buy this theme").
const BUILDER_CTA_PHRASES = [
  'start your free trial', 'use this template', 'buy this template',
  'get this template', 'edit this template', 'customize this template',
  'start free trial', 'try it free', 'sign up free', 'create your website',
  'build your website', 'make your own website', 'get started for free',
  'choose this design', 'preview this template',
];

async function assessBusinessSignals(page) {
  try {
    return await page.evaluate((ctaPhrases) => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hasPhoneOrEmailLink = !!document.querySelector('a[href^="tel:"], a[href^="mailto:"]');
      const hasAddressTag = !!document.querySelector('address');
      const hasCopyrightLine = /ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©|copyright|\ball rights reserved\b/i.test(bodyText);
      const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
      const hasBuilderCta = ctaPhrases.some(p => bodyText.includes(p));
      return { hasPhoneOrEmailLink, hasAddressTag, hasCopyrightLine, wordCount, hasBuilderCta };
    }, BUILDER_CTA_PHRASES);
  } catch {
    return null; // if the check itself fails, don't block on it ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â let the site through to normal crawl/failure handling
  }
}

// Returns true only when we're fairly confident this is a builder/demo
// page rather than a real site of ANY kind ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â museums, courts, embassies,
// festivals, NGOs, galleries etc. legitimately won't have a phone number,
// address tag, or copyright line on their homepage, so that combination
// was too likely to wrongly skip real non-"business" institutions across
// this category list. Only the explicit builder-CTA language is a safe,
// category-agnostic signal ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â kept; the low-word-count/no-contact
// combination is dropped.
function looksLikeBuilderDemoPage(signals) {
  if (!signals) return false;
  return signals.hasBuilderCta;
}

// ============================================================
// 02e ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· LISTICLE / DIRECTORY / AGGREGATOR DETECTION
// ============================================================
// Everything above catches "is this a template/builder demo". This catches
// a different kind of junk: pages that are genuinely real, live, well-built
// sites ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â just not a single business's own homepage. E.g. "12 Best Hospital
// Websites", "Architecture Portfolio | Browse Categories", a web-design
// agency's blog post, a directory that lists 40 other companies. These
// slip past every check above because they're not adult, not a
// template-seller, not flagged by any domain list ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â they're just the wrong
// KIND of page. Combines three cheap, category-agnostic signals instead of
// trying to keep a blocklist of every gallery/directory/listicle site,
// which is unmaintainable at 119 categories.
const LISTICLE_TITLE_PATTERNS = [
  /\b\d+\s+(best|top|great|amazing|inspiring)\b/i,   // "12 Best...", "47 Best..."
  /\bbest\s+.{0,40}\b(websites?|sites?|examples?)\b/i, // "Best Hospital Websites"
  /\b(top|best)\s+\d+\b/i,                             // "Top 10..."
  /\bexamples?\s+of\b/i,                               // "Examples of..."
  /\bdirectory\b/i,                                    // "...Directory"
  /\bshowcase\b/i,                                     // "...Showcase"
  /\bround[\s-]?up\b/i,                                // "...Roundup"
  /\b(browse|explore)\s+(categories|portfolios?)\b/i,  // "Browse Categories"
];

// Outbound-link-density check: a real business homepage links mostly to
// itself (nav, footer, social icons). A directory/listicle links out to
// many OTHER companies' domains. Threshold is deliberately generous ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
// real sites can have a handful of partner/social links ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this is only
// meant to catch pages that are clearly built to fan out to many domains.
async function assessOutboundLinkDensity(page, pageOrigin) {
  try {
    return await page.evaluate((origin) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const externalOrigins = new Set();
      for (const a of anchors) {
        try {
          const u = new URL(a.href, document.baseURI);
          if (u.origin !== origin && /^https?:$/.test(u.protocol)) {
            externalOrigins.add(u.origin);
          }
        } catch { /* skip malformed hrefs */ }
      }
      return { externalOriginCount: externalOrigins.size, totalLinks: anchors.length };
    }, pageOrigin);
  } catch {
    return null; // if this fails, don't block on it
  }
}

// Domain-level heuristic: the domain itself is a web-design/marketing
// agency's own blog, not a business in the category being searched. These
// sites repeatedly produce "N Best ___ Websites" posts across many
// categories ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â catching the domain PATTERN (not an exhaustive name list)
// means new agency blogs are caught the same way without maintenance.
const AGENCY_BLOG_HOST_PATTERNS = [
  /\bdigital(design|marketing|agency)\b/i,
  /\bwebdesign\b/i,
  /\bsites?\.(com|net|io)$/i, // e.g. freshysites.com, htmlburger-style naming
];

function hostLooksLikeAgencyBlog(hostname) {
  return AGENCY_BLOG_HOST_PATTERNS.some(re => re.test(hostname));
}

// Combines all three signals into one verdict. Any ONE strong signal
// (title pattern) is enough on its own since it's very low false-positive;
// the link-density signal only counts alongside a moderately generic title,
// since some legitimate sites (news, universities) also link out a lot.
async function looksLikeListicleOrDirectory(page, pageUrl) {
  let hostname = '';
  try { hostname = new URL(pageUrl).hostname; } catch { /* ignore */ }

  let title = '';
  try {
    title = await page.evaluate(() => document.title || '');
  } catch { /* ignore */ }

  const titleMatches = LISTICLE_TITLE_PATTERNS.some(re => re.test(title));
  if (titleMatches) {
    return { flagged: true, reason: `title matches listicle/directory pattern: "${title}"` };
  }

  if (hostLooksLikeAgencyBlog(hostname)) {
    const density = await assessOutboundLinkDensity(page, `https://${hostname}`);
    if (density && density.externalOriginCount >= 15) {
      return { flagged: true, reason: `agency-style domain "${hostname}" with ${density.externalOriginCount} distinct external link targets` };
    }
  }

  return { flagged: false, reason: null };
}

// ============================================================
// 02f ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· CHEAP PAGE FILTERS
const TEMPLATE_MARKETPLACE_HOSTS = [
  'themeforest.net', 'envato.com', 'templatemonster.com', 'webflow.io',
  'wix.com/website-template', 'squarespace.com/templates', 'carrd.co',
  'framer.website', 'webflow.com/templates',
];
const TEMPLATE_MARKETPLACE_PHRASES = [
  'buy this template', 'live preview', 'demo content', 'use this template',
  'customize this theme', 'buy this theme', 'get this template',
];

async function looksLikeTemplateMarketplace(page, pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    const hostAndPath = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    if (TEMPLATE_MARKETPLACE_HOSTS.some(domain => hostAndPath.includes(domain))) return true;
    const text = await page.evaluate(() => (document.body?.innerText || '').toLowerCase());
    return TEMPLATE_MARKETPLACE_PHRASES.some(phrase => text.includes(phrase));
  } catch {
    return false;
  }
}

async function looksLikeParkedOrUnderConstruction(page) {
  try {
    return await page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const html = (document.documentElement?.outerHTML || '').toLowerCase();
      if (bodyText.length < 100) return true;
      return [
        'domain for sale', 'this site is under construction', 'coming soon',
        'buy this domain', 'godaddy', 'namecheap', 'sedo', 'parked free',
        'domain parking',
      ].some(phrase => bodyText.includes(phrase) || html.includes(phrase));
    });
  } catch {
    return false;
  }
}

// 04 ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· INTERNAL LINK DISCOVERY (for multi-page crawl per site)
// ============================================================

async function findInternalLinks(page, baseUrl, limit) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return []; }

  const hrefs = await page.$$eval('a[href]', els => els.map(el => el.href));
  const seen = new Set();
  const links = [];

  for (const href of hrefs) {
    try {
      const u = new URL(href);
      if (u.origin !== origin) continue;
      if (SKIP_PATH_PATTERNS.some(re => re.test(u.href))) continue;
      const clean = u.origin + u.pathname; // drop query/hash for dedupe
      if (seen.has(clean)) continue;
      seen.add(clean);
      links.push(clean);
      if (links.length >= limit) break;
    } catch { /* skip malformed */ }
  }
  return links;
}

// ============================================================
// 05 ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· STRUCTURE EXTRACTION (colors + sizes, no text, no image src)
// ============================================================

async function extractStructure(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  if (await isCaptchaOrBotCheck(page)) {
    console.log(`  Skipping ${url} — CAPTCHA/bot-check detected, not attempting to bypass`);
    return null;
  }
  await page.waitForTimeout(500); // let late-loading styles settle

  const rawTree = await page.evaluate((maxDepth) => {
    let __psxCounter = 0;
    function walk(el, depth, parentRect) {
      if (depth > maxDepth || !el) return null;
      const tag = el.tagName?.toLowerCase();
      if (!tag || ['script', 'style', 'noscript', 'template'].includes(tag)) return null;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;

      const cs = window.getComputedStyle(el);
      const children = Array.from(el.children)
        .map(c => walk(c, depth + 1, rect))
        .filter(Boolean);

      const textLines = [];
      const textWalker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = textWalker.nextNode())) {
        if (textNode.parentElement !== el) continue;
        if (!textNode.nodeValue || !textNode.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(textNode);
        for (const lineRect of Array.from(range.getClientRects())) {
          if (!lineRect.width || !lineRect.height) continue;
          textLines.push({
            x: Math.round(lineRect.x - rect.x),
            y: Math.round(lineRect.y - rect.y),
            width: Math.round(lineRect.width),
            height: Math.round(lineRect.height),
          });
        }
      }
      const uniqueLines = [];
      const lineKeys = new Set();
      for (const line of textLines) {
        const key = `${line.x},${line.y},${line.width},${line.height}`;
        if (!lineKeys.has(key)) {
          lineKeys.add(key);
          uniqueLines.push(line);
        }
      }

      // PATH-ONLY linkage (no query string, no link text, no external domains,
      // no email/phone values), retaining only structural internal navigation.
      let linkType, linkPath;
      if (tag === 'a') {
        const href = el.getAttribute('href') || '';
        if (!href || href === '#') {
          linkType = 'none';
        } else if (href.startsWith('#')) {
          linkType = 'anchor';
          linkPath = href; // e.g. "#page-02" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â structural, not content
        } else if (href.startsWith('mailto:')) {
          linkType = 'email';
        } else if (href.startsWith('tel:')) {
          linkType = 'tel';
        } else {
          try {
            const u = new URL(href, location.href);
            if (u.origin === location.origin) {
              linkType = 'internal';
              linkPath = u.pathname || '/'; // path only ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â no query, no hash, no text
            } else {
              linkType = 'external'; // domain intentionally not kept
            }
          } catch { linkType = 'external'; }
        }
      }

      // background-image / gradient presence, no URLs kept
      let bgImage;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        if (cs.backgroundImage.includes('url(')) bgImage = 'image';
        else if (cs.backgroundImage.includes('gradient')) bgImage = 'gradient';
        else bgImage = 'other';
      }

      // transforms (rotation/scale of decorative elements), no content implied
      const transform = cs.transform && cs.transform !== 'none' ? cs.transform : undefined;

      // list item count, useful for nav-dots / index / social-icon groups
      const listItemCount = (tag === 'ul' || tag === 'ol')
        ? el.children.length
        : undefined;

      // form field type (structure only, never the value/placeholder text)
      const inputType = tag === 'input' ? (el.getAttribute('type') || 'text')
        : tag === 'textarea' ? 'textarea' : undefined;

      // text sizing signal WITHOUT storing the text itself: counts only
      let textStats;
      const isLeaf = el.children.length === 0;
      if (isLeaf && tag !== 'img') {
        const t = (el.textContent || '').trim();
        if (t.length) {
          textStats = {
            chars: t.length,
            words: t.split(/\s+/).filter(Boolean).length,
          };
        }
      }

      // Assign a structural node type without storing text/src content.
      let type = 'container';
      if (tag === 'img' || tag === 'picture') type = 'image-placeholder';
      if (tag === 'video') type = 'video-placeholder';
      if (tag === 'iframe' && /youtube|youtu\.be|vimeo/i.test(el.getAttribute('src') || '')) {
        type = 'video-placeholder';
      }

      // image "definition" = shape only (never src): lets a placeholder be sized
      // right (demo.html's card__media--wide / --tall / --short pattern) with
      // zero actual image data.
      let aspect;
      if (type === 'image-placeholder' || type === 'video-placeholder') {
        const r = rect.width / (rect.height || 1);
        if (rect.width <= 40 && rect.height <= 40) aspect = 'icon';
        else if (r >= 2.2) aspect = 'banner';
        else if (r >= 1.15) aspect = 'wide';
        else if (r <= 0.75) aspect = 'tall';
        else aspect = 'square';
      }
      else if (tag === 'button' || (tag === 'a' && uniqueLines.length > 0)) type = 'button';
      else if (['input', 'textarea', 'select'].includes(tag)) type = 'input';
      else if (tag === 'hr' || (cs.borderTopStyle === 'solid' && rect.height <= 2)) type = 'divider';
      if (bgImage === 'image' && type !== 'video-placeholder') type = 'image-placeholder';
      else if (tag === 'nav' || tag === 'footer' || tag === 'header' ||
        tag === 'ul' || tag === 'ol' || tag === 'form') type = 'container';
      if (type !== 'image-placeholder' && uniqueLines.length > 0 && (
        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'].includes(tag) ||
        (children.length === 0 && !['button', 'a'].includes(tag))
      )) type = 'text-line';
      const textRole = uniqueLines.length > 0
        ? (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)
          ? 'heading'
          : (tag === 'a' ? 'link-label' : (tag === 'button' ? 'button-label' : 'body')))
        : undefined;

      // tag every node with a stable id so a later pass (scroll sampling)
      // can re-select the exact same element and attach motion data back
      // onto this exact node, after the tree has already been built.
      const psxId = String(__psxCounter++);
      el.setAttribute('data-psx-id', psxId);

      return {
        tag,
        type,
        psxId,
        bbox: {
          x: Math.round(rect.x - (parentRect ? parentRect.x : 0)),
          y: Math.round(rect.y - (parentRect ? parentRect.y : 0)),
          w: Math.round(rect.width), h: Math.round(rect.height),
        },
        absoluteBox: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          w: Math.round(rect.width), h: Math.round(rect.height),
        },
        color: cs.color,
        background: bgImage ? undefined : cs.backgroundColor,
        borderRadius: cs.borderRadius,
        borderWidth: cs.borderWidth,
        borderStyle: cs.borderStyle,
        borderColor: cs.borderColor,
        boxShadow: cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : undefined,
        opacity: cs.opacity !== '1' ? cs.opacity : undefined,
        position: cs.position !== 'static' ? cs.position : undefined,
        zIndex: cs.zIndex !== 'auto' ? cs.zIndex : undefined,

        // typography
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontFamily: cs.fontFamily,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing !== 'normal' ? cs.letterSpacing : undefined,
        textAlign: cs.textAlign !== 'start' ? cs.textAlign : undefined,
        textTransform: cs.textTransform !== 'none' ? cs.textTransform : undefined,

        // spacing (4-side, not just gap)
        padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].some(v => v !== '0px')
          ? { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft }
          : undefined,
        margin: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].some(v => v !== '0px')
          ? { top: cs.marginTop, right: cs.marginRight, bottom: cs.marginBottom, left: cs.marginLeft }
          : undefined,

        // flex / grid intent (real, not inferred from position)
        display: cs.display,
        flexDirection: cs.display.includes('flex') ? cs.flexDirection : undefined,
        flexWrap: cs.display.includes('flex') && cs.flexWrap !== 'nowrap' ? cs.flexWrap : undefined,
        justifyContent: cs.display.includes('flex') || cs.display.includes('grid') ? cs.justifyContent : undefined,
        alignItems: cs.display.includes('flex') || cs.display.includes('grid') ? cs.alignItems : undefined,
        flexGrow: cs.display.includes('flex') && cs.flexGrow !== '0' ? cs.flexGrow : undefined,
        flexShrink: cs.display.includes('flex') && cs.flexShrink !== '1' ? cs.flexShrink : undefined,
        flexBasis: cs.display.includes('flex') && cs.flexBasis !== 'auto' ? cs.flexBasis : undefined,
        gridTemplateColumns: cs.display.includes('grid') ? cs.gridTemplateColumns : undefined,
        gridTemplateRows: cs.display.includes('grid') ? cs.gridTemplateRows : undefined,
        gap: cs.gap && cs.gap !== 'normal' ? cs.gap : undefined,

        // media
        objectFit: tag === 'img' || tag === 'video' ? cs.objectFit : undefined,
        objectPosition: tag === 'img' || tag === 'video' ? cs.objectPosition : undefined,
        bgImage,
        backgroundDecorative: !!(cs.backgroundImage && cs.backgroundImage !== 'none'),
        backgroundGradient: cs.backgroundImage && cs.backgroundImage.includes('gradient')
          ? cs.backgroundImage.replace(/url\([^)]*\)/gi, '').trim() : undefined,
        stickyOffset: cs.position === 'sticky' ? cs.top : undefined,
        transitionDuration: cs.transitionDuration !== '0s' ? cs.transitionDuration : undefined,
        transitionTimingFunction: cs.transitionTimingFunction,
        animationTimingFunction: cs.animationName !== 'none' ? cs.animationTimingFunction : undefined,
        aspect,
        transform,

        // link / list / form structure (path-only linkage, no text, no values)
        linkType,
        linkPath,
        listItemCount,
        inputType,
        video: type === 'video-placeholder' ? {
          role: tag === 'iframe' ? 'embedded-player' :
            (el.autoplay && el.loop && el.muted && !el.controls ? 'background-video' : 'player'),
          autoplay: tag === 'video' ? !!el.autoplay : undefined,
          loop: tag === 'video' ? !!el.loop : undefined,
          muted: tag === 'video' ? !!el.muted : undefined,
          controls: tag === 'video' ? !!el.controls : undefined,
          posterPresent: tag === 'video' ? el.hasAttribute('poster') && !!el.getAttribute('poster') : undefined,
        } : undefined,

        children: children.length ? children : undefined,
        textLines: uniqueLines.length ? uniqueLines : undefined,
        textRole,
        _hasText: uniqueLines.length > 0,
        _textStats: textStats,
      };
    }
    return walk(document.body, 0, null);
  }, MAX_DEPTH_PER_NODE);

  const motionMap = await sampleScrollMotion(page);
  attachMotion(rawTree, motionMap);

  return rawTree;
}

// ============================================================
// 05b ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· PARALLAX / SCROLL-MOTION SAMPLING
// ============================================================
// A single computed-style read (what extractStructure does above) only ever
// sees the page at rest. Parallax, scroll-linked transforms, sticky reveals,
// and CSS animations are invisible to that ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â so this does a second pass:
// scroll the page through checkpoints and re-read transform/opacity on any
// element that looks like a motion candidate, plus grab the static
// animation/transition/scroll-attachment CSS signals that don't need
// scrolling to detect at all.
async function sampleScrollMotion(page) {
  const candidateIds = await page.evaluate(() => {
    const ids = [];
    document.querySelectorAll('[data-psx-id]').forEach(el => {
      const cs = getComputedStyle(el);
      const looksLikeMotion =
        (cs.transform && cs.transform !== 'none') ||
        cs.position === 'sticky' || cs.position === 'fixed' ||
        cs.backgroundAttachment === 'fixed' ||
        (cs.animationName && cs.animationName !== 'none') ||
        (cs.transitionProperty && cs.transitionProperty !== 'none');
      if (looksLikeMotion) ids.push(el.getAttribute('data-psx-id'));
    });
    return ids;
  });
  if (candidateIds.length === 0) return {};

  // static signals: true regardless of scroll position
  const staticSignals = await page.evaluate((ids) => {
    const out = {};
    ids.forEach(id => {
      const el = document.querySelector(`[data-psx-id="${id}"]`);
      if (!el) return;
      const cs = getComputedStyle(el);
      out[id] = {
        position: cs.position !== 'static' ? cs.position : undefined,
        stickyOrFixed: cs.position === 'sticky' || cs.position === 'fixed' ? true : undefined,
        bgAttachmentFixed: cs.backgroundAttachment === 'fixed' ? true : undefined,
        animationName: cs.animationName !== 'none' ? cs.animationName : undefined,
        animationDuration: cs.animationName !== 'none' ? cs.animationDuration : undefined,
        transitionProperty: cs.transitionProperty !== 'none' ? cs.transitionProperty : undefined,
        transitionDuration: cs.transitionDuration,
        transitionTimingFunction: cs.transitionTimingFunction,
        animationTimingFunction: cs.animationName !== 'none' ? cs.animationTimingFunction : undefined,
      };
    });
    return out;
  }, candidateIds);

  const scrollHeight = await page.evaluate(() =>
    Math.max(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight)
  );

  const samplesById = {};
  candidateIds.forEach(id => { samplesById[id] = []; });

  if (scrollHeight > 0) {
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const stepCount = Math.min(8, Math.max(2, Math.ceil(scrollHeight / Math.max(viewportHeight, 1)) + 1));
    const fractions = Array.from({ length: stepCount }, (_, index) =>
      stepCount === 1 ? 0 : index / (stepCount - 1)
    );
    for (const frac of fractions) {
      const y = Math.round(scrollHeight * frac);
      await page.evaluate(sy => window.scrollTo(0, sy), y);
      await page.waitForTimeout(150); // let scroll-driven styles/JS libs settle

      const frame = await page.evaluate((ids) => {
        const out = {};
        ids.forEach(id => {
          const el = document.querySelector(`[data-psx-id="${id}"]`);
          if (!el) return;
          const cs = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          out[id] = {
            transform: cs.transform,
            opacity: cs.opacity,
            className: typeof el.className === 'string' ? el.className : '',
            box: {
              x: Math.round(rect.x), y: Math.round(rect.y),
              w: Math.round(rect.width), h: Math.round(rect.height),
            },
          };
        });
        return out;
      }, candidateIds);

      candidateIds.forEach(id => {
        if (frame[id]) samplesById[id].push({
          scrollFrac: frac,
          transform: frame[id].transform,
          opacity: frame[id].opacity,
          className: frame[id].className,
          box: frame[id].box,
        });
      });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  const motion = {};
  for (const id of candidateIds) {
    const samples = samplesById[id] || [];
    const distinctTransforms = new Set(samples.map(s => s.transform));
    const distinctOpacity = new Set(samples.map(s => s.opacity));
    const distinctBoxes = new Set(samples.map(s => JSON.stringify(s.box)));
    const distinctClasses = new Set(samples.map(s => s.className));
    const transformChanged = distinctTransforms.size > 1 &&
      samples.some(sample => sample.transform && sample.transform !== 'none');
    const opacityChanged = distinctOpacity.size > 1;
    const transitionDuration = staticSignals[id]?.transitionDuration || '';
    const animationDuration = staticSignals[id]?.animationDuration || '';
    const hasPositiveDuration = value => value.split(',').some(part => {
      const match = part.trim().match(/^([\d.]+)(ms|s)$/);
      return match && Number(match[1]) > 0;
    });
    const hasDeclaredAnimation = hasPositiveDuration(transitionDuration) ||
      hasPositiveDuration(animationDuration);
    const scrollLinked = transformChanged || opacityChanged || hasDeclaredAnimation;

    const entry = { ...staticSignals[id] };
    if (scrollLinked) {
      entry.scrollLinked = true;
      entry.classChanges = distinctClasses.size > 1;
      // keep only the checkpoints, not every value ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â enough for a renderer
      // to build a scroll-timeline / IntersectionObserver curve from.
      entry.scrollSamples = samples;
    }
    // drop entries that carry no real signal at all
    if (Object.values(entry).some(v => v !== undefined)) {
      entry.animated = scrollLinked;
      motion[id] = entry;
    }
  }
  return motion;
}

function attachMotion(node, motionMap) {
  if (!node) return;
  if (node.psxId && motionMap[node.psxId]) node.motion = motionMap[node.psxId];
  if (node.children) node.children.forEach(c => attachMotion(c, motionMap));
}

// ============================================================
// 06 ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· LAYOUT DIRECTION + REPEAT-GROUP COLLAPSING (post-process, in Node)
// ============================================================

function inferDirection(node) {
  if (!node.children || node.children.length < 2) return undefined;
  const kids = node.children;
  const sameRow = kids.every(k => Math.abs(k.bbox.y - kids[0].bbox.y) < 8);
  const sameCol = kids.every(k => Math.abs(k.bbox.x - kids[0].bbox.x) < 8);
  if (sameRow && !sameCol) return 'row';
  if (sameCol && !sameRow) return 'column';
  return node.display && node.display.includes('flex')
    ? (node.display.includes('column') ? 'column' : 'row')
    : undefined;
}

// crude structural signature to detect "these children are basically the same shape"
function signature(node) {
  if (!node) return '';
  const kids = (node.children || []).map(signature).join(',');
  return `${node.type}:${node.children ? node.children.length : 0}[${kids}]`;
}

function widthsSimilar(a, b, tolerance = 0.15) {
  if (a === 0 && b === 0) return true;
  const diff = Math.abs(a - b) / Math.max(a, b, 1);
  return diff <= tolerance;
}

// walk a (pre-finalize) node and collect every linkPath found in it, in order
function collectLinks(node, out) {
  if (!node) return out;
  if (node.linkPath) out.push(node.linkPath);
  if (node.children) node.children.forEach(c => collectLinks(c, out));
  return out;
}

function collapseRepeats(node) {
  if (!node) return node;
  if (node.children) {
    node.children = node.children.map(collapseRepeats);
  }

  if (node.children && node.children.length >= 3) {
    const sigs = node.children.map(signature);
    const first = sigs[0];
    const allSameShape = sigs.every(s => s === first);
    const allSimilarWidth = node.children.every(c =>
      widthsSimilar(c.bbox.w, node.children[0].bbox.w)
    );

    if (allSameShape && allSimilarWidth && first !== '') {
      // one link path per repeated item, in order (e.g. real nav/footer/card
      // hrefs), even though only one item's full geometry is kept as template
      const links = node.children
        .map(c => collectLinks(c, []))
        .filter(arr => arr.length)
        .map(arr => arr[0]); // first link in each item, e.g. the card's main link

      const rep = {
        type: 'repeat-group',
        count: node.children.length,
        direction: inferDirection(node),
        gap: node.gap,
        item: node.children[0], // representative template, sizes/colors real
        links: links.length === node.children.length ? links : undefined,
      };
      node.children = undefined;
      node.repeat = rep;
    } else {
      node.direction = inferDirection(node);
    }
  }
  return node;
}

// strip internal-only helper fields; only a boolean hasText flag survives (no content)
function finalize(node) {
  if (!node) return node;
  const out = {
    tag: node.tag,
    type: node.type,
    bbox: node.bbox,
    box: { x: node.bbox.x, y: node.bbox.y, w: node.bbox.w, h: node.bbox.h },
    color: node.color,
    background: node.background,
  };
  if (node.borderWidth && parseFloat(node.borderWidth) > 0) {
    out.border = { width: node.borderWidth, color: node.borderColor, radius: node.borderRadius };
  } else if (node.borderRadius && parseFloat(node.borderRadius) > 0) {
    out.borderRadius = node.borderRadius;
  }
  if (node.boxShadow) out.boxShadow = node.boxShadow;
  if (node.opacity) out.opacity = node.opacity;
  if (node.position) out.position = node.position;
  if (node.zIndex) out.zIndex = node.zIndex;
  if (node.objectFit) out.objectFit = node.objectFit;
  if (node.bgImage) out.bgImage = node.bgImage;
  if (node.transform) out.transform = node.transform;
  if (node.linkType) out.linkType = node.linkType;
  if (node.linkPath) out.linkPath = node.linkPath;
  if (node.aspect) out.aspect = node.aspect;
  if (node.listItemCount !== undefined) out.listItemCount = node.listItemCount;
  if (node.inputType) out.inputType = node.inputType;
  out.style = {
    fontSize: node.fontSize,
    lineHeight: node.lineHeight,
    fontWeight: node.fontWeight,
    textAlign: node.textAlign,
    padding: node.padding,
    margin: node.margin,
    borderWidth: node.borderWidth,
    borderStyle: node.borderStyle,
    borderColor: node.borderColor,
    borderRadius: node.borderRadius,
    boxShadow: node.boxShadow,
    backgroundColor: node.backgroundColor || node.background,
    backgroundGradient: node.backgroundGradient,
    display: node.display,
    flexDirection: node.flexDirection,
    justifyContent: node.justifyContent,
    alignItems: node.alignItems,
    gap: node.gap,
    gridTemplateColumns: node.gridTemplateColumns,
    gridTemplateRows: node.gridTemplateRows,
    objectFit: node.objectFit,
    objectPosition: node.objectPosition,
    stickyOffset: node.stickyOffset,
  };
  Object.keys(out.style).forEach(key => {
    if (out.style[key] === undefined) delete out.style[key];
  });
  if (node.textLines) out.textLines = node.textLines;
  if (node.textRole) out.textRole = node.textRole;
  if (node.type === 'image-placeholder') {
    out.image = {
      decorative: !!node.backgroundDecorative && node.tag !== 'img' && node.tag !== 'video',
      objectFit: node.objectFit,
      objectPosition: node.objectPosition,
    };
  }
  if (node.video) out.video = node.video;
  if (node.motion) {
    out.scrollBehavior = {
      sticky: node.motion.stickyOrFixed === true && node.position === 'sticky',
      animated: node.motion.animated === true,
      ...(node.motion.animated === true && node.motion.scrollSamples
        ? { keyframes: node.motion.scrollSamples } : {}),
      animation: node.motion.animationName ? {
        name: node.motion.animationName,
        duration: node.motion.animationDuration,
        easing: node.motion.animationTimingFunction,
      } : undefined,
      transition: node.motion.transitionProperty ? {
        property: node.motion.transitionProperty,
        duration: node.motion.transitionDuration,
        easing: node.motion.transitionTimingFunction,
      } : undefined,
    };
  } else {
    out.scrollBehavior = null;
  }

  if (node.type === 'text' || node.type === 'heading' || node.type === 'button') {
    out.fontSize = node.fontSize;
    out.fontWeight = node.fontWeight;
    out.fontFamily = node.fontFamily;
    out.lineHeight = node.lineHeight;
    if (node.letterSpacing) out.letterSpacing = node.letterSpacing;
    if (node.textAlign) out.textAlign = node.textAlign;
    if (node.textTransform) out.textTransform = node.textTransform;
    out.hasText = !!node._hasText;
    if (node._textStats) out.textStats = node._textStats; // {chars, words} ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â counts only, never content
  }

  if (node.padding) out.padding = node.padding;
  if (node.margin) out.margin = node.margin;

  if (node.direction) out.direction = node.direction;
  if (node.flexDirection) out.flexDirection = node.flexDirection;
  if (node.flexWrap) out.flexWrap = node.flexWrap;
  if (node.justifyContent && node.justifyContent !== 'normal') out.justifyContent = node.justifyContent;
  if (node.alignItems && node.alignItems !== 'normal') out.alignItems = node.alignItems;
  if (node.flexGrow) out.flexGrow = node.flexGrow;
  if (node.flexShrink) out.flexShrink = node.flexShrink;
  if (node.flexBasis) out.flexBasis = node.flexBasis;
  if (node.gridTemplateColumns && node.gridTemplateColumns !== 'none') out.gridTemplateColumns = node.gridTemplateColumns;
  if (node.gridTemplateRows && node.gridTemplateRows !== 'none') out.gridTemplateRows = node.gridTemplateRows;
  if (node.gap) out.gap = node.gap;
  if (node.repeat) {
    out.repeat = {
      count: node.repeat.count,
      direction: node.repeat.direction,
      gap: node.repeat.gap,
      item: finalize(node.repeat.item),
      links: node.repeat.links, // real per-item hrefs (paths only), if present
    };
  } else if (node.children) {
    out.children = node.children.map(finalize);
  }
  return out;
}

function processTree(rawTree) {
  const collapsed = collapseRepeats(rawTree);
  return finalize(collapsed);
}

// Capture the same page at desktop / tablet / mobile so responsiveness is
// recorded data, not something the human has to invent later.
async function extractAllViewports(page, url) {
  const result = {};
  for (const [name, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    const structure = await extractStructure(page, url);
    if (!structure) return null;
    const root = processTree(structure);
    result[name] = {
      url,
      viewport: { width: size.width, height: size.height },
      elements: root ? [root] : [],
    };
  }
  return result;
}

// ============================================================
// 07 ? MAIN CRAWL LOOP
// ============================================================

(async () => {
  const runStartTime = Date.now();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let categoryLinks;
  try {
    categoryLinks = loadCategoryLinks();
  } catch (e) {
    console.error(`Could not load ${LINKS_FILE}: ${e.message}`);
    return;
  }
  console.log(`Loaded ${categoryLinks.size} categories from ${LINKS_FILE}.`);

  let browser = await chromium.launch({ headless: true });
  let page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  async function ensureHealthyPage() {
    try {
      if (page && !page.isClosed()) {
        await page.evaluate(() => true);
        return;
      }
    } catch { /* fall through to relaunch */ }
    console.log('  [recover] browser/page unresponsive ? relaunching...');
    try { await browser.close(); } catch { /* already dead, ignore */ }
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    });
  }

  let output = {};
  if (fs.existsSync(OUTPUT_INDEX_FILE)) {
    try {
      output = JSON.parse(fs.readFileSync(OUTPUT_INDEX_FILE, 'utf-8'));
      console.log(`Resuming from existing ${OUTPUT_INDEX_FILE}.`);
    } catch (e) {
      console.log(`  [warn] couldn't parse existing ${OUTPUT_INDEX_FILE} (${e.message}) ? starting fresh.`);
      output = {};
    }
  }
  for (const category of Object.keys(output)) {
    for (const siteOrigin of Object.keys(output[category] || {})) {
      if (typeof output[category][siteOrigin] === 'string') {
        output[category][siteOrigin] = {
          file: output[category][siteOrigin],
          duplicate: false,
        };
      }
    }
  }
  for (const category of Object.keys(output)) {
    if (!output[category] || typeof output[category] !== 'object') {
      output[category] = {};
      continue;
    }
    for (const siteOrigin of Object.keys(output[category])) {
      const legacyRecord = output[category][siteOrigin];
      if (!legacyRecord || typeof legacyRecord !== 'object' || !legacyRecord.pages) continue;
      try {
        const siteFile = siteOutputPath(category, siteOrigin);
        fs.mkdirSync(path.dirname(siteFile), { recursive: true });
        fs.writeFileSync(siteFile, JSON.stringify(legacyRecord, null, 2));
        output[category][siteOrigin] = {
          file: relativeOutputPath(siteFile),
          duplicate: false,
        };
      } catch (e) {
        console.log(`  [warn] couldn't migrate ${siteOrigin} to a per-site file: ${e.message}`);
      }
    }
  }
  fs.writeFileSync(OUTPUT_INDEX_FILE, JSON.stringify(output, null, 2));

  let urlRegistry = {};
  if (fs.existsSync(URL_REGISTRY_FILE)) {
    try {
      urlRegistry = JSON.parse(fs.readFileSync(URL_REGISTRY_FILE, 'utf-8'));
      if (!urlRegistry || typeof urlRegistry !== 'object') urlRegistry = {};
    } catch (e) {
      console.log(`  [warn] couldn't parse ${URL_REGISTRY_FILE} (${e.message}) - starting fresh.`);
      urlRegistry = {};
    }
  }
  for (const category of Object.keys(output)) {
    for (const siteOrigin of Object.keys(output[category] || {})) {
      const entry = output[category][siteOrigin];
      if (!entry || (typeof entry === 'object' && entry.duplicateOf)) continue;
      try {
        const normalized = normalizeSiteUrl(siteOrigin);
        const file = typeof entry === 'string' ? entry : entry.file;
        if (file && !urlRegistry[normalized]) {
          urlRegistry[normalized] = { file, category };
        }
      } catch { /* ignore malformed legacy index entries */ }
    }
  }
  fs.writeFileSync(URL_REGISTRY_FILE, JSON.stringify(urlRegistry, null, 2));

  const progressFile = path.join(OUTPUT_DIR, 'progress.json');
  let progress = { done: {}, normalizedDone: {} };
  if (fs.existsSync(progressFile)) {
    try {
      progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      if (!progress.done || typeof progress.done !== 'object') progress = { done: {} };
      if (!progress.normalizedDone || typeof progress.normalizedDone !== 'object') {
        progress.normalizedDone = {};
      }
    } catch (e) {
      console.log(`  [warn] couldn't parse ${progressFile} (${e.message}) ? starting fresh.`);
      progress = { done: {}, normalizedDone: {} };
    }
  }
  for (const [normalized, record] of Object.entries(progress.normalizedDone)) {
    if (record && record.file && !urlRegistry[normalized]) {
      urlRegistry[normalized] = record;
    }
  }
  fs.writeFileSync(URL_REGISTRY_FILE, JSON.stringify(urlRegistry, null, 2));

  let stopRequested = false;
  let samplePrinted = false;
  for (const [category, urls] of categoryLinks) {
    if (stopRequested) break;
    console.log(`\n=== ${category} === (${urls.length} links)`);
    output[category] = output[category] || {};
    const platformCounts = {};
    for (const origin of Object.keys(output[category])) {
      const platform = detectPlatform(origin);
      if (platform) platformCounts[platform] = (platformCounts[platform] || 0) + 1;
    }
    const isPlatformAllowed = platform => (platformCounts[platform] || 0) < MAX_PER_PLATFORM;

    for (let linkIndex = 0; linkIndex < urls.length; linkIndex++) {
      const seedUrl = urls[linkIndex];
      const progressKey = `${category}\u0000${linkIndex}\u0000${seedUrl}`;
      if (progress.done[progressKey]) continue;

      if (Date.now() - runStartTime >= MAX_RUNTIME_MS) {
        console.log('Time budget reached ? stopping after finishing current site. Run again to resume.');
        stopRequested = true;
        break;
      }

      let siteOrigin;
      try { siteOrigin = new URL(seedUrl).origin; } catch (e) {
        console.log(`  Skipping invalid URL ${seedUrl}: ${e.message}`);
        progress.done[progressKey] = { status: 'skipped', completedAt: new Date().toISOString() };
        fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
        continue;
      }
      const normalizedUrl = normalizeSiteUrl(seedUrl);
      const existingRecord = urlRegistry[normalizedUrl];
      if (existingRecord && existingRecord.file) {
        const duplicateSuffix = existingRecord.category === category ? `duplicate-${linkIndex}` : '';
        const referenceFile = siteOutputPath(category, siteOrigin, duplicateSuffix);
        const referencePath = relativeOutputPath(referenceFile);
        fs.mkdirSync(path.dirname(referenceFile), { recursive: true });
        fs.writeFileSync(referenceFile, JSON.stringify({ duplicateOf: existingRecord.file }, null, 2));
        const indexKey = duplicateSuffix ? `${siteOrigin}#duplicate-${linkIndex}` : siteOrigin;
        output[category][indexKey] = {
          file: referencePath,
          duplicate: true,
          duplicateOf: existingRecord.file,
        };
        fs.writeFileSync(OUTPUT_INDEX_FILE, JSON.stringify(output, null, 2));
        progress.normalizedDone[normalizedUrl] = existingRecord;
        progress.done[progressKey] = {
          status: 'duplicate',
          duplicateOf: existingRecord.file,
          completedAt: new Date().toISOString(),
        };
        fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
        const originalCategory = existingRecord.category ? ` under ${existingRecord.category}` : '';
        console.log(`Skipping ${seedUrl} under ${category} — already scraped${originalCategory}, writing reference only.`);
        continue;
      }

      const platform = detectPlatform(seedUrl);
      if (platform && !isPlatformAllowed(platform)) {
        console.log(`  Skipping ${siteOrigin} ? platform cap reached for ${platform}`);
        progress.done[progressKey] = { status: 'skipped', completedAt: new Date().toISOString() };
        fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
        continue;
      }

      console.log(`  Site ${linkIndex + 1}/${urls.length}: ${siteOrigin}`);
      await ensureHealthyPage();
      let effectivePlatform = platform;
      let skipSite = false;

      try {
        await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        if (await isCaptchaOrBotCheck(page)) {
          console.log(`  Skipping ${seedUrl} — CAPTCHA/bot-check detected, not attempting to bypass`);
          skipSite = true;
        }
        await page.waitForTimeout(300);
        if (!skipSite && await pageLooksAdultOnLoad(page)) {
          console.log(`  Skipping ${siteOrigin} ? adult content detected on page load.`);
          skipSite = true;
        }
        if (!skipSite) {
          const fingerprint = await detectBuilderFingerprintOnPage(page);
          if (fingerprint) {
            effectivePlatform = fingerprint;
            if (!isPlatformAllowed(fingerprint)) {
              console.log(`  Skipping ${siteOrigin} ? live fingerprint detected "${fingerprint}", platform cap reached.`);
              skipSite = true;
            } else if (!platform) {
              console.log(`  Note: ${siteOrigin} fingerprinted as "${fingerprint}".`);
            }
          }
        }
        if (!skipSite) {
          const signals = await assessBusinessSignals(page);
          if (looksLikeBuilderDemoPage(signals)) {
            console.log(`  Skipping ${siteOrigin} ? reads like a builder/demo/template page.`);
            skipSite = true;
          }
        }
        if (!skipSite) {
          const listicleCheck = await looksLikeListicleOrDirectory(page, seedUrl);
          if (listicleCheck.flagged) {
            console.log(`  Skipping ${siteOrigin} ? ${listicleCheck.reason}.`);
            skipSite = true;
          }
        }
        if (!skipSite && await looksLikeTemplateMarketplace(page, seedUrl)) {
          console.log(`  Skipping ${siteOrigin} ? template marketplace/demo page.`);
          skipSite = true;
        }
        if (!skipSite && await looksLikeParkedOrUnderConstruction(page)) {
          console.log(`  Skipping ${siteOrigin} ? parked or under-construction page.`);
          skipSite = true;
        }
      } catch (e) {
        console.log(`  Pre-check failed for ${siteOrigin}: ${e.message}`);
        skipSite = true;
      }

      const sitePages = {};
      if (!skipSite) {
        try {
          const homeKey = new URL(seedUrl).pathname || '/';
          const homePage = await extractAllViewports(page, seedUrl);
          if (homePage) sitePages[homeKey] = homePage;
          await page.setViewportSize(VIEWPORTS.desktop);
          const internalLinks = homePage
            ? await findInternalLinks(page, seedUrl, MAX_PAGES_PER_SITE - 1)
            : [];
          for (const link of internalLinks) {
            try {
              console.log(`    -> ${link}`);
              const key = new URL(link).pathname || link;
              const internalPage = await extractAllViewports(page, link);
              if (internalPage) sitePages[key] = internalPage;
              await page.setViewportSize(VIEWPORTS.desktop);
              await page.waitForTimeout(1000);
            } catch (e) {
              console.log(`    Failed internal page ${link}: ${e.message}`);
            }
          }
        } catch (e) {
          console.log(`  Failed site ${siteOrigin}: ${e.message}`);
          if (isLikelyConnectivityError(e)) await waitForConnectivity(page);
        }
      }

      if (Object.keys(sitePages).length > 0) {
        const siteFile = siteOutputPath(category, siteOrigin);
        const siteRecord = { pages: sitePages };
        fs.mkdirSync(path.dirname(siteFile), { recursive: true });
        fs.writeFileSync(siteFile, JSON.stringify(siteRecord, null, 2));
        const relativeSiteFile = relativeOutputPath(siteFile);
        output[category][siteOrigin] = { file: relativeSiteFile, duplicate: false };
        urlRegistry[normalizedUrl] = { file: relativeSiteFile, category };
        progress.normalizedDone[normalizedUrl] = urlRegistry[normalizedUrl];
        fs.writeFileSync(URL_REGISTRY_FILE, JSON.stringify(urlRegistry, null, 2));
        if (effectivePlatform) platformCounts[effectivePlatform] = (platformCounts[effectivePlatform] || 0) + 1;
        fs.writeFileSync(OUTPUT_INDEX_FILE, JSON.stringify(output, null, 2));
        console.log(`  Saved site -> ${siteFile}`);
        if (!samplePrinted) {
          const firstPage = Object.values(sitePages)[0];
          console.log('  First captured page JSON sample:');
          console.log(JSON.stringify(firstPage, null, 2).slice(0, 12000));
          samplePrinted = true;
        }
      } else if (!skipSite) {
        console.log(`  No usable pages captured for ${siteOrigin} ? skipped.`);
      }

      progress.done[progressKey] = {
        status: Object.keys(sitePages).length > 0 ? 'success' : 'skipped',
        completedAt: new Date().toISOString(),
      };
      fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
      await page.waitForTimeout(1500);
    }
  }

  if (!stopRequested) console.log('Finished all links in the input file.');
  console.log(`Progress saved -> ${progressFile}`);
  console.log(`\nDone. Site files indexed by ${OUTPUT_INDEX_FILE}`);
  await browser.close();
})();

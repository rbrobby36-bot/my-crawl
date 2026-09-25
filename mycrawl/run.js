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
// CRASH RESILIENCE — a single dead tab/browser must never take down a
// multi-hour, 100+ category run. Playwright sometimes rejects a promise
// asynchronously when a page/browser dies unexpectedly (crash, forced close
// by a hostile site, OOM), outside the immediate try/catch that's awaiting
// something else — which otherwise kills the whole Node process. Log it and
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
// 00a · CONNECTIVITY HANDLING
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

// Polls a known-reliable endpoint until it responds, instead of guessing a
// fixed sleep time — a commute wifi gap could be 2 minutes or 20.
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
  console.log(`  [network] still offline after ${maxWaitMs / 60000} min — giving up waiting, moving on (will retry this site on next search round).`);
  return false;
}

// ============================================================
// 00 · CONFIG
// ============================================================

const RESULTS_PER_CATEGORY = 20;     // how many SUCCESSFUL site captures to get per category
const MAX_SEED_ATTEMPTS_PER_CATEGORY = 80; // hard ceiling so a bad category can't loop forever
const MAX_PER_PLATFORM = 3;          // cap on how many sites from the same template platform (Shopify, Wix, etc.) count toward a category
const SEARCH_PAGES_PER_ENGINE = 4;   // how many result pages to paginate through per engine before giving up
const MAX_PAGES_PER_SITE = 10;       // internal pages to crawl per site (incl. homepage)
const MAX_DEPTH_PER_NODE = 6;        // how deep the DOM walk recurses
const NAV_TIMEOUT = 15000;
const SCROLL_SAMPLE_STEPS = [0, 0.25, 0.5, 0.75, 1]; // scroll-fraction checkpoints for parallax sampling

// Viewports to capture per page, so responsiveness is data, not a guess.
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet:  { width: 834,  height: 1112 },
  mobile:  { width: 390,  height: 844 },
};

const OUTPUT_DIR = 'output';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'output.json');

// URL patterns to skip when following internal links (junk, not real pages)
const SKIP_PATH_PATTERNS = [
  /\/(login|signin|sign-in|signup|sign-up|register|cart|checkout|account|logout)(\/|$)/i,
  /\/(search|tag|tags|category|categories)\?/i,
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|mp4|mp3|doc|docx|xls|xlsx)$/i,
  /^mailto:|^tel:|^javascript:/i,
  /#/, // anchor-only links, avoid re-scraping the same page
];

// ============================================================
// 01 · CATEGORY QUERIES
// ============================================================
// Curated queries for categories where a generic query pulls junk; every other
// category (most of the 119-item list) gets an auto-generated query.

const CURATED_QUERIES = {
  'Architecture / Interior Design': '"architecture studio" OR "interior design studio" official website portfolio -best -top',
  'Construction / Engineering': '"construction company" official website projects',
  'Law Firm': '"law firm" official website practice areas',
  'Private Hospital / Medical Centre': '"private hospital" official website',
  'University / College': '"university" official website admissions',
  'Hotel / Luxury Resort': '"luxury resort" official website book now',
  'Travel / Safari': '"safari tours" official website book',
  'Bank / Private Wealth Management': '"private bank" wealth management official website',
  'Accounting / Audit Firm': '"audit firm" official website services',
  'Luxury Watch Merchant / Watch Brand': 'luxury watch brand official website shop',
  'Grocery / Online Supermarket': '"online supermarket" shop groceries official website',
  'NGO / Donation Platform': '"donate now" NGO official website',
  'Creative / Advertising Agency': '"advertising agency" official website work portfolio',
  'News / Magazine / Newspaper': 'official news website homepage',
  'Corporate / Industrial Technology': '"industrial technology" company official website',
  'Global Consumer Corporation': 'global consumer brand official corporate website',
  'Smart Learning / Online Education Platform': 'online learning platform official website courses',
  'Bus Booking / Transport Marketplace': 'bus booking website book tickets online',
  'Manufacturing Company': '"manufacturing company" official website products',
  'Property / Real-Estate Developer': 'real estate developer official website projects',
  'Jewellery House': 'luxury jewellery brand official website shop',
  'Furniture / Design House': 'furniture design house official website collection',
  'Pharmacy / Health Store': 'online pharmacy official website shop',
  'Gym / Fitness Club': 'gym fitness club official website membership',
  'Sports Club': 'official sports club website',
  'Wedding / Events Studio': 'wedding events studio official website portfolio',
  'Film / Production Studio': 'film production studio official website',
  'Music / Record Label': 'record label official website artists',
  'Government / County Portal': 'county government official portal website',
  'Luxury Hotel / Fashion / Perfume Brand': 'luxury fashion perfume brand official website',
  'Luxury Fragrance House': 'luxury fragrance house official website shop',
  'Agriculture / NGO': 'agriculture NGO official website programs',
  'Private / Corporate Banking': 'corporate banking official website services',
  'Money Advisory / Financial Advisory': 'financial advisory firm official website',
  'Premium Private Banking': 'premium private banking official website',
  'Photography Studio / Photographer Portfolio': 'photographer portfolio official website',
  'Luxury Travel Agency': 'luxury travel agency official website bespoke',
  'Startup / Technology Company': 'tech startup official website product',
  'Home-Finding / Rental Property Marketplace': 'rental property marketplace official website listings',
  'Bus Booking App / Intercity Coach Platform': 'intercity coach booking app official website',
  'Supermarket / Large Retail Supermarket': 'large retail supermarket official website shop',
  'Smart Learning / Course Marketplace': 'online course marketplace official website',
  'Property Listing / Landlord Marketplace': 'property listing marketplace official website',
  'Corporate Company / General Business Website': 'corporate company official website about us',
  'Airport / Aviation': 'official airport website',
  'Airline': 'official airline website book flights',
  'Railway / Metro': 'official railway metro website timetable',
  'Logistics / Freight': '"freight" logistics company official website',
  'Shipping / Maritime': 'shipping maritime company official website',
  'Mining': 'mining company official website operations',
  'Oil & Gas': 'oil and gas company official website',
  'Renewable Energy': 'renewable energy company official website projects',
  'Telecommunications': 'telecommunications company official website plans',
  'Cloud / Data Centre': 'data centre cloud provider official website',
  'Cybersecurity': 'cybersecurity company official website solutions',
  'Software / SaaS': 'SaaS company official website product pricing',
  'AI Research Lab': 'AI research lab official website',
  'Investment / Venture Capital': 'venture capital firm official website portfolio',
  'Private Equity': 'private equity firm official website',
  'Insurance': 'insurance company official website get a quote',
  'Microfinance / Fintech': 'fintech microfinance official website app',
  'Real Estate Brokerage': 'real estate brokerage official website listings',
  'Property Management': 'property management company official website',
  'Coworking Space': 'coworking space official website membership',
  'Restaurant Group': 'restaurant group official website locations',
  'Fine Dining Restaurant': 'fine dining restaurant official website reservations',
  'Coffee Roastery': 'coffee roastery official website shop',
  'Bakery / Patisserie': 'bakery patisserie official website',
  'Food Manufacturing': 'food manufacturing company official website',
  'Brewery / Beverage Company': 'brewery beverage company official website',
  'Fashion House': 'fashion house official website collection',
  'Streetwear Brand': 'streetwear brand official website shop',
  'Perfume / Fragrance House': 'perfume fragrance house official website',
  'Beauty Brand': 'beauty brand official website shop',
  'Luxury Automotive Parts / Performance': 'luxury automotive performance parts official website',
  'Motorcycle Brand': 'motorcycle brand official website models',
  'Motorsport Team': 'motorsport racing team official website',
  'Automotive Restoration': 'automotive restoration workshop official website',
  'Car Rental / Mobility': 'car rental mobility official website book',
  'Travel Agency': 'travel agency official website book trip',
  'Expedition / Overland Company': 'overland expedition company official website',
  'Wildlife Conservation': 'wildlife conservation organization official website',
  'Environmental Consultancy': 'environmental consultancy official website services',
  'Agriculture / Agribusiness': 'agribusiness company official website',
  'Coffee Estate': 'coffee estate plantation official website',
  'Private School': 'private school official website admissions',
  'International School': 'international school official website admissions',
  'Research Institute': 'research institute official website',
  'Think Tank': 'think tank official website research',
  'Museum': 'museum official website exhibitions',
  'Art Gallery': 'art gallery official website exhibitions',
  'Architecture Biennale / Exhibition': 'architecture biennale exhibition official website',
  'Theatre': 'theatre official website tickets shows',
  'Music Festival': 'music festival official website lineup tickets',
  'Sports League': 'sports league official website standings',
  'Football Club': 'football club official website fixtures',
  'Golf Club': 'golf club official website membership',
  'Marina / Yacht Club': 'marina yacht club official website',
  'Adventure Park': 'adventure park official website tickets',
  'Funeral / Memorial Services': 'funeral memorial services official website',
  'Religious / Faith Organization': 'church faith organization official website',
  'Charity Foundation': 'charity foundation official website donate',
  'Humanitarian Organization': 'humanitarian organization official website',
  'Government Ministry': 'government ministry official website',
  'City / Municipality Portal': 'city municipality official portal website',
  'Embassy / Diplomatic Mission': 'embassy official website visa',
  'Court / Judiciary': 'court judiciary official website',
  'Professional Association': 'professional association official website membership',
  'Chamber of Commerce': 'chamber of commerce official website',
  'Recruitment / Executive Search': 'executive search recruitment firm official website',
  'HR Consultancy': 'HR consultancy official website services',
  'Accounting Software': 'accounting software official website pricing',
  'Legal-Tech': 'legal tech company official website product',
  'Health-Tech': 'health tech company official website product',
  'Medical Laboratory': 'medical laboratory official website services',
  'Dental Clinic': 'dental clinic official website appointments',
  'Veterinary Clinic': 'veterinary clinic official website appointments',
  'Pharmaceutical Company': 'pharmaceutical company official website',
  'Biotech Company': 'biotech company official website research',
};

function loadCategories() {
  const raw = fs.readFileSync('website_types_list.md', 'utf-8');
  const names = raw
    .split('\n')
    .map(line => line.match(/^\s*\d+\.\s*(.+?)\s*$/))
    .filter(Boolean)
    .map(m => m[1]);

  const queries = {};
  for (const name of names) {
    queries[name] = CURATED_QUERIES[name] || `"${name}" official website`;
  }
  return queries;
}

// ============================================================
// 02 · JUNK FILTERING
// ============================================================

const GLOBAL_JUNK_DOMAINS = [
  'wikipedia.org', 'britannica.com', 'forbes.com', 'investopedia.com',
  'unirank.org', 'universityguru.com', 'expertmarket.com', 'g2.com',
  'capterra.com', 'trustpilot.com', 'reddit.com', 'quora.com',
  'youtube.com', 'medium.com', 'bing.com', 'duckduckgo.com',
  'microsoft.com', 'go.microsoft.com', 'facebook.com', 'instagram.com',
  'twitter.com', 'x.com', 'linkedin.com', 'pinterest.com', 'yelp.com',
  // website builders / template marketplaces — these serve DEMO template
  // pages (e.g. weblium.com/templates/architecture-firm-website-design-120)
  // or per-user free-tier sites that look like a real business to a search
  // query, but aren't one. Bare domains AND their free-subdomain patterns
  // both included (e.g. 'wix.com' + 'wixsite.com' — the subdomain string is
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
  // generic dev-hosting subdomains — often personal/demo/portfolio projects
  // rather than a real business's actual site
  'github.io', 'netlify.app', 'vercel.app', 'glitch.me', 'replit.app', 'repl.co',
  // design-inspiration / gallery / showcase sites — feature OTHER people's
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
  // is looking for — they write ABOUT firms, or answer unrelated queries.
  'archdaily.com', 'dezeen.com', 'designboom.com', 'archello.com',
  'architizer.com', 'biblehub.com', 'gotquestions.org', 'biblewisdomhub.org',
  'bibleparadise.org', 'crosstalk.ai',
];

function isJunkUrl(url) {
  if (GLOBAL_JUNK_DOMAINS.some(domain => url.includes(domain))) return true;
  return isTemplateOrDemoPath(url);
}

// ============================================================
// 02a-i · PATH-PATTERN JUNK DETECTION (domain-agnostic)
// ============================================================
// The recurring failure mode: a search for e.g. "construction company
// official website" doesn't return a builder's OWN domain (which the
// domain list would catch) — it returns someone's marketing/template/demo
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
  // listicle/directory/aggregator pages — "Top 10 X Companies", "Best X
  // Firms 2026" — these are ABOUT businesses, not one, and were slipping
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
// 02a · ADULT-CONTENT FILTER (hard block, separate from general junk)
// ============================================================
// A generic query can occasionally surface adult sites in results (this
// happened live — pornhub.com, xvideos.com, xhamster.com, freeones.com,
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
// 02b · TEMPLATE-PLATFORM DETECTION (so a category doesn't fill up
// with 15 near-identical Shopify/Wix/Squarespace storefronts)
// ============================================================
// This is NOT a blocklist — those sites are still real businesses and get
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
// storefront under the hood; that's fine to keep as-is — the platform cap
// only needs to catch the obvious "hosted on the platform's own subdomain"
// case, which is what dominates generic search results.
function detectPlatform(url) {
  const match = PLATFORM_HOST_PATTERNS.find(p => p.re.test(url));
  return match ? match.name : null;
}

// ============================================================
// 02c · LIVE PAGE FINGERPRINTING (evidence-based, not a name list)
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

// Cheap, ~instant check run right after the homepage loads — reads the
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
  } catch { /* if this fails for any reason, just fall through — not fatal */ }
  return null;
}

// Adult content isn't always obvious from the URL — check the loaded
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
// 02d · POSITIVE BUSINESS-SITE VERIFICATION
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
      const hasCopyrightLine = /©|copyright|\ball rights reserved\b/i.test(bodyText);
      const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
      const hasBuilderCta = ctaPhrases.some(p => bodyText.includes(p));
      return { hasPhoneOrEmailLink, hasAddressTag, hasCopyrightLine, wordCount, hasBuilderCta };
    }, BUILDER_CTA_PHRASES);
  } catch {
    return null; // if the check itself fails, don't block on it — let the site through to normal crawl/failure handling
  }
}

// Returns true only when we're fairly confident this is a builder/demo
// page rather than a real site of ANY kind — museums, courts, embassies,
// festivals, NGOs, galleries etc. legitimately won't have a phone number,
// address tag, or copyright line on their homepage, so that combination
// was too likely to wrongly skip real non-"business" institutions across
// this category list. Only the explicit builder-CTA language is a safe,
// category-agnostic signal — kept; the low-word-count/no-contact
// combination is dropped.
function looksLikeBuilderDemoPage(signals) {
  if (!signals) return false;
  return signals.hasBuilderCta;
}

// ============================================================
// 02e · LISTICLE / DIRECTORY / AGGREGATOR DETECTION
// ============================================================
// Everything above catches "is this a template/builder demo". This catches
// a different kind of junk: pages that are genuinely real, live, well-built
// sites — just not a single business's own homepage. E.g. "12 Best Hospital
// Websites", "Architecture Portfolio | Browse Categories", a web-design
// agency's blog post, a directory that lists 40 other companies. These
// slip past every check above because they're not adult, not a
// template-seller, not flagged by any domain list — they're just the wrong
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
// many OTHER companies' domains. Threshold is deliberately generous —
// real sites can have a handful of partner/social links — this is only
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
// categories — catching the domain PATTERN (not an exhaustive name list)
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
// 02a · LLM CONFIRMATION (free-tier, optional extra layer)
// ============================================================
// Runs AFTER the regex/heuristic checks above, only on candidates that
// already passed them — so it's a cheap top-up, not a replacement.
// If no keys are set at all, this is a complete no-op and the script
// behaves exactly as before (heuristics only).
//
// Two providers, each with its OWN key pool (comma-separated), tried in
// order per candidate:
//   1. Gemini  — GEMINI_API_KEYS (your 5 keys)
//   2. OpenRouter — OPENROUTER_API_KEYS (your 6 keys), free-tier model
// For each candidate: try every Gemini key in rotation until one actually
// responds; if ALL of them fail (rate-limited, key dead, model retired —
// Google renames/deprecates free-tier models often, this is exactly the
// case that needs a fallback), fall through to OpenRouter the same way.
// Only if every key on both providers fails does it pass the candidate
// through unchecked (never blocks the crawl on an API outage).

function parseKeys(envVal) {
  return (envVal || '').split(',').map(k => k.trim()).filter(Boolean);
}

const GEMINI_API_KEYS = parseKeys(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY);
// Override with GEMINI_MODEL if Google renames/retires this one — that
// happens often enough on the free tier that it's worth being able to
// swap it via env instead of editing the script.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const OPENROUTER_API_KEYS = parseKeys(process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY);
// OpenRouter's free-tier models carry a ":free" suffix. Also overridable.
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';

function buildPrompt(title, textSnippet, url) {
  return `Title: ${title}
URL: ${url}
Page text snippet: ${textSnippet.slice(0, 500)}

Is this the official website of a single real operating business/organization (not a "best of" listicle, directory, blog post, template marketplace, or review roundup)? Answer with exactly one word: YES or NO.`;
}

async function callGeminiOnce(apiKey, prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 5, temperature: 0 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const answer = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toUpperCase();
  if (!answer) throw new Error('Gemini returned no answer text');
  return answer.startsWith('YES');
}

async function callOpenRouterOnce(apiKey, prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 5,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const data = await res.json();
  const answer = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();
  if (!answer) throw new Error('OpenRouter returned no answer text');
  return answer.startsWith('YES');
}

// Tries every key for one provider, in rotation (starting from wherever
// the last call for that provider left off, so load spreads across all
// keys over the run instead of hammering key[0] until it dies).
function makeKeyRotator(keys) {
  let i = 0;
  return async function tryProvider(callFn, prompt) {
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[i % keys.length];
      i++;
      try {
        return { ok: true, isBusiness: await callFn(key, prompt) };
      } catch (e) {
        console.log(`    [classifier] key ${attempt + 1}/${keys.length} failed: ${e.message}`);
      }
    }
    return { ok: false };
  };
}

const tryGemini = makeKeyRotator(GEMINI_API_KEYS);
const tryOpenRouter = makeKeyRotator(OPENROUTER_API_KEYS);

async function classifyBusiness(title, textSnippet, url) {
  if (GEMINI_API_KEYS.length === 0 && OPENROUTER_API_KEYS.length === 0) {
    return { checked: false, isBusiness: true }; // no keys at all -> don't block anything
  }

  const prompt = buildPrompt(title, textSnippet, url);

  if (GEMINI_API_KEYS.length > 0) {
    const result = await tryGemini(callGeminiOnce, prompt);
    if (result.ok) return { checked: true, isBusiness: result.isBusiness };
    console.log('  [classifier] all Gemini keys failed for this candidate, falling back to OpenRouter.');
  }

  if (OPENROUTER_API_KEYS.length > 0) {
    const result = await tryOpenRouter(callOpenRouterOnce, prompt);
    if (result.ok) return { checked: true, isBusiness: result.isBusiness };
    console.log('  [classifier] all OpenRouter keys failed too — passing this candidate through unchecked.');
  }

  return { checked: false, isBusiness: true };
}

// Pulls a small amount of page context for the classifier: title + first
// chunk of visible body text. Cheap, no images, no full HTML.
async function getPageSnippetForClassification(page) {
  try {
    return await page.evaluate(() => ({
      title: document.title || '',
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    }));
  } catch {
    return { title: '', text: '' };
  }
}

function decodeDuckDuckGo(href) {
  try {
    const u = new URL(href);
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : null;
  } catch { return null; }
}

function decodeBing(href) {
  try {
    const u = new URL(href);
    let param = u.searchParams.get('u');
    if (!param) return null;
    if (param.startsWith('a1')) param = param.slice(2);
    param = param.replace(/-/g, '+').replace(/_/g, '/');
    while (param.length % 4 !== 0) param += '=';
    const decoded = Buffer.from(param, 'base64').toString('utf-8');
    return decoded.startsWith('http') ? decoded : null;
  } catch { return null; }
}

function decodeYahoo(href) {
  try {
    const match = href.match(/\/RU=([^/]+)\//);
    if (match) return decodeURIComponent(match[1]);
    return href.startsWith('http') && !href.includes('r.search.yahoo.com') ? href : null;
  } catch { return null; }
}

function decodeStartpage(href) {
  try {
    const u = new URL(href);
    const target = u.searchParams.get('u') || u.searchParams.get('rdd');
    return target ? decodeURIComponent(target) : (href.startsWith('http') ? href : null);
  } catch { return null; }
}

function passthrough(href) {
  return href && href.startsWith('http') ? href : null;
}

// url() now takes a page-offset index (0 = first page) so we can paginate
// past the first ~10 results instead of only ever seeing the top page.
const SEARCH_ENGINES = [
  { name: 'duckduckgo', url: (q, p) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&s=${p * 30}`, selector: '.result__a', decode: decodeDuckDuckGo },
  { name: 'bing', url: (q, p) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&first=${p * 10 + 1}`, selector: 'li.b_algo h2 a', decode: decodeBing },
  { name: 'yahoo', url: (q, p) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}&b=${p * 10 + 1}`, selector: '#web ol li h3 a, .algo-sr h3 a', decode: decodeYahoo },
  { name: 'brave', url: (q, p) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&offset=${p}`, selector: '#results .snippet a.result-header, a[data-testid="result-title-a"]', decode: passthrough },
  { name: 'mojeek', url: (q, p) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}&s=${p * 10}`, selector: 'a.title, li.result h2 a', decode: passthrough },
  { name: 'startpage', url: (q, p) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}&page=${p + 1}`, selector: 'a.result-link, a.w-gl__result-title', decode: decodeStartpage },
  { name: 'ecosia', url: (q, p) => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}&p=${p}`, selector: '.result__title a, a.result-title', decode: passthrough },
  { name: 'qwant', url: (q, p) => `https://www.qwant.com/?q=${encodeURIComponent(q)}&t=web&p=${p + 1}`, selector: 'a[data-testid="serTitleLink"], .result--web a', decode: passthrough },
  { name: 'searx-be', url: (q, p) => `https://searx.be/search?q=${encodeURIComponent(q)}&pageno=${p + 1}`, selector: '.result h3 a, article.result a.url_header', decode: passthrough },
  { name: 'yandex', url: (q, p) => `https://yandex.com/search/?text=${encodeURIComponent(q)}&p=${p}`, selector: 'li.serp-item a.organic__url, a.Link.OrganicTitle-Link', decode: passthrough },
];

// Pulls candidate URLs for a query, paginating within an engine (so we go
// past the first page of results) and falling through engines only if one
// stops producing anything usable. `excludeUrls`/`excludeOrigins` let the
// caller skip sites it has already tried (success or failure) across
// repeated calls, and `platformCounts`+`onPlatformCheck` let the caller
// enforce the per-platform diversity cap live, during collection, rather
// than after the fact — so we don't burn a whole page of results on sites
// we're going to throw away anyway.
async function searchUrls(page, query, count, opts = {}) {
  const excludeOrigins = opts.excludeOrigins || new Set();
  const isPlatformAllowed = opts.isPlatformAllowed || (() => true);
  const collected = [];
  const seen = new Set();

  for (const engine of SEARCH_ENGINES) {
    let engineYieldedAnything = false;

    for (let p = 0; p < SEARCH_PAGES_PER_ENGINE && collected.length < count; p++) {
      try {
        console.log(`  [search] ${engine.name} page ${p + 1}...`);
        await page.goto(engine.url(query, p), { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForSelector(engine.selector, { timeout: 8000 });
        const rawHrefs = await page.$$eval(engine.selector, els => els.map(el => el.href));

        const decoded = rawHrefs
          .map(href => engine.decode(href) || passthrough(href))
          .filter(Boolean)
          .filter(u => !isJunkUrl(u))
          .filter(u => !isAdultUrl(u));

        let newOnThisPage = 0;
        for (const u of decoded) {
          let origin;
          try { origin = new URL(u).origin; } catch { continue; }
          if (seen.has(origin) || excludeOrigins.has(origin)) continue;
          const platform = detectPlatform(u);
          if (platform && !isPlatformAllowed(platform)) continue; // over the per-platform cap
          seen.add(origin);
          collected.push(u);
          newOnThisPage++;
          engineYieldedAnything = true;
        }
        console.log(`  [search] ${engine.name} page ${p + 1}: +${newOnThisPage} new (total ${collected.length}/${count})`);

        if (newOnThisPage === 0 && p > 0) break; // this engine has run dry, stop paginating it
      } catch (e) {
        console.log(`  [search] ${engine.name} page ${p + 1} failed: ${e.message}`);
        break; // don't keep hammering a broken engine's pagination
      }
    }

    if (collected.length >= count) break;
    if (!engineYieldedAnything) console.log(`  [search] ${engine.name} produced nothing usable, trying next engine`);
  }

  console.log(`  [search] collected ${collected.length}/${count} candidate urls`);
  return collected;
}

// ============================================================
// 04 · INTERNAL LINK DISCOVERY (for multi-page crawl per site)
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
// 05 · STRUCTURE EXTRACTION (colors + sizes, no text, no image src)
// ============================================================

async function extractStructure(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(500); // let late-loading styles settle

  const rawTree = await page.evaluate((maxDepth) => {
    let __psxCounter = 0;
    function walk(el, depth) {
      if (depth > maxDepth || !el) return null;
      const tag = el.tagName?.toLowerCase();
      if (!tag || ['script', 'style', 'noscript', 'template'].includes(tag)) return null;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;

      const cs = window.getComputedStyle(el);
      const children = Array.from(el.children)
        .map(c => walk(c, depth + 1))
        .filter(Boolean);

      // link classification + PATH-ONLY linkage (no query string, no link text,
      // no external domains, no email/phone values). This is enough for an LLM
      // to wire up real internal navigation (e.g. href="/shop/rings") without
      // ever seeing page copy or leaking contact details.
      let linkType, linkPath;
      if (tag === 'a') {
        const href = el.getAttribute('href') || '';
        if (!href || href === '#') {
          linkType = 'none';
        } else if (href.startsWith('#')) {
          linkType = 'anchor';
          linkPath = href; // e.g. "#page-02" — structural, not content
        } else if (href.startsWith('mailto:')) {
          linkType = 'email';
        } else if (href.startsWith('tel:')) {
          linkType = 'tel';
        } else {
          try {
            const u = new URL(href, location.href);
            if (u.origin === location.origin) {
              linkType = 'internal';
              linkPath = u.pathname || '/'; // path only — no query, no hash, no text
            } else {
              linkType = 'external'; // domain intentionally not kept
            }
          } catch { linkType = 'external'; }
        }
      }

      // background-image / gradient presence, no URLs kept
      let bgImage;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        if (cs.backgroundImage.includes('gradient')) bgImage = 'gradient';
        else if (cs.backgroundImage.includes('url(')) bgImage = 'image';
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

      // classify node type without ever storing text/src content
      let type = 'box';
      if (tag === 'img' || tag === 'picture' || tag === 'video' || tag === 'svg') type = 'media';

      // image "definition" = shape only (never src): lets a placeholder be sized
      // right (demo.html's card__media--wide / --tall / --short pattern) with
      // zero actual image data.
      let aspect;
      if (type === 'media') {
        const r = rect.width / (rect.height || 1);
        if (rect.width <= 40 && rect.height <= 40) aspect = 'icon';
        else if (r >= 2.2) aspect = 'banner';
        else if (r >= 1.15) aspect = 'wide';
        else if (r <= 0.75) aspect = 'tall';
        else aspect = 'square';
      }
      else if (tag === 'button' || (tag === 'a' && children.length === 0)) type = 'button';
      else if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) type = 'heading';
      else if (tag === 'p' || (tag === 'span' && children.length === 0)) type = 'text';
      else if (tag === 'nav') type = 'nav';
      else if (tag === 'footer') type = 'footer';
      else if (tag === 'header') type = 'header';
      else if (tag === 'ul' || tag === 'ol') type = 'list';
      else if (tag === 'form' || tag === 'input' || tag === 'textarea') type = 'form-field';

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
          x: Math.round(rect.x), y: Math.round(rect.y),
          w: Math.round(rect.width), h: Math.round(rect.height),
        },
        color: cs.color,
        background: cs.backgroundColor,
        borderRadius: cs.borderRadius,
        borderWidth: cs.borderWidth,
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
        bgImage,
        aspect,
        transform,

        // link / list / form structure (path-only linkage, no text, no values)
        linkType,
        linkPath,
        listItemCount,
        inputType,

        children: children.length ? children : undefined,
        _hasText: tag !== 'img' && el.children.length === 0 ? !!(el.textContent && el.textContent.trim().length) : undefined,
        _textStats: textStats,
      };
    }
    return walk(document.body, 0);
  }, MAX_DEPTH_PER_NODE);

  const motionMap = await sampleScrollMotion(page);
  attachMotion(rawTree, motionMap);

  return rawTree;
}

// ============================================================
// 05b · PARALLAX / SCROLL-MOTION SAMPLING
// ============================================================
// A single computed-style read (what extractStructure does above) only ever
// sees the page at rest. Parallax, scroll-linked transforms, sticky reveals,
// and CSS animations are invisible to that — so this does a second pass:
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
        (cs.transitionProperty && /transform|opacity/.test(cs.transitionProperty));
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
        transitionProperty: /transform|opacity/.test(cs.transitionProperty) ? cs.transitionProperty : undefined,
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
    for (const frac of SCROLL_SAMPLE_STEPS) {
      const y = Math.round(scrollHeight * frac);
      await page.evaluate(sy => window.scrollTo(0, sy), y);
      await page.waitForTimeout(150); // let scroll-driven styles/JS libs settle

      const frame = await page.evaluate((ids) => {
        const out = {};
        ids.forEach(id => {
          const el = document.querySelector(`[data-psx-id="${id}"]`);
          if (!el) return;
          const cs = getComputedStyle(el);
          out[id] = { transform: cs.transform, opacity: cs.opacity };
        });
        return out;
      }, candidateIds);

      candidateIds.forEach(id => {
        if (frame[id]) samplesById[id].push({ scrollFrac: frac, transform: frame[id].transform, opacity: frame[id].opacity });
      });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  const motion = {};
  for (const id of candidateIds) {
    const samples = samplesById[id] || [];
    const distinctTransforms = new Set(samples.map(s => s.transform));
    const distinctOpacity = new Set(samples.map(s => s.opacity));
    const scrollLinked = distinctTransforms.size > 1 || distinctOpacity.size > 1;

    const entry = { ...staticSignals[id] };
    if (scrollLinked) {
      entry.scrollLinked = true;
      // keep only the checkpoints, not every value — enough for a renderer
      // to build a scroll-timeline / IntersectionObserver curve from.
      entry.scrollSamples = samples;
    }
    // drop entries that carry no real signal at all
    if (Object.values(entry).some(v => v !== undefined)) motion[id] = entry;
  }
  return motion;
}

function attachMotion(node, motionMap) {
  if (!node) return;
  if (node.psxId && motionMap[node.psxId]) node.motion = motionMap[node.psxId];
  if (node.children) node.children.forEach(c => attachMotion(c, motionMap));
}

// ============================================================
// 06 · LAYOUT DIRECTION + REPEAT-GROUP COLLAPSING (post-process, in Node)
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
  if (node.motion) out.motion = node.motion; // parallax / scroll-linked / animation signals

  if (node.type === 'text' || node.type === 'heading' || node.type === 'button') {
    out.fontSize = node.fontSize;
    out.fontWeight = node.fontWeight;
    out.fontFamily = node.fontFamily;
    out.lineHeight = node.lineHeight;
    if (node.letterSpacing) out.letterSpacing = node.letterSpacing;
    if (node.textAlign) out.textAlign = node.textAlign;
    if (node.textTransform) out.textTransform = node.textTransform;
    out.hasText = !!node._hasText;
    if (node._textStats) out.textStats = node._textStats; // {chars, words} — counts only, never content
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
    result[name] = processTree(await extractStructure(page, url));
  }
  return result;
}

// ============================================================
// 07 · MAIN CRAWL LOOP
// ============================================================

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const CATEGORY_QUERIES = loadCategories();
  const categories = Object.keys(CATEGORY_QUERIES);
  console.log(`Loaded ${categories.length} categories.`);

  let browser = await chromium.launch({ headless: false });
  let page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  // Call this before anything that touches `page`. If the tab/browser died
  // (crashed, killed by a hostile site, etc.) it transparently relaunches a
  // fresh browser+page so the run keeps going instead of dying entirely.
  async function ensureHealthyPage() {
    try {
      if (page && !page.isClosed()) {
        // isClosed() only tells us the Page object itself wasn't explicitly
        // closed — it doesn't catch a crashed renderer. A cheap real check:
        await page.evaluate(() => true);
        return;
      }
    } catch { /* fall through to relaunch */ }

    console.log('  [recover] browser/page unresponsive — relaunching...');
    try { await browser.close(); } catch { /* already dead, ignore */ }
    browser = await chromium.launch({ headless: false });
    page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    });
  }

  // RESUME SUPPORT — this run can be stopped (Ctrl+C, wifi drop, closing the
  // terminal) and restarted at any time. On start, load whatever output.json
  // already exists from a previous run and pick up exactly where it left
  // off: categories already at target are skipped entirely, and sites
  // already captured for a category are neither re-crawled nor re-counted.
  let output = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      output = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      console.log(`Resuming from existing ${OUTPUT_FILE} (${Object.keys(output).length} categories already have some data).`);
    } catch (e) {
      console.log(`  [warn] couldn't parse existing ${OUTPUT_FILE} (${e.message}) — starting fresh.`);
      output = {};
    }
  }

  for (const category of categories) {
    const query = CATEGORY_QUERIES[category];

    const existingSites = output[category] || {};
    const alreadyDone = Object.keys(existingSites).length;
    if (alreadyDone >= RESULTS_PER_CATEGORY) {
      console.log(`\n=== ${category} === already complete (${alreadyDone}/${RESULTS_PER_CATEGORY}), skipping.`);
      continue;
    }

    console.log(`\n=== ${category} ===`);
    console.log(`  query: ${query}`);
    if (alreadyDone > 0) console.log(`  resuming: ${alreadyDone}/${RESULTS_PER_CATEGORY} already captured`);

    output[category] = existingSites;
    // every origin already captured for this category must never be re-tried
    const triedOrigins = new Set(Object.keys(existingSites));
    const platformCounts = {};            // platform name -> successful count, for the diversity cap
    // re-derive platform counts from what's already on disk, so the cap
    // still holds correctly across a resume instead of resetting to 0
    for (const origin of triedOrigins) {
      const platform = detectPlatform(origin);
      if (platform) platformCounts[platform] = (platformCounts[platform] || 0) + 1;
    }
    const isPlatformAllowed = (platform) => (platformCounts[platform] || 0) < MAX_PER_PLATFORM;

    let successCount = alreadyDone;
    let attempts = 0;
    let roundsWithNoNewCandidates = 0;

    // Keep pulling more candidates and crawling them until we actually HAVE
    // RESULTS_PER_CATEGORY successful captures — not just RESULTS_PER_CATEGORY
    // attempts. A failed/skipped site no longer silently shrinks the category.
    while (successCount < RESULTS_PER_CATEGORY && attempts < MAX_SEED_ATTEMPTS_PER_CATEGORY) {
      const stillNeeded = RESULTS_PER_CATEGORY - successCount;
      // ask for extra headroom since some of these will fail or get capped
      const batchTarget = Math.min(MAX_SEED_ATTEMPTS_PER_CATEGORY - attempts, stillNeeded * 2);

      await ensureHealthyPage();
      const seedUrls = await searchUrls(page, query, batchTarget, {
        excludeOrigins: triedOrigins,
        isPlatformAllowed,
      });

      if (seedUrls.length === 0) {
        roundsWithNoNewCandidates++;
        console.log(`  No new candidate urls this round (${roundsWithNoNewCandidates}).`);
        if (roundsWithNoNewCandidates >= 2) {
          console.log(`  Search exhausted for "${category}" — stopping at ${successCount}/${RESULTS_PER_CATEGORY}.`);
          break;
        }
        continue;
      }
      roundsWithNoNewCandidates = 0;

      for (const seedUrl of seedUrls) {
        if (successCount >= RESULTS_PER_CATEGORY || attempts >= MAX_SEED_ATTEMPTS_PER_CATEGORY) break;

        let siteOrigin;
        try { siteOrigin = new URL(seedUrl).origin; } catch { continue; }
        if (triedOrigins.has(siteOrigin)) continue;

        const platform = detectPlatform(seedUrl);
        if (platform && !isPlatformAllowed(platform)) {
          console.log(`  Skipping ${siteOrigin} — platform cap reached for ${platform}`);
          continue;
        }

        console.log(`  Site (${successCount}/${RESULTS_PER_CATEGORY}): ${siteOrigin}`);
        await ensureHealthyPage();

        // Quick pre-check: load the homepage once, look at what the PAGE
        // itself says before doing the full 3-viewport extraction. Catches
        // adult content and builder/gallery platforms that aren't in any
        // domain list yet — no maintenance needed as new ones show up.
        let effectivePlatform = platform;
        try {
          await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
          await page.waitForTimeout(300);

          if (await pageLooksAdultOnLoad(page)) {
            console.log(`  Skipping ${siteOrigin} — adult content detected on page load (title/meta), not caught by URL filter.`);
            triedOrigins.add(siteOrigin);
            attempts++;
            continue;
          }

          const fingerprint = await detectBuilderFingerprintOnPage(page);
          if (fingerprint) {
            effectivePlatform = fingerprint; // not a hard block — same treatment as detectPlatform, just caught live instead of by domain
            if (!isPlatformAllowed(fingerprint)) {
              console.log(`  Skipping ${siteOrigin} — live fingerprint detected "${fingerprint}", platform cap reached.`);
              triedOrigins.add(siteOrigin);
              attempts++;
              continue;
            } else if (!platform) {
              console.log(`  Note: ${siteOrigin} fingerprinted as "${fingerprint}" (not caught by domain list) — counts toward that platform's cap.`);
            }
          }

          // POSITIVE check — does this even look like a real, running
          // business, independent of whether it fingerprinted as a known
          // builder? Catches demo/marketing/template pages hosted on
          // domains with no fingerprint and no junk-path match at all.
          const signals = await assessBusinessSignals(page);
          if (looksLikeBuilderDemoPage(signals)) {
            console.log(`  Skipping ${siteOrigin} — reads like a builder/demo/template page, not a real business (signals: ${JSON.stringify(signals)}).`);
            triedOrigins.add(siteOrigin);
            attempts++;
            continue;
          }

          // Catches listicles/directories/agency blog posts ("12 Best
          // Hospital Websites", "Architecture Portfolio | Browse
          // Categories") — real, live, well-built pages that just aren't a
          // single business's own site. Not caught by any check above.
          const listicleCheck = await looksLikeListicleOrDirectory(page, seedUrl);
          if (listicleCheck.flagged) {
            console.log(`  Skipping ${siteOrigin} — ${listicleCheck.reason}.`);
            triedOrigins.add(siteOrigin);
            attempts++;
            continue;
          }

          // Extra layer: only runs if GROQ_API_KEY is set (see config at
          // top of file / GitHub Actions secret). Everything above already
          // ran for free — this just double-checks the survivors.
          const snippet = await getPageSnippetForClassification(page);
          const classification = await classifyBusiness(snippet.title, snippet.text, seedUrl);
          if (classification.checked && !classification.isBusiness) {
            console.log(`  Skipping ${siteOrigin} — classifier says this isn't a single real business site (title: "${snippet.title}").`);
            triedOrigins.add(siteOrigin);
            attempts++;
            continue;
          }
        } catch (e) {
          // Let the normal connectivity/failure handling below deal with
          // this the same way as before — pre-check failing isn't fatal.
          console.log(`  Pre-check failed for ${siteOrigin}: ${e.message}`);
        }

        const sitePages = {};
        let hitConnectivityFailure = false;

        try {
          const homeKey = new URL(seedUrl).pathname || '/';
          sitePages[homeKey] = await extractAllViewports(page, seedUrl);
          await page.setViewportSize(VIEWPORTS.desktop);

          const internalLinks = await findInternalLinks(page, seedUrl, MAX_PAGES_PER_SITE - 1);
          for (const link of internalLinks) {
            try {
              console.log(`    -> ${link}`);
              const key = new URL(link).pathname || link;
              sitePages[key] = await extractAllViewports(page, link);
              await page.setViewportSize(VIEWPORTS.desktop);
              await page.waitForTimeout(1000);
            } catch (e) {
              console.log(`    Failed internal page ${link}: ${e.message}`);
            }
          }
        } catch (e) {
          console.log(`  Failed site ${siteOrigin}: ${e.message}`);
          // Don't burn this origin on a connectivity failure (wifi drop,
          // DNS down, tunnel/train wifi flaking, etc) — those aren't the
          // site's fault and would otherwise permanently mark a perfectly
          // good candidate as "tried" and skip it forever. Real site
          // problems (404, bad cert, actually broken page) still count.
          if (isLikelyConnectivityError(e)) {
            hitConnectivityFailure = true;
          }
        }

        if (hitConnectivityFailure) {
          console.log(`  Looks like a connectivity issue, not a bad site — will retry ${siteOrigin} later. Waiting for network...`);
          await waitForConnectivity(page);
          continue; // do NOT mark triedOrigins / attempts — retry this same seedUrl next loop
        }

        triedOrigins.add(siteOrigin);
        attempts++;

        if (Object.keys(sitePages).length > 0) {
          output[category][siteOrigin] = { pages: sitePages };
          successCount++;
          if (effectivePlatform) platformCounts[effectivePlatform] = (platformCounts[effectivePlatform] || 0) + 1;
          // Actions), wifi drop, or laptop close can kill the process at any
          // moment. Writing here means the only possible loss is the ONE
          // site that was mid-crawl when it died — never a whole category's
          // worth of already-captured sites.
          fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
          console.log(`  Saved progress -> ${OUTPUT_FILE} (${successCount}/${RESULTS_PER_CATEGORY} for "${category}")`);
        } else {
          console.log(`  No usable pages captured for ${siteOrigin} — will not count toward target, not retried.`);
        }
        await page.waitForTimeout(1500);
      }
    }

    if (successCount < RESULTS_PER_CATEGORY) {
      console.log(`  Finished "${category}" short: ${successCount}/${RESULTS_PER_CATEGORY} (${attempts} attempts made).`);
    } else {
      console.log(`  Reached target for "${category}": ${successCount}/${RESULTS_PER_CATEGORY}.`);
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`  Saved progress -> ${OUTPUT_FILE}`);
  }

  console.log(`\nDone. Results in ${OUTPUT_FILE}`);
  await browser.close();
})();

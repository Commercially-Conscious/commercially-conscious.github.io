import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Parser from 'rss-parser';

// BBC is pinned — always included, every week.
const PINNED_OUTLET = { outlet: 'BBC News', feedUrl: 'http://feeds.bbci.co.uk/news/business/rss.xml', category: 'markets', topicFilter: false };

// Rotation pool of outlets whose articles read free in full (no hard paywall).
// A random subset is picked each run so the same outlets don't appear every
// week. (The Economist was deliberately left out of this pool — it's a hard
// paywall and doesn't fit "read the full story for free".)
const OUTLET_POOL = [
  { outlet: 'Al Jazeera', feedUrl: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'global-trade', topicFilter: true },
  { outlet: 'Yahoo Finance', feedUrl: 'https://finance.yahoo.com/news/rssindex', category: 'markets', topicFilter: false },
  { outlet: 'Investing.com', feedUrl: 'https://www.investing.com/rss/news.rss', category: 'markets', topicFilter: false },
  { outlet: 'The Guardian', feedUrl: 'https://www.theguardian.com/uk/business/rss', category: 'markets', topicFilter: false },
  { outlet: 'Deutsche Welle', feedUrl: 'https://rss.dw.com/rdf/rss-en-bus', category: 'global-trade', topicFilter: false },
  // MarketWatch's "top stories" feed mixes real markets news with personal-
  // finance advice columns and pure lifestyle content (streaming picks,
  // reader Q&As) that have no informational value for this site — filtered
  // to on-topic items only, unlike the other dedicated business/finance feeds.
  { outlet: 'MarketWatch', feedUrl: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', category: 'markets', topicFilter: true },
  { outlet: 'NPR', feedUrl: 'https://feeds.npr.org/1006/rss.xml', category: 'markets', topicFilter: false },
];

// Best-effort outlets that have historically blocked automated access — kept
// in rotation in case that ever changes, but never relied on.
const BEST_EFFORT_OUTLETS = [
  { outlet: 'Reuters', feedUrl: 'https://www.reuters.com/rssFeed/businessNews', category: 'markets', topicFilter: false },
  { outlet: 'News24/Fin24', feedUrl: 'https://feeds.news24.com/articles/fin24/News/rss', category: 'markets', topicFilter: false },
];

const MIN_POOL_OUTLETS = 3;
const MAX_POOL_OUTLETS = 5;

function pickThisWeeksOutlets() {
  const shuffled = [...OUTLET_POOL].sort(() => Math.random() - 0.5);
  const count = MIN_POOL_OUTLETS + Math.floor(Math.random() * (MAX_POOL_OUTLETS - MIN_POOL_OUTLETS + 1));
  return [PINNED_OUTLET, ...shuffled.slice(0, count), ...BEST_EFFORT_OUTLETS];
}

// Dedicated South African outlets — tried every week, separate from the
// international rotation above. Every headline from these counts as
// "south-africa" category regardless of topic.
const SOUTH_AFRICA_OUTLETS = [
  { outlet: 'SABC News', feedUrl: 'https://www.sabcnews.com/sabcnews/feed/' },
  { outlet: 'IOL', feedUrl: 'https://www.iol.co.za/rss' },
  { outlet: 'The Citizen', feedUrl: 'https://www.citizen.co.za/feed/' },
];
const MAX_SOUTH_AFRICA_HEADLINES = 2;

const MAX_PER_OUTLET = 3;
const FINANCE_KEYWORDS = /econom|market|trade|tariff|inflation|central bank|interest rate|\bgdp\b|stock|currency|bond|imf|world bank|business|financ|recession|budget|deficit|exports?|imports?/i;
const ACQUISITION_KEYWORDS = /\bacqui(re|res|red|sition|sitions|ring)\b|\bmerg(er|ers|es|ing)\b|\bbuyout\b|\btakeover\b|\bm&a\b/i;
const ECONOMICS_KEYWORDS = /inflation|\bgdp\b|recession|unemployment|interest rate|central bank|monetary policy|fiscal policy|economic growth|\beconomy\b|econom|\bimf\b|world bank|stimulus|jobs report|labou?r market/i;
const TARIFF_KEYWORDS = /\btariff|trade war|import duty|import duties|customs duty|anti-dumping|section 301|trade barrier/i;
const AI_KEYWORDS = /\bai\b|artificial intelligence|machine learning|\bllm\b|large language model|generative ai|chatgpt|neural network|\bopenai\b|\banthropic\b/i;

// Stricter than FINANCE_KEYWORDS, used only for the general-news South
// African outlets below. Bare "market" is too loose there — it matched
// "officially off the market" in a celebrity gossip story — so this
// requires "market" to be qualified (stock market, job market, etc.) and
// adds SA-specific economic terms.
const SOUTH_AFRICA_FINANCE_KEYWORDS = /econom|\b(stock|housing|job|labou?r|financial|money|currency|forex|bond|equity|energy|fuel|petrol|food|property)\s+markets?\b|tariff|inflation|(central|reserve)\s+bank|interest rate|\bgdp\b|\bjse\b|\brand\b|\bimf\b|world bank|\bbusiness\b|financ|recession|budget|deficit|exports?|imports?|unemployment|load.?shedding|\beskom\b|\bsars\b|treasury|\btax(es)?\b/i;

// Lifestyle/horoscope columns sometimes namedrop "business" (e.g. "let the
// cosmos guide your business this month") to pass a keyword filter. Excluded
// outright regardless of any other match.
const ASTROLOGY_KEYWORDS = /horoscope|astrology|\bzodiac\b|\bcosmos\b|astral|\btarot\b|star sign|\bmercury retrograde\b/i;

// Personal-finance advice columns ("My girlfriend is 62, can she claim...",
// "If I buy a house for $1m, will I run out of money by 90?") read as
// finance-relevant by keyword alone — mentioning money, retirement, etc. —
// but have no informational value as news. These are near-universally
// phrased as a first-person question, which real news headlines aren't.
const PERSONAL_ADVICE_PATTERN = /^(i |i'|my |we're |we are |our |if i |should i |can i |is it |will i |do i |does )/i;

function isPersonalAdviceColumn(headline) {
  const trimmed = (headline || '').trim().replace(/[‘’]/g, "'");
  return PERSONAL_ADVICE_PATTERN.test(trimmed) && trimmed.endsWith('?');
}

// Used only when a feed gives no real description, so the summary never
// just repeats the headline verbatim.
const CATEGORY_TEASERS = {
  markets: 'A markets move worth a closer look.',
  economics: 'An economic development worth tracking.',
  'global-trade': 'A trade and policy story worth watching.',
  'mergers-and-acquisitions': 'A deal worth keeping an eye on.',
  tariffs: 'A tariff story worth watching.',
  ai: 'An AI story worth watching.',
  'south-africa': 'A South African story worth a closer look.',
  default: 'Worth a closer look.',
};

function buildEntry(outletName, entry, link, category) {
  const headline = (entry.title || '').replace(/\s+/g, ' ').trim();
  const raw = (entry.contentSnippet || entry.summary || entry.content || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const isDuplicateOfHeadline = !raw || raw.toLowerCase() === headline.toLowerCase();
  const summary = isDuplicateOfHeadline
    ? CATEGORY_TEASERS[category] || CATEGORY_TEASERS.default
    : raw.length > 220
      ? `${raw.slice(0, 217)}...`
      : raw;

  return { outlet: outletName, headline, summary, url: link, category };
}

const parser = new Parser();
const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(feedUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feedUrl, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; CommerciallyConsciousBot/1.0)' },
    });
    if (!res.ok) throw new Error(`Status code ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFeed(feedUrl, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const xml = await fetchWithTimeout(feedUrl);
      return await parser.parseString(xml);
    } catch (err) {
      lastError = err.name === 'AbortError' ? new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms`) : err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function formatShort(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function formatLong(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

async function main() {
  const now = new Date();
  // Cover the 7 days ending yesterday (the week that just finished), not the
  // week ahead — this script runs Monday morning, so "yesterday" is Sunday
  // and weekStart lands on the Monday before that.
  const weekEnd = new Date(now);
  weekEnd.setUTCDate(now.getUTCDate() - 1);
  weekEnd.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(weekEnd);
  weekStart.setUTCDate(weekEnd.getUTCDate() - 6);

  const outletsThisWeek = pickThisWeeksOutlets();
  console.log(`This week's outlets: ${outletsThisWeek.map((o) => o.outlet).join(', ')}`);

  const byOutlet = new Map();
  const skipped = [];

  for (const outlet of outletsThisWeek) {
    console.log(`Fetching ${outlet.outlet}...`);
    let feed;
    try {
      feed = await fetchFeed(outlet.feedUrl);
      console.log(`  -> ok, ${feed.items?.length ?? 0} items`);
    } catch (err) {
      console.log(`  -> skipped: ${err.message || String(err)}`);
      skipped.push({ outlet: outlet.outlet, error: err.message || String(err) });
      continue;
    }

    const bucket = [];
    for (const entry of feed.items || []) {
      const text = `${entry.title || ''} ${entry.contentSnippet || entry.summary || entry.content || ''}`;
      if (outlet.topicFilter && !FINANCE_KEYWORDS.test(text)) continue;
      if (isPersonalAdviceColumn(entry.title)) continue;

      const link = entry.link || entry.guid || '';
      if (!link) continue;
      if (bucket.some((e) => e.link === link)) continue;

      let matchedCategory = null;
      if (ACQUISITION_KEYWORDS.test(text)) matchedCategory = 'mergers-and-acquisitions';
      else if (TARIFF_KEYWORDS.test(text)) matchedCategory = 'tariffs';
      else if (AI_KEYWORDS.test(text)) matchedCategory = 'ai';
      else if (ECONOMICS_KEYWORDS.test(text)) matchedCategory = 'economics';

      bucket.push({ entry, link, matchedCategory });
    }
    byOutlet.set(outlet.outlet, { bucket, category: outlet.category });
  }

  const entries = [];
  for (const [outletName, { bucket, category }] of byOutlet) {
    const acquisitions = bucket.filter((b) => b.matchedCategory === 'mergers-and-acquisitions');
    const tariffs = bucket.filter((b) => b.matchedCategory === 'tariffs');
    const ai = bucket.filter((b) => b.matchedCategory === 'ai');
    const economics = bucket.filter((b) => b.matchedCategory === 'economics');
    const others = bucket.filter((b) => !b.matchedCategory);

    const picks = [...acquisitions.slice(0, 1), ...tariffs.slice(0, 1), ...ai.slice(0, 1), ...economics.slice(0, 1), ...others].slice(0, MAX_PER_OUTLET);

    for (const { entry, link, matchedCategory } of picks) {
      entries.push(buildEntry(outletName, entry, link, matchedCategory || category));
    }
  }

  console.log('Fetching South African outlets...');
  const southAfricaBucket = [];
  for (const outlet of SOUTH_AFRICA_OUTLETS) {
    console.log(`Fetching ${outlet.outlet}...`);
    try {
      const feed = await fetchFeed(outlet.feedUrl);
      console.log(`  -> ok, ${feed.items?.length ?? 0} items`);
      for (const entry of feed.items || []) {
        if (isPersonalAdviceColumn(entry.title)) continue;
        const text = `${entry.title || ''} ${entry.contentSnippet || entry.summary || entry.content || ''}`;
        if (ASTROLOGY_KEYWORDS.test(text)) continue;
        const link = entry.link || entry.guid || '';
        if (!link) continue;
        if (southAfricaBucket.some((e) => e.link === link)) continue;
        southAfricaBucket.push({ outletName: outlet.outlet, entry, link, isFinance: SOUTH_AFRICA_FINANCE_KEYWORDS.test(text) });
      }
    } catch (err) {
      console.log(`  -> skipped: ${err.message || String(err)}`);
      skipped.push({ outlet: outlet.outlet, error: err.message || String(err) });
    }
  }

  // Only finance/business-relevant South African stories qualify — these
  // outlets are general news, not finance-scoped, so unlike the main pool
  // there's no native topic filter. No padding with off-topic stories: some
  // weeks may have 0 or 1 rather than 2, which beats running a gossip or
  // sports story just to fill the slot.
  const southAfricaPicks = southAfricaBucket
    .filter((b) => b.isFinance && !isPersonalAdviceColumn(b.entry.title))
    .slice(0, MAX_SOUTH_AFRICA_HEADLINES);

  for (const { outletName, entry, link } of southAfricaPicks) {
    entries.push(buildEntry(outletName, entry, link, 'south-africa'));
  }

  console.log(`Fetched ${byOutlet.size}/${outletsThisWeek.length} outlets successfully.`);
  if (skipped.length > 0) {
    console.log('Skipped outlets:');
    for (const s of skipped) console.log(`  - ${s.outlet}: ${s.error}`);
  }
  console.log(`Selected ${entries.length} headline(s).`);

  if (entries.length === 0) {
    console.warn('No headlines available this week — not writing a digest file.');
    return;
  }

  const weekStartStr = isoDate(weekStart);
  const weekEndStr = isoDate(weekEnd);
  const outletNames = [...new Set(entries.map((e) => e.outlet))];

  const frontmatter = {
    title: `Weekly Roundup: ${formatShort(weekStart)} – ${formatLong(weekEnd)}`,
    pubDate: isoDate(now),
    weekStart: weekStartStr,
    weekEnd: weekEndStr,
    description: `This week's roundup covers ${entries.length} headline${entries.length === 1 ? '' : 's'} from ${outletNames.join(', ')}.`,
    entries,
  };

  const markdown = `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n`;
  const outDir = path.join(process.cwd(), 'src', 'content', 'digests');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${weekStartStr}-weekly-roundup.md`);
  await writeFile(outFile, markdown, 'utf8');
  console.log(`Wrote ${outFile}`);
}

main().catch((err) => {
  console.error('Fatal error building the weekly digest:', err);
  process.exit(1);
});

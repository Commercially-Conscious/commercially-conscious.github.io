import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Parser from 'rss-parser';

const OUTLETS = [
  { outlet: 'BBC News', feedUrl: 'http://feeds.bbci.co.uk/news/business/rss.xml', category: 'markets', topicFilter: false },
  { outlet: 'Al Jazeera', feedUrl: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'global-trade', topicFilter: true },
  { outlet: 'Yahoo Finance', feedUrl: 'https://finance.yahoo.com/news/rssindex', category: 'markets', topicFilter: false },
  { outlet: 'Investing.com', feedUrl: 'https://www.investing.com/rss/news.rss', category: 'markets', topicFilter: false },
  { outlet: 'Reuters', feedUrl: 'https://www.reuters.com/rssFeed/businessNews', category: 'markets', topicFilter: false },
  { outlet: 'News24/Fin24', feedUrl: 'https://feeds.news24.com/articles/fin24/News/rss', category: 'markets', topicFilter: false },
  { outlet: 'The Economist', feedUrl: 'https://www.economist.com/finance-and-economics/rss.xml', category: 'markets', topicFilter: false },
];

const MAX_PER_OUTLET = 3;
const FINANCE_KEYWORDS = /econom|market|trade|tariff|inflation|central bank|interest rate|\bgdp\b|stock|currency|bond|imf|world bank|business|financ|recession|budget|deficit|exports?|imports?/i;
const ACQUISITION_KEYWORDS = /\bacqui(re|res|red|sition|sitions|ring)\b|\bmerg(er|ers|es|ing)\b|\bbuyout\b|\btakeover\b|\bm&a\b/i;
const ECONOMICS_KEYWORDS = /inflation|\bgdp\b|recession|unemployment|interest rate|central bank|monetary policy|fiscal policy|economic growth|\beconomy\b|econom|\bimf\b|world bank|stimulus|jobs report|labou?r market/i;

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
  const day = now.getUTCDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - diffToMonday);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

  const byOutlet = new Map();
  const skipped = [];

  for (const outlet of OUTLETS) {
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

      const link = entry.link || entry.guid || '';
      if (!link) continue;
      if (bucket.some((e) => e.link === link)) continue;

      let matchedCategory = null;
      if (ACQUISITION_KEYWORDS.test(text)) matchedCategory = 'mergers-and-acquisitions';
      else if (ECONOMICS_KEYWORDS.test(text)) matchedCategory = 'economics';

      bucket.push({ entry, link, matchedCategory });
    }
    byOutlet.set(outlet.outlet, { bucket, category: outlet.category });
  }

  const entries = [];
  for (const [outletName, { bucket, category }] of byOutlet) {
    const acquisitions = bucket.filter((b) => b.matchedCategory === 'mergers-and-acquisitions');
    const economics = bucket.filter((b) => b.matchedCategory === 'economics');
    const others = bucket.filter((b) => !b.matchedCategory);

    const picks = [...acquisitions.slice(0, 1), ...economics.slice(0, 1), ...others].slice(0, MAX_PER_OUTLET);

    for (const { entry, link, matchedCategory } of picks) {
      const raw = (entry.contentSnippet || entry.summary || entry.content || entry.title || '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const summary = raw.length > 220 ? `${raw.slice(0, 217)}...` : raw;

      entries.push({
        outlet: outletName,
        headline: (entry.title || '').replace(/\s+/g, ' ').trim(),
        summary,
        url: link,
        category: matchedCategory || category,
      });
    }
  }

  console.log(`Fetched ${byOutlet.size}/${OUTLETS.length} outlets successfully.`);
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

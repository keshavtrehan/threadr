const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const cheerio = require('cheerio');

// got v14 is ESM-only.
let _got;
async function getGot() {
  if (!_got) {
    const mod = await import('got');
    _got = mod.got;
  }
  return _got;
}

const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES      = 2;
const MAX_CANDIDATES   = 2;
const CONCURRENCY      = 5;

// ~4 chars per token is a conservative estimate; 1,200 tokens ≈ 4,800 chars.
const MAX_CHARS = 4800;

// ---------------------------------------------------------------------------
// Semaphore — limits simultaneous in-flight fetches across all emails.
// ---------------------------------------------------------------------------
function createSemaphore(limit) {
  let active = 0;
  const queue = [];

  return async function acquire(fn) {
    if (active >= limit) {
      await new Promise(resolve => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length > 0) queue.shift()();
    }
  };
}

// ---------------------------------------------------------------------------
// Candidate ranking — snippet substance = word count minus low-value anchors.
// ---------------------------------------------------------------------------
const LOW_VALUE_ANCHOR = /^(click here|here|read more|learn more|more|this|link|article|post)$/i;

function scoreCandidate({ anchorText, surroundingSnippet }) {
  const words = (surroundingSnippet || '').split(/\s+/).filter(Boolean).length;
  const penalty = LOW_VALUE_ANCHOR.test((anchorText || '').trim()) ? 15 : 0;
  return words - penalty;
}

function topCandidates(candidates) {
  return [...candidates]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------
// HTTP fetch with manual retry.
// ---------------------------------------------------------------------------
async function fetchWithRetry(got, url) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await got.get(url, {
        timeout: { request: FETCH_TIMEOUT_MS },
        throwHttpErrors: false,
        followRedirect: true,
      });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Extraction helpers.
// ---------------------------------------------------------------------------
function extractArticleBody(html, url) {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article?.textContent?.trim().length > 100) {
      return { title: article.title || '', body: article.textContent.trim() };
    }
  } catch { /* fall through */ }
  return null;
}

function extractOgDescription(html) {
  const $ = cheerio.load(html);
  return (
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    ''
  ).trim();
}

function extractOgTitle(html) {
  const $ = cheerio.load(html);
  return (
    $('meta[property="og:title"]').attr('content') ||
    $('title').text() ||
    ''
  ).trim();
}

function truncate(text) {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + ' […]';
}

// ---------------------------------------------------------------------------
// Fetch a single article. Returns a DigestArticle object.
// ---------------------------------------------------------------------------
async function fetchArticle(got, candidate, emailSource) {
  const { anchorText, resolvedUrl, surroundingSnippet } = candidate;

  try {
    const res = await fetchWithRetry(got, resolvedUrl);
    const html = res.body || '';

    // Priority 1: full article body via Readability.
    const article = extractArticleBody(html, resolvedUrl);
    if (article) {
      return {
        title: article.title || anchorText,
        resolvedUrl,
        body: truncate(article.body),
        source: emailSource,
        fallbackUsed: false,
      };
    }

    // Priority 2: Open Graph / meta description.
    const ogDesc = extractOgDescription(html);
    if (ogDesc) {
      return {
        title: extractOgTitle(html) || anchorText,
        resolvedUrl,
        body: truncate(ogDesc),
        source: emailSource,
        fallbackUsed: true,
      };
    }
  } catch (err) {
    console.warn(`[fetchArticles] Failed to fetch ${resolvedUrl}: ${err.message}`);
  }

  // Priority 3: email snippet — always available.
  return {
    title: anchorText,
    resolvedUrl,
    body: truncate(surroundingSnippet || ''),
    source: emailSource,
    fallbackUsed: true,
  };
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Fetch article content for the top candidates across all resolved emails.
 *
 * @param {{ source: string, candidates: object[] }[]} resolvedEmails
 *   Output of resolveAllLinks.
 * @returns {Promise<{ title, resolvedUrl, body, source, fallbackUsed }[]>}
 */
async function fetchArticles(resolvedEmails) {
  const got = await getGot();
  const sem = createSemaphore(CONCURRENCY);

  // Build a flat list of fetch tasks: (candidate, emailSource) pairs,
  // using only the top-ranked candidates per email.
  const tasks = resolvedEmails.flatMap(({ source, candidates }) =>
    topCandidates(candidates).map(candidate => ({ candidate, source }))
  );

  console.log(`[fetchArticles] Fetching ${tasks.length} articles (concurrency limit: ${CONCURRENCY}).`);

  const results = await Promise.all(
    tasks.map(({ candidate, source }) =>
      sem(() => fetchArticle(got, candidate, source))
    )
  );

  const fallbacks = results.filter(r => r.fallbackUsed).length;
  console.log(
    `[fetchArticles] Done — ${results.length} articles fetched, ${fallbacks} used fallback content.`
  );

  return results;
}

module.exports = { fetchArticles };

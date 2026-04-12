const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const cheerio = require('cheerio');

// Patterns that identify unsubscribe / preference-centre links.
const UNSUBSCRIBE_TEXT = /unsubscri|opt.?out|manage.{0,20}pref|email.{0,20}pref|update.{0,20}pref|manage.{0,20}subscri|remove.{0,20}list/i;
const UNSUBSCRIBE_URL  = /unsubscri|optout|opt-out|preferences|manage-subscri/i;

// Patterns that identify newsletter archive / "view in browser" links.
const ARCHIVE_PATTERNS = /view.{0,20}(browser|online|web|webpage)|read.{0,20}online|web.{0,20}version|online.{0,20}version|mirror\./i;

// Social media root-domain links (profile homepages, not articles).
const SOCIAL_HOMEPAGE = /^https?:\/\/(www\.)?(twitter|x|linkedin|instagram|facebook|youtube|tiktok)\.com\/?(\?.*)?$/i;

/**
 * Attempt to strip email boilerplate (headers, footers, unsubscribe blocks)
 * using @mozilla/readability. Falls back to the raw HTML if readability
 * cannot parse it (e.g. very short or atypically structured emails).
 */
function stripBoilerplate(html, url = 'https://newsletter.invalid') {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document, { keepClasses: false });
    const article = reader.parse();
    return article?.content || html;
  } catch {
    return html;
  }
}

/**
 * Get a short surrounding snippet for an anchor: the text content of
 * the closest ancestor block element, trimmed to 300 chars.
 */
function getSurroundingSnippet($anchor) {
  const blockTags = new Set(['p', 'li', 'td', 'div', 'blockquote', 'section']);
  let el = $anchor;
  let parent = el.parent();

  while (parent.length) {
    const tag = parent.get(0)?.tagName?.toLowerCase();
    if (blockTags.has(tag)) {
      return parent.text().trim().replace(/\s+/g, ' ').slice(0, 300);
    }
    parent = parent.parent();
  }

  // Fallback: use the anchor's own text.
  return $anchor.text().trim().slice(0, 300);
}

function shouldExclude(anchorText, href) {
  if (!href || href.startsWith('mailto:') || href.startsWith('#')) return true;
  if (UNSUBSCRIBE_TEXT.test(anchorText) || UNSUBSCRIBE_URL.test(href))  return true;
  if (ARCHIVE_PATTERNS.test(anchorText) || ARCHIVE_PATTERNS.test(href)) return true;
  if (SOCIAL_HOMEPAGE.test(href)) return true;
  return false;
}

/**
 * Extract candidate links from a single email.
 *
 * @param {{ messageId, subject, sender, htmlBody }} email
 * @returns {{ source: string, candidates: { anchorText, rawUrl, surroundingSnippet }[] }}
 */
function extractLinks(email) {
  const { sender, subject, htmlBody } = email;
  const source = sender || subject || 'unknown';

  if (!htmlBody) {
    return { source, candidates: [] };
  }

  const cleaned = stripBoilerplate(htmlBody);
  const $ = cheerio.load(cleaned);
  const candidates = [];

  $('a[href]').each((_i, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    const anchorText = $el.text().replace(/\s+/g, ' ').trim();

    // Skip image-only anchors (no meaningful text).
    if (!anchorText && $el.find('img').length > 0) return;
    if (!anchorText) return;

    if (shouldExclude(anchorText, href)) return;

    const surroundingSnippet = getSurroundingSnippet($el);

    candidates.push({ anchorText, rawUrl: href, surroundingSnippet });
  });

  // Deduplicate by rawUrl (keep first occurrence).
  const seen = new Set();
  const unique = candidates.filter(({ rawUrl }) => {
    if (seen.has(rawUrl)) return false;
    seen.add(rawUrl);
    return true;
  });

  return { source, candidates: unique };
}

/**
 * Run extractLinks over an array of emails (output of fetchEmails).
 *
 * @param {object[]} emails
 * @returns {{ source, candidates }[]}
 */
function extractLinksFromEmails(emails) {
  return emails.map(extractLinks);
}

module.exports = { extractLinks, extractLinksFromEmails };

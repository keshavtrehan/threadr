const fs   = require('fs');
const path = require('path');

const FORMAT_PATH = path.join(__dirname, '../../config/format.md');

// ---------------------------------------------------------------------------
// Config loading — read from disk on every call, same pattern as curate.js.
// ---------------------------------------------------------------------------
function loadFormat() {
  return fs.readFileSync(FORMAT_PATH, 'utf-8');
}

// ---------------------------------------------------------------------------
// Category order parser — unchanged from previous version.
// ---------------------------------------------------------------------------
function parseCategoryOrder(formatMd) {
  const categories = [];
  let inSection = false;

  for (const line of formatMd.split('\n')) {
    if (/^#{1,4}\s+.*categor/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,4}\s/.test(line)) break;
    if (inSection) {
      const match = line.match(/^\s*[-*\d.]+\s+(.+)/);
      if (match) categories.push(match[1].trim());
    }
  }

  return categories;
}

// ---------------------------------------------------------------------------
// Date / period helpers
// ---------------------------------------------------------------------------
const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateLabel(date) {
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

function periodLabel(period) {
  return period === 'evening' ? 'Evening' : 'Morning';
}

// ---------------------------------------------------------------------------
// Block Kit builders
// ---------------------------------------------------------------------------

function divider() {
  return { type: 'divider' };
}

function headerBlock(text) {
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}

function sectionMd(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function contextMd(text) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

// ---------------------------------------------------------------------------
// Item renderer
// ---------------------------------------------------------------------------
function itemBlocks(item) {
  // Slack Block Kit hyperlink: *<url|title>* — no link preview cards.
  const link = `*<${item.resolvedUrl}|${item.title}>*`;

  // Synopsis: split on newline, join with newline (Claude may return one or
  // two lines). Trim each line to remove stray whitespace.
  const synopsis = (item.synopsis || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');

  const blocks = [
    sectionMd(link),
    sectionMd(synopsis),
  ];

  // Source context: "Sender · _Subject_"
  if (item.source) {
    blocks.push(contextMd(item.source));
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Section renderer
// ---------------------------------------------------------------------------
function sectionBlocks(name, items) {
  const blocks = [sectionMd(`*${name}*`), divider()];

  items.forEach((item, i) => {
    blocks.push(...itemBlocks(item));
    if (i < items.length - 1) blocks.push(divider());
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a DigestItem array into a Slack Block Kit blocks array.
 *
 * format.md is read fresh from disk on every call. Category sections appear
 * in the order defined in format.md; any categories Claude returned that
 * are not in format.md are appended at the end.
 *
 * @param {{ category, title, resolvedUrl, synopsis, source? }[]} items
 * @param {{ emailsScanned?: number, period?: 'morning' | 'evening' }} meta
 * @returns {{ blocks: object[], fallbackText: string }}
 */
function formatSlack(items, meta = {}) {
  const { emailsScanned = 0, period = 'morning' } = meta;
  const now    = new Date();
  const label  = periodLabel(period);
  const date   = dateLabel(now);
  const title  = `🗞 ${label} Digest — ${date}`;

  const fallbackText = `${label} Digest — ${items.length} article${items.length === 1 ? '' : 's'} curated`;

  if (items.length === 0) {
    return {
      blocks: [
        headerBlock(title),
        contextMd(`_${emailsScanned} emails scanned · nothing worth curating today_`),
      ],
      fallbackText,
    };
  }

  const formatMd      = loadFormat();
  const categoryOrder = parseCategoryOrder(formatMd);

  // Group items by category.
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }

  // Ordered: format.md order first, then any extras Claude returned.
  const ordered = [
    ...categoryOrder.filter(c => groups.has(c)),
    ...[...groups.keys()].filter(c => !categoryOrder.includes(c)),
  ];

  const blocks = [
    headerBlock(title),
    contextMd(`${emailsScanned} emails scanned · ${items.length} articles curated`),
    divider(),
  ];

  ordered.forEach((cat, i) => {
    blocks.push(...sectionBlocks(cat, groups.get(cat)));
    if (i < ordered.length - 1) blocks.push(divider());
  });

  return { blocks, fallbackText };
}

module.exports = { formatSlack };

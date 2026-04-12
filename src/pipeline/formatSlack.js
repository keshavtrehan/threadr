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
// Category order parser.
//
// Looks for the first section heading in format.md that contains the word
// "categor" (case-insensitive), then collects every bullet list item beneath
// it until the next heading. Those bullet items, in order, become the
// canonical category sequence for the digest.
//
// Example format.md excerpt:
//   ## Category structure
//   - AI & Tech
//   - India Markets
//   - Culture & Society
//
// Falls back to an empty array if no such section exists, in which case
// formatSlack uses the order of first appearance in the DigestItems array.
// ---------------------------------------------------------------------------
function parseCategoryOrder(formatMd) {
  const categories = [];
  let inSection = false;

  for (const line of formatMd.split('\n')) {
    if (/^#{1,4}\s+.*categor/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,4}\s/.test(line)) {
      break; // next heading ends the section
    }
    if (inSection) {
      const match = line.match(/^\s*[-*]\s+(.+)/);
      if (match) categories.push(match[1].trim());
    }
  }

  return categories;
}

// ---------------------------------------------------------------------------
// Rendering helpers.
// ---------------------------------------------------------------------------
function periodLabel(period) {
  return period === 'evening' ? 'Evening' : 'Morning';
}

const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateLabel(date) {
  // e.g. "Mon 12 Apr" — manual format avoids locale-dependent commas
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

function renderItem(item) {
  // Bold title as hyperlink: *[Title](resolvedUrl)*
  const link = `*[${item.title}](${item.resolvedUrl})*`;

  // Synopsis may contain a newline between line 1 and line 2.
  // Each line is indented with two spaces.
  const synopsisLines = (item.synopsis || '')
    .split('\n')
    .map(l => `  ${l.trim()}`)
    .join('\n');

  return `• ${link}\n${synopsisLines}`;
}

function renderCategory(name, items) {
  return `*${name}*\n${items.map(renderItem).join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Render a DigestItem array into a Slack markdown string.
 *
 * format.md is read fresh from disk on every call. Category sections appear
 * in the order defined in format.md; any categories Claude returned that
 * are not listed in format.md are appended at the end.
 *
 * @param {{ category, title, resolvedUrl, synopsis }[]} items
 *   Output of curate().
 * @param {{ emailsScanned?: number, period?: 'morning' | 'evening' }} meta
 * @returns {string}
 */
function formatSlack(items, meta = {}) {
  if (items.length === 0) return '';

  const { emailsScanned = 0, period = 'morning' } = meta;
  const formatMd      = loadFormat();
  const categoryOrder = parseCategoryOrder(formatMd);

  // Group items by category, preserving insertion order within each group.
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }

  // Ordered category names: format.md order first (skip empties),
  // then any categories Claude returned that were not in format.md.
  const ordered = [
    ...categoryOrder.filter(c => groups.has(c)),
    ...[...groups.keys()].filter(c => !categoryOrder.includes(c)),
  ];

  const header    = `*🗞 ${periodLabel(period)} Digest — ${dateLabel(new Date())}*`;
  const subheader = `_${emailsScanned} emails scanned · ${items.length} articles curated_`;
  const sections  = ordered.map(c => renderCategory(c, groups.get(c)));

  return [header, subheader, ...sections].join('\n\n');
}

module.exports = { formatSlack };

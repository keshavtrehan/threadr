// ---------------------------------------------------------------------------
// Date / period helpers
// ---------------------------------------------------------------------------
const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateLabel(date) {
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

function digestTitle(period) {
  const date = dateLabel(new Date());
  return period === 'evening'
    ? `🗞 Evening Dispatch — ${date}`
    : `🗞 Morning Digest — ${date}`;
}

// ---------------------------------------------------------------------------
// Block Kit primitives
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
// Item renderer — flat numbered list, no category grouping
// ---------------------------------------------------------------------------
function itemBlocks(item, n) {
  // "*1.* 🤖  *<url|title>*"
  const link = `*${n}.* ${item.emoji}  *<${item.resolvedUrl}|${item.title}>*`;

  // "senderName · _emailSubject_"
  const source = `${item.senderName} · _${item.emailSubject}_`;

  // Synopsis: trim each line, filter blanks, rejoin with newline.
  const synopsis = (item.synopsis || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');

  return [
    sectionMd(link),
    contextMd(source),
    sectionMd(synopsis),
    divider(),
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a DigestItem array into a Slack Block Kit payload.
 *
 * Flat numbered list in the order Claude returned items — no category
 * grouping, no format.md parsing needed.
 *
 * @param {{ title, resolvedUrl, synopsis, emoji, senderName, emailSubject }[]} items
 * @param {{ emailsScanned?: number, period?: 'morning' | 'evening' }} meta
 * @returns {{ blocks: object[], fallbackText: string }}
 */
function formatSlack(items, meta = {}) {
  const { emailsScanned = 0, period = 'morning' } = meta;
  const title       = digestTitle(period);
  const label       = period === 'evening' ? 'Evening Dispatch' : 'Morning Digest';
  const fallbackText = `${label} — ${items.length} article${items.length === 1 ? '' : 's'} curated`;

  if (items.length === 0) {
    return {
      blocks: [
        headerBlock(title),
        contextMd(`_${emailsScanned} emails scanned · nothing worth curating today_`),
      ],
      fallbackText,
    };
  }

  const blocks = [
    headerBlock(title),
    contextMd(`_${emailsScanned} emails scanned · ${items.length} articles curated_`),
    divider(),
  ];

  items.forEach((item, i) => {
    blocks.push(...itemBlocks(item, i + 1));
  });

  return { blocks, fallbackText };
}

module.exports = { formatSlack };

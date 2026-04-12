const { getGmailClient } = require('../lib/gmail');

const MAX_EMAILS = 60;
const WINDOW_MS  = 12 * 60 * 60 * 1000; // 12 hours in milliseconds

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

function decodeBody(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// Walk a MIME part tree and return the first text/html body found.
function extractHtmlBody(payload) {
  if (!payload) return '';

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const html = extractHtmlBody(part);
      if (html) return html;
    }
  }

  return '';
}

function getHeader(headers, name) {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch emails from the inbox for the current digest run.
 *
 * Primary window:  emails with internalDate >= now - 12h.
 * Soft window:     emails outside 12h that are not in processedIds are also
 *                  included — the wider Gmail query (24h) provides a natural
 *                  buffer that catches delayed-delivery stragglers without
 *                  any additional mechanism.
 *
 * Idempotency is handled entirely by processedIds (sourced from the
 * processed_emails Supabase table by the caller). No Gmail labels are read
 * or applied.
 *
 * @param {string[]} processedIds  Message IDs already recorded in Supabase.
 * @returns {Promise<{ messageId, subject, sender, receivedAt, htmlBody, withinWindow }[]>}
 */
async function fetchEmails(processedIds = []) {
  const gmail      = await getGmailClient();
  const processed  = new Set(processedIds);
  const now        = Date.now();
  const windowStart = now - WINDOW_MS;

  // Query the inbox over a 24h window — wider than the 12h primary window
  // so that slightly delayed emails (stragglers) are naturally captured.
  // Code-side internalDate filtering classifies each email precisely.
  const listRes = await gmail.users.messages.list({
    userId:     'me',
    q:          'in:inbox newer_than:1d',
    maxResults: MAX_EMAILS,
  });

  const messages = listRes.data.messages || [];

  if (messages.length === MAX_EMAILS) {
    console.warn(`[fetchEmails] Cap of ${MAX_EMAILS} emails hit — some may be deferred to the next run.`);
  }

  if (messages.length === 0) {
    console.log('[fetchEmails] No emails found in the inbox for the last 24h.');
    return [];
  }

  // Fetch full message data for each ID in parallel, skipping already-processed.
  const settled = await Promise.all(
    messages.map(async ({ id }) => {
      if (processed.has(id)) return null;

      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      });

      const msg      = msgRes.data;
      const headers  = msg.payload?.headers || [];
      const ts       = Number(msg.internalDate);
      const receivedAt    = new Date(ts);
      const withinWindow  = ts >= windowStart;

      return {
        messageId:    msg.id,
        subject:      getHeader(headers, 'Subject'),
        sender:       getHeader(headers, 'From'),
        receivedAt,
        htmlBody:     extractHtmlBody(msg.payload),
        withinWindow,
      };
    })
  );

  // Remove nulls (already-processed emails that were skipped).
  const emails = settled.filter(Boolean);

  const inWindow   = emails.filter(e =>  e.withinWindow).length;
  const stragglers = emails.filter(e => !e.withinWindow).length;
  const skipped    = messages.length - emails.length;

  console.log(
    `[fetchEmails] ${emails.length} emails to process ` +
    `(${inWindow} within 12h window, ${stragglers} stragglers, ${skipped} already processed).`
  );

  return emails;
}

module.exports = { fetchEmails };

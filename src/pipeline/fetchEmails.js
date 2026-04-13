const { getGmailClient } = require('../lib/gmail');

// Request up to 100 IDs from Gmail — enough to cover any realistic inbox volume.
const GMAIL_MAX_RESULTS = 100;
const WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

function decodeBody(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

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
 * Fetch all unprocessed emails from the last 24h window.
 *
 * No cap on the number returned — the pipeline no longer fetches article
 * bodies, so the cost of processing more emails is low. Idempotency is
 * handled entirely by processedIds from the processed_emails Supabase table.
 *
 * @param {string[]} processedIds  Message IDs already recorded in Supabase.
 * @returns {Promise<{ messageId, subject, sender, receivedAt, htmlBody, withinWindow }[]>}
 */
async function fetchEmails(processedIds = []) {
  const gmail     = await getGmailClient();
  const processed = new Set(processedIds);
  const now       = Date.now();
  const windowStart = now - WINDOW_MS;

  const listRes = await gmail.users.messages.list({
    userId:     'me',
    q:          'in:inbox newer_than:1d',
    maxResults: GMAIL_MAX_RESULTS,
  });

  const allMessages = listRes.data.messages || [];

  if (allMessages.length === 0) {
    console.log('[fetchEmails] No emails found in the inbox for the last 24h.');
    return [];
  }

  const unprocessed = allMessages.filter(({ id }) => !processed.has(id));
  const skipped     = allMessages.length - unprocessed.length;

  if (unprocessed.length === 0) {
    console.log('[fetchEmails] All inbox emails already processed.');
    return [];
  }

  // Fetch full message data for all unprocessed emails in parallel.
  const emails = await Promise.all(
    unprocessed.map(async ({ id }) => {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      });

      const msg      = msgRes.data;
      const headers  = msg.payload?.headers || [];
      const ts       = Number(msg.internalDate);

      return {
        messageId:    msg.id,
        subject:      getHeader(headers, 'Subject'),
        sender:       getHeader(headers, 'From'),
        receivedAt:   new Date(ts),
        htmlBody:     extractHtmlBody(msg.payload),
        withinWindow: ts >= windowStart,
      };
    })
  );

  const inWindow   = emails.filter(e =>  e.withinWindow).length;
  const stragglers = emails.filter(e => !e.withinWindow).length;

  console.log(
    `[fetchEmails] ${emails.length} emails to process ` +
    `(${inWindow} within 12h window, ${stragglers} stragglers, ${skipped} already processed).`
  );

  return emails;
}

module.exports = { fetchEmails };

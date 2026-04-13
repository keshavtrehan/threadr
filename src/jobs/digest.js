const supabase                  = require('../lib/supabase');
const { fetchEmails }           = require('../pipeline/fetchEmails');
const { extractLinksFromEmails} = require('../pipeline/extractLinks');
const { resolveAllLinks }       = require('../pipeline/resolveLinks');
const { fetchArticles }         = require('../pipeline/fetchArticles');
const { curate }                = require('../pipeline/curate');
const { formatSlack }           = require('../pipeline/formatSlack');
const { postSlack }             = require('../pipeline/postSlack');

// IST = UTC + 5:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectPeriod() {
  const istHour = new Date(Date.now() + IST_OFFSET_MS).getUTCHours();
  return istHour < 12 ? 'morning' : 'evening';
}

// Fetch message IDs already in processed_emails, scoped to the last 7 days
// (well beyond the 24h Gmail query window — avoids a full-table scan).
async function loadProcessedIds() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('processed_emails')
    .select('gmail_message_id')
    .gte('received_at', since);

  if (error) throw new Error(`Supabase read failed (processed_emails): ${error.message}`);
  return (data || []).map(r => r.gmail_message_id);
}

async function writeDigestRun(payload) {
  const { data, error } = await supabase
    .from('digest_runs')
    .insert(payload)
    .select('id')
    .single();

  if (error) throw new Error(`Supabase write failed (digest_runs): ${error.message}`);
  return data.id;
}

async function writeProcessedEmails(runId, emails) {
  if (emails.length === 0) return;

  const rows = emails.map(e => ({
    run_id:           runId,
    gmail_message_id: e.messageId,
    subject:          e.subject,
    sender:           e.sender,
    received_at:      e.receivedAt.toISOString(),
  }));

  const { error } = await supabase
    .from('processed_emails')
    .insert(rows);

  if (error) throw new Error(`Supabase write failed (processed_emails): ${error.message}`);
}

// ---------------------------------------------------------------------------
// Main job
// ---------------------------------------------------------------------------

/**
 * Run a full digest cycle: fetch → extract → resolve → fetch articles →
 * curate → format → post → persist.
 *
 * Never throws — errors are caught, written to digest_runs, and returned
 * as { ok: false, error } so the Express route can respond cleanly.
 *
 * @returns {Promise<{ ok: boolean, itemsCurated?: number, error?: string }>}
 */
async function runDigest() {
  const period = detectPeriod();

  // Accumulate partial counts so the error record is as complete as possible.
  let emails      = [];
  let articles    = [];
  let digestItems = [];

  console.log(`\n[digest] ── Starting ${period} digest run ──`);

  try {
    // ── Step 1: Load processed IDs (idempotency) ──────────────────────────
    console.log('[digest] 1/8  Loading processed message IDs from Supabase...');
    const processedIds = await loadProcessedIds();
    console.log(`[digest]      ${processedIds.length} previously processed IDs loaded.`);

    // ── Step 2: Fetch emails ───────────────────────────────────────────────
    console.log('[digest] 2/8  Fetching emails from Gmail...');
    emails = await fetchEmails(processedIds);

    if (emails.length === 0) {
      console.log('[digest]      No new emails — writing empty run record and exiting.');
      await writeDigestRun({
        period,
        emails_fetched:   0,
        articles_fetched: 0,
        items_curated:    0,
        status:           'success',
        digest_output:    [],
      });
      return { ok: true, itemsCurated: 0 };
    }

    // ── Step 3: Extract links ──────────────────────────────────────────────
    console.log(`[digest] 3/8  Extracting links from ${emails.length} emails...`);
    const extracted      = extractLinksFromEmails(emails);
    const totalCandidates = extracted.reduce((n, e) => n + e.candidates.length, 0);
    console.log(`[digest]      ${totalCandidates} candidate links extracted.`);

    // ── Step 4: Resolve links ──────────────────────────────────────────────
    console.log('[digest] 4/8  Resolving links to canonical URLs...');
    const resolved = await resolveAllLinks(extracted);

    // ── Step 5: Fetch articles ─────────────────────────────────────────────
    console.log('[digest] 5/8  Fetching article content...');
    articles = await fetchArticles(resolved);
    console.log(`[digest]      ${articles.length} articles fetched.`);

    // ── Step 6: Curate with Claude ─────────────────────────────────────────
    console.log('[digest] 6/8  Curating digest with Claude...');
    digestItems = await curate(articles);
    console.log(`[digest]      ${digestItems.length} items selected.`);

    // ── Step 7: Format + post to Slack ────────────────────────────────────
    console.log('[digest] 7/8  Formatting and posting to Slack...');

    let slackText;
    if (digestItems.length === 0) {
      // Claude found nothing worth curating — send a brief notice instead of silence.
      const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const now    = new Date();
      const date   = `${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`;
      const label  = period === 'evening' ? 'Evening' : 'Morning';
      slackText = `*🗞 ${label} Dispatch — ${date}*\n_${emails.length} emails scanned · nothing worth curating today_`;
      console.log('[digest]      0 items curated — sending empty-run notice.');
    } else {
      slackText = formatSlack(digestItems, { emailsScanned: emails.length, period });
    }

    await postSlack(slackText);
    console.log('[digest]      Slack DM sent.');

    // ── Step 8: Persist to Supabase ────────────────────────────────────────
    console.log('[digest] 8/8  Persisting run data to Supabase...');
    const runId = await writeDigestRun({
      period,
      emails_fetched:   emails.length,
      articles_fetched: articles.length,
      items_curated:    digestItems.length,
      status:           'success',
      digest_output:    digestItems,
    });
    await writeProcessedEmails(runId, emails);
    console.log(`[digest]      Run ${runId} recorded. ${emails.length} emails marked as processed.`);

    console.log(`[digest] ── ${period} digest complete — ${digestItems.length} items curated ──\n`);
    return { ok: true, itemsCurated: digestItems.length };

  } catch (err) {
    console.error(`[digest] ✗ Run failed at step — ${err.message}`, err);

    // Best-effort error record — don't let a Supabase failure here propagate.
    try {
      await writeDigestRun({
        period,
        emails_fetched:   emails.length,
        articles_fetched: articles.length,
        items_curated:    digestItems.length,
        status:           'error',
        error_message:    err.message,
        digest_output:    digestItems.length > 0 ? digestItems : null,
      });
    } catch (supabaseErr) {
      console.error('[digest] Failed to write error record to Supabase:', supabaseErr.message);
    }

    return { ok: false, error: err.message };
  }
}

module.exports = { runDigest };

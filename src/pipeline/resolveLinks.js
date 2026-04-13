// got v14 is ESM-only; load it once via dynamic import.
let _got;
async function getGot() {
  if (!_got) {
    const mod = await import('got');
    _got = mod.got;
  }
  return _got;
}

const TIMEOUT_MS    = 2000;
const MAX_REDIRECTS = 10;
const CONCURRENCY   = 10; // simultaneous resolutions across all emails

// Query parameters to strip from resolved URLs (tracking / campaign params).
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'ref', 'mc_cid', 'mc_eid', 'fbclid', 'gclid', 'msclkid', 'twclid',
]);

function stripTrackingParams(urlString) {
  try {
    const url = new URL(urlString);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return urlString;
  }
}

// ---------------------------------------------------------------------------
// Semaphore — caps simultaneous in-flight resolutions across all emails.
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
// Single URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single raw URL to its final canonical destination.
 * Uses HEAD first; falls back to GET if the server rejects HEAD.
 * Strips tracking query params from the final URL.
 *
 * @returns {{ resolvedUrl: string, resolvedSuccessfully: boolean }}
 */
async function resolveUrl(rawUrl, got) {
  const opts = {
    followRedirect:  true,
    maxRedirects:    MAX_REDIRECTS,
    timeout:         { request: TIMEOUT_MS },
    throwHttpErrors: false,
  };

  try {
    const res = await got.head(rawUrl, opts);
    return { resolvedUrl: stripTrackingParams(res.url), resolvedSuccessfully: true };
  } catch {
    try {
      const res = await got.get(rawUrl, opts);
      return { resolvedUrl: stripTrackingParams(res.url), resolvedSuccessfully: true };
    } catch (err) {
      console.warn(`[resolveLinks] Failed to resolve ${rawUrl}: ${err.message}`);
      return { resolvedUrl: rawUrl, resolvedSuccessfully: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve all links across all emails with a global concurrency cap.
 *
 * Input:  [{ senderName, emailSubject, candidates: [{ anchorText, rawUrl, surroundingSnippet }] }]
 * Output: [{ senderName, emailSubject, candidates: [{ anchorText, rawUrl, resolvedUrl, surroundingSnippet, resolvedSuccessfully }] }]
 *
 * @param {{ senderName, emailSubject, candidates }[]} extractedEmails
 * @returns {Promise<{ senderName, emailSubject, candidates }[]>}
 */
async function resolveAllLinks(extractedEmails) {
  const got = await getGot();
  const sem = createSemaphore(CONCURRENCY);

  // Flatten all candidates into tasks, resolve with semaphore, then re-group.
  const tasks = extractedEmails.flatMap((email, emailIdx) =>
    email.candidates.map((candidate, candidateIdx) => ({
      emailIdx,
      candidateIdx,
      candidate,
      senderName:   email.senderName,
      emailSubject: email.emailSubject,
    }))
  );

  const results = await Promise.all(
    tasks.map(task =>
      sem(async () => {
        const { resolvedUrl, resolvedSuccessfully } = await resolveUrl(task.candidate.rawUrl, got);
        return {
          emailIdx:      task.emailIdx,
          candidateIdx:  task.candidateIdx,
          anchorText:    task.candidate.anchorText,
          rawUrl:        task.candidate.rawUrl,
          resolvedUrl,
          surroundingSnippet:   task.candidate.surroundingSnippet,
          resolvedSuccessfully,
        };
      })
    )
  );

  // Re-group results by email, preserving original order.
  const output = extractedEmails.map((email, emailIdx) => ({
    senderName:   email.senderName,
    emailSubject: email.emailSubject,
    candidates:   results
      .filter(r => r.emailIdx === emailIdx)
      .sort((a, b) => a.candidateIdx - b.candidateIdx)
      .map(({ anchorText, rawUrl, resolvedUrl, surroundingSnippet, resolvedSuccessfully }) => ({
        anchorText, rawUrl, resolvedUrl, surroundingSnippet, resolvedSuccessfully,
      })),
  }));

  const totalResolved = results.filter(r => r.resolvedSuccessfully).length;
  const totalFailed   = results.length - totalResolved;
  console.log(
    `[resolveLinks] ${results.length} links resolved — ${totalResolved} succeeded, ${totalFailed} fell back to rawUrl.`
  );

  return output;
}

module.exports = { resolveUrl, resolveAllLinks };

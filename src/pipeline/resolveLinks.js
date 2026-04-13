// got v14 is ESM-only; load it once via dynamic import.
let _got;
async function getGot() {
  if (!_got) {
    const mod = await import('got');
    _got = mod.got;
  }
  return _got;
}

const TIMEOUT_MS = 2000;
const MAX_REDIRECTS = 10;

// Query parameters to strip from resolved URLs (tracking / campaign params).
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'ref', 'mc_cid', 'mc_eid', 'fbclid', 'gclid', 'msclkid', 'twclid',
]);

function stripTrackingParams(urlString) {
  try {
    const url = new URL(urlString);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key)) {
        url.searchParams.delete(key);
      }
    }
    // Remove trailing `?` if all params were stripped.
    return url.toString();
  } catch {
    return urlString;
  }
}

/**
 * Resolve a single raw URL to its final canonical destination.
 * Uses a HEAD request first; falls back to GET if the server rejects HEAD.
 * Strips tracking query params from the final URL.
 *
 * @returns {{ resolvedUrl: string, resolvedSuccessfully: boolean }}
 */
async function resolveUrl(rawUrl) {
  const got = await getGot();
  const opts = {
    followRedirect: true,
    maxRedirects: MAX_REDIRECTS,
    timeout: { request: TIMEOUT_MS },
    throwHttpErrors: false, // capture final URL even on 4xx/5xx
  };

  try {
    const res = await got.head(rawUrl, opts);
    const finalUrl = stripTrackingParams(res.url);
    return { resolvedUrl: finalUrl, resolvedSuccessfully: true };
  } catch (headErr) {
    // Some servers return 405 Method Not Allowed for HEAD — retry with GET.
    try {
      const res = await got.get(rawUrl, { ...opts, timeout: { request: TIMEOUT_MS } });
      const finalUrl = stripTrackingParams(res.url);
      return { resolvedUrl: finalUrl, resolvedSuccessfully: true };
    } catch (getErr) {
      console.warn(`[resolveLinks] Failed to resolve ${rawUrl}: ${getErr.message}`);
      return { resolvedUrl: rawUrl, resolvedSuccessfully: false };
    }
  }
}

/**
 * Resolve all candidate links in a single email's extraction result.
 * Runs resolutions in parallel.
 *
 * Input:  { source, candidates: [{ anchorText, rawUrl, surroundingSnippet }] }
 * Output: { source, candidates: [{ anchorText, rawUrl, resolvedUrl, surroundingSnippet, resolvedSuccessfully }] }
 */
async function resolveEmailLinks({ source, candidates }) {
  const resolved = await Promise.all(
    candidates.map(async (candidate) => {
      const { resolvedUrl, resolvedSuccessfully } = await resolveUrl(candidate.rawUrl);
      return {
        anchorText: candidate.anchorText,
        rawUrl: candidate.rawUrl,        // preserved for debugging
        resolvedUrl,                      // canonical destination
        surroundingSnippet: candidate.surroundingSnippet,
        resolvedSuccessfully,
      };
    })
  );

  const failed = resolved.filter(c => !c.resolvedSuccessfully).length;
  if (failed > 0) {
    console.warn(`[resolveLinks] ${source}: ${failed}/${resolved.length} links failed to resolve.`);
  }

  return { source, candidates: resolved };
}

/**
 * Resolve all links across all emails (output of extractLinksFromEmails).
 *
 * @param {{ source, candidates }[]} extractedEmails
 * @returns {Promise<{ source, candidates }[]>}
 */
async function resolveAllLinks(extractedEmails) {
  // Resolve each email's links concurrently.
  return Promise.all(extractedEmails.map(resolveEmailLinks));
}

module.exports = { resolveUrl, resolveEmailLinks, resolveAllLinks };

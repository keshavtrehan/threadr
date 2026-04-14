const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-5';

const PREFERENCES_PATH = path.join(__dirname, '../../config/preferences.md');
const FORMAT_PATH      = path.join(__dirname, '../../config/format.md');

const REQUIRED_FIELDS = ['title', 'resolvedUrl', 'synopsis', 'emoji', 'senderName', 'emailSubject'];

// ---------------------------------------------------------------------------
// Config loading — read from disk on every call, never cached.
// ---------------------------------------------------------------------------
function loadConfigFiles() {
  const preferences = fs.readFileSync(PREFERENCES_PATH, 'utf-8');
  const format      = fs.readFileSync(FORMAT_PATH, 'utf-8');
  return { preferences, format };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------
function stripFences(text) {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end   = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function parseDigestItems(raw) {
  const stripped  = stripFences(raw.trim());
  const jsonSlice = extractJsonArray(stripped);

  if (!jsonSlice) {
    throw new Error(`[curate] No JSON array found in Claude response.\n\nRaw response:\n${stripped}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    throw new Error(`[curate] Claude response is not valid JSON: ${err.message}\n\nExtracted slice:\n${jsonSlice}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`[curate] Claude response parsed but is not an array. Got: ${typeof parsed}`);
  }

  const invalid = parsed.filter(
    item => REQUIRED_FIELDS.some(f => !item[f] || typeof item[f] !== 'string')
  );
  if (invalid.length > 0) {
    throw new Error(
      `[curate] ${invalid.length} DigestItem(s) missing required fields: ` +
      JSON.stringify(invalid)
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
function buildSystemPrompt(preferences, format) {
  return `\
You are a newsletter curation assistant. Your task is to select and curate 8–12 of the most valuable articles from newsletter links found in the user's inbox.

## Curation preferences

${preferences}

## Output format

${format}

---

Return a valid JSON array of DigestItem objects. Each object must have exactly these fields:
  "title"        — string: the article title (use anchorText if no better title is available)
  "resolvedUrl"  — string: copied character-for-character from the candidate's resolvedUrl field. Do not modify, reconstruct, shorten, or infer URLs. Use the exact value provided.
  "synopsis"     — string: two-line synopsis as defined in Output format, lines separated by \n
  "emoji"        — string: single emoji representing the article topic, chosen from the guide in Output format
  "senderName"   — string: copied from the candidate's senderName
  "emailSubject" — string: copied from the candidate's emailSubject

Rules:
- Return ONLY the raw JSON array. No markdown fences. No explanation. No preamble. No trailing text.
- The first character of your response must be \`[\` and the last must be \`]\`.
- If fewer than 8 strong candidates exist, return what is available — do not pad with weak content.
- Every resolvedUrl must be taken verbatim from the input. Never construct or guess a URL.`;
}

function buildUserPrompt(resolvedEmails) {
  // Shape passed to Claude: candidates grouped by email, metadata-only.
  const input = resolvedEmails
    .filter(e => e.candidates.length > 0)
    .map(e => ({
      senderName:   e.senderName,
      emailSubject: e.emailSubject,
      candidates:   e.candidates.map(c => ({
        anchorText:        c.anchorText,
        surroundingSnippet: c.surroundingSnippet,
        resolvedUrl:       c.resolvedUrl,
      })),
    }));

  return `Here are the newsletter candidates from today's inbox, grouped by email. Select and curate the best 8–12.\n\n${JSON.stringify(input, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Candidate trimmer
// ---------------------------------------------------------------------------
const MAX_CANDIDATES = 80;

/**
 * Trim resolvedEmails to at most MAX_CANDIDATES total candidates.
 *
 * Strategy: rank all candidates across all emails by surroundingSnippet
 * length descending (longer = more context = better signal), take the top
 * MAX_CANDIDATES, then rebuild the grouped structure preserving email metadata.
 * Emails whose candidates were all trimmed are dropped entirely.
 */
function trimCandidates(resolvedEmails) {
  // Flatten with email index so we can re-group later.
  const flat = resolvedEmails.flatMap((email, emailIdx) =>
    email.candidates.map(candidate => ({ emailIdx, candidate }))
  );

  if (flat.length <= MAX_CANDIDATES) return resolvedEmails;

  // Sort by snippet length descending, take top MAX_CANDIDATES.
  const trimmed = flat
    .sort((a, b) =>
      (b.candidate.surroundingSnippet || '').length -
      (a.candidate.surroundingSnippet || '').length
    )
    .slice(0, MAX_CANDIDATES);

  // Re-group by email, preserving senderName / emailSubject.
  const byEmail = new Map();
  for (const { emailIdx, candidate } of trimmed) {
    if (!byEmail.has(emailIdx)) byEmail.set(emailIdx, []);
    byEmail.get(emailIdx).push(candidate);
  }

  return [...byEmail.entries()].map(([emailIdx, candidates]) => ({
    senderName:   resolvedEmails[emailIdx].senderName,
    emailSubject: resolvedEmails[emailIdx].emailSubject,
    candidates,
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Curate a digest from resolved email links using Claude.
 *
 * Input is the output of resolveAllLinks — candidates grouped by email,
 * each carrying senderName, emailSubject, anchorText, surroundingSnippet,
 * and resolvedUrl. No article bodies are fetched or passed.
 *
 * @param {{ senderName, emailSubject, candidates }[]} resolvedEmails
 * @returns {Promise<{ category, title, resolvedUrl, synopsis }[]>}
 */
async function curate(resolvedEmails) {
  const totalCandidates = resolvedEmails.reduce((n, e) => n + e.candidates.length, 0);

  if (totalCandidates === 0) {
    console.warn('[curate] No candidates to curate — returning empty digest.');
    return [];
  }

  // Trim to MAX_CANDIDATES before sending to Claude.
  const trimmedEmails   = trimCandidates(resolvedEmails);
  const trimmedCount    = trimmedEmails.reduce((n, e) => n + e.candidates.length, 0);
  if (trimmedCount < totalCandidates) {
    console.log(`[curate] Trimmed to ${trimmedCount} candidates from ${totalCandidates} total before sending.`);
  }

  const { preferences, format } = loadConfigFiles();
  const client = new Anthropic();

  console.log(`[curate] Sending ${trimmedCount} candidates from ${trimmedEmails.length} emails to Claude (${MODEL}).`);

  const userPrompt = buildUserPrompt(trimmedEmails);

  const message = await client.messages.create({
    model:      MODEL,
    max_tokens: 8000,
    system:     buildSystemPrompt(preferences, format),
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  const items = parseDigestItems(raw);

  console.log(`[curate] Received ${items.length} DigestItems from Claude.`);

  return items;
}

module.exports = { curate };

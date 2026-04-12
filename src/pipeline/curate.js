const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001';

// Paths resolved relative to this file so they work regardless of cwd.
const PREFERENCES_PATH = path.join(__dirname, '../../config/preferences.md');
const FORMAT_PATH      = path.join(__dirname, '../../config/format.md');

// Required fields on every DigestItem.
const REQUIRED_FIELDS = ['category', 'title', 'resolvedUrl', 'synopsis'];

// ---------------------------------------------------------------------------
// Config loading — read from disk on every call, never cached.
// ---------------------------------------------------------------------------
function loadConfigFiles() {
  const preferences = fs.readFileSync(PREFERENCES_PATH, 'utf-8');
  const format      = fs.readFileSync(FORMAT_PATH, 'utf-8');
  return { preferences, format };
}

// ---------------------------------------------------------------------------
// Response parsing and validation.
// ---------------------------------------------------------------------------

// Strip markdown fences if Claude adds them despite instructions.
function stripFences(text) {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function parseDigestItems(raw) {
  const text = stripFences(raw.trim());

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`[curate] Claude response is not valid JSON: ${err.message}\n\nRaw response:\n${text}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`[curate] Claude response parsed but is not an array. Got: ${typeof parsed}`);
  }

  // Validate each item has all required fields and that resolvedUrl is unchanged.
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
// System prompt builder.
// ---------------------------------------------------------------------------
function buildSystemPrompt(preferences, format) {
  return `\
You are a newsletter curation assistant. Your task is to select and curate 7–10 of the most valuable articles from a set of newsletter content fetched from the user's inbox.

## Curation preferences

${preferences}

## Output format

${format}

---

Return a valid JSON array of DigestItem objects. Each object must have exactly these fields:
  "category"    — string: the category this article belongs to (defined in Output format above)
  "title"       — string: the article title
  "resolvedUrl" — string: copied character-for-character from the input article's resolvedUrl field. Do not modify, reconstruct, shorten, or infer URLs. Use the exact value provided.
  "synopsis"    — string: the two-line synopsis as defined in Output format

Rules:
- Return ONLY the raw JSON array. No markdown fences. No explanation. No preamble. No trailing text.
- The first character of your response must be \`[\` and the last must be \`]\`.
- If fewer than 7 strong articles exist, return what is available — do not pad with weak content.
- Every resolvedUrl must be taken verbatim from the input. Never construct or guess a URL.`;
}

// ---------------------------------------------------------------------------
// User prompt builder.
// ---------------------------------------------------------------------------
function buildUserPrompt(articles) {
  return `Here are the articles fetched from today's newsletters. Select and curate the best 7–10.\n\n${JSON.stringify(articles, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Curate a digest from fetched articles using Claude Haiku.
 *
 * Config files are read fresh from disk on every call — edits to
 * preferences.md or format.md take effect on the next run without
 * requiring a redeploy.
 *
 * @param {{ title, resolvedUrl, body, source, fallbackUsed }[]} articles
 *   Output of fetchArticles.
 * @returns {Promise<{ category, title, resolvedUrl, synopsis }[]>}
 */
async function curate(articles) {
  if (articles.length === 0) {
    console.warn('[curate] No articles to curate — returning empty digest.');
    return [];
  }

  const { preferences, format } = loadConfigFiles();
  const client = new Anthropic();

  console.log(`[curate] Sending ${articles.length} articles to Claude (${MODEL}).`);

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: buildSystemPrompt(preferences, format),
    messages: [
      { role: 'user', content: buildUserPrompt(articles) },
    ],
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

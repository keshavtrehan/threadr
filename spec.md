# Threadr — Technical Specification
**Version:** 1.1  
**Date:** April 2026  
**Author:** Gravity Zero Labs

---

## 1. Overview

Threadr is a personal newsletter intelligence service. It runs twice daily, ingests every newsletter that arrived in a labelled Gmail inbox over the previous 12 hours, fetches the actual article content behind each link, and uses Claude (Haiku 4.5) to curate a tight digest of 7–10 articles — formatted and delivered as a Slack DM from a dedicated bot.

The service is designed to make you well-read without requiring you to read everything. The curation layer is personalised through two config files that live in the repo, are read on every single job run, and can be edited at any time without redeploying.

| | |
|---|---|
| **Project name** | Threadr |
| **Repo** | `threadr` |
| **Infrastructure** | Railway (service + cron) |
| **Runtime** | Node.js / Express |
| **Database** | Supabase (Postgres) |
| **AI model** | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) |
| **Delivery** | Slack DM via Bolt SDK (dedicated bot app) |
| **Config** | Two `.md` files in `/config`, read from disk on every run |

---

## 2. Architecture

### 2.1 High-level flow

1. Railway cron fires at **8:00 AM IST** and **8:00 PM IST**
2. Cron calls `POST /jobs/digest` with a shared `CRON_SECRET` header
3. Job reads `preferences.md` and `format.md` from `/config`
4. Gmail API fetches all emails matching the newsletter label that have not yet received the `digest/processed` label
5. **Soft 12h window:** emails from the last 12h are the primary target; any unprocessed older emails are also included
6. For each email: `cheerio` + `readability` strips HTML boilerplate and extracts candidate links with title and snippet
7. All extracted links are resolved to their final canonical URLs — tracking redirects, Substack link wrappers, Mailchimp redirects, and similar are fully unwound before anything is fetched or stored
8. Top 3–5 resolved links per email are fetched as full article pages; body truncated to ~1,200 tokens each
9. All article texts + both config files passed to Claude in a single prompt per run
10. Claude returns a JSON array of 7–10 curated `DigestItem` objects, each carrying the resolved canonical URL
11. Digest is formatted per `format.md` rules and posted to Slack as a DM
12. Processed emails are labelled `digest/processed` in Gmail (idempotency)
13. Run metadata and digest output persisted to Supabase

### 2.2 Project structure

```
threadr/
├── src/
│   ├── auth/
│   │   └── gmail.js            # OAuth2 bootstrap route + inline token refresh helper
│   ├── jobs/
│   │   └── digest.js           # Main job — orchestrates the full pipeline
│   ├── pipeline/
│   │   ├── fetchEmails.js      # Gmail API: label filter + soft 12h window
│   │   ├── extractLinks.js     # cheerio + readability → {title, url, snippet}[]
│   │   ├── resolveLinks.js     # Follow all redirects → canonical URL per link
│   │   ├── fetchArticles.js    # got + readability → full article text + fallback
│   │   ├── curate.js           # Anthropic SDK → DigestItem[]
│   │   ├── formatSlack.js      # DigestItem[] → Slack markdown string
│   │   └── postSlack.js        # Bolt SDK → DM to SLACK_USER_ID
│   └── lib/
│       ├── supabase.js         # Supabase client
│       ├── gmail.js            # Gmail API client with inline token refresh
│       └── slack.js            # Slack Bolt app initialisation
├── config/
│   ├── preferences.md           # Indexing logic, reading priorities, selection criteria
│   └── format.md               # Slack message structure, categories, synopsis rules
├── scripts/
│   └── triggerDigest.js        # Called by Railway cron — POSTs to /jobs/digest
├── index.js                    # Express app entry point, route registration
└── railway.toml                # Cron schedule config
```

---

## 3. Config files

Both files live in `/config`, are committed to the repo, and are **read from disk on every single job run**. Any edit you push deploys immediately — no service restart or redeploy required.

Both are injected into the Claude prompt as distinct labelled sections.

### 3.1 `preferences.md`

This file tells Claude **how to think about the content it is reading**. It is the curation brain of Threadr. It covers three things:

**Indexing logic — how to read the incoming articles**
- What signals indicate an article is worth including (depth, originality, timeliness, relevance to your work)
- What signals indicate it should be skipped (opinion without substance, rehashed press releases, low-signal aggregation pieces)
- How to treat different content types: analysis vs news vs essay vs product announcement

**Reading priorities — what subjects matter**
- Ranked list of topics you want to be knowledgeable about
- Which sources or publications carry more weight
- Which sources to treat with scepticism or down-weight

**Selection criteria — how to choose between pieces**
- When there are 40 candidates and only 10 slots, how should Claude decide
- Rules for diversity: no more than N articles from the same source, coverage across categories
- What "important" means in this context — not just popular, but worth your specific attention
- How to handle slow days (include anyway) vs days with too much good content (be more selective)

> `preferences.md` is the primary file you will edit as your interests evolve. The more specific it is, the better the curation.

### 3.2 `format.md`

This file tells Claude **exactly how the Slack message should look**. It is the output contract. Claude must follow it precisely on every run.

It should define:

**General introduction block**
- What the header line looks like: date, Morning/Evening label, counts
- Whether there is a one-line intro sentence below the header
- Tone of the intro (neutral, concise — not chatty)

**Category structure**
- The named categories that appear in every digest (e.g. `AI & Tech`, `India Markets`, `Culture & Society`)
- Order of categories
- Whether a category is skipped entirely if there are no items for it, or shown with a placeholder

**Hyperlinks**
- Format: bold title that is also the hyperlink — `*[Title](url)*`
- The URL used must be the final resolved canonical URL — never a tracking redirect or intermediate hop
- No URL shorteners, no raw URLs displayed as text alongside the link

**Synopsis**
- Exactly 2 lines per item
- Line 1: what the article is about — specific, not vague
- Line 2: why you should read it — the angle, the stakes, the insight
- This is a brief, not a summary. It should make you want to click, not replace clicking
- No filler phrases ("In this article...", "The author argues...")

**Spacing and structure**
- One blank line between items within a category
- One blank line + category header between categories
- No trailing punctuation on the header line
- Character limits or line length preferences if any

---

## 4. Gmail authentication

### 4.1 How it works

Threadr uses Google OAuth 2.0 with a long-lived refresh token. The flow works as follows:

- A **refresh token** is a persistent credential that never expires unless revoked or unused for 6+ months. It is stored in Railway as an environment variable.
- An **access token** is a short-lived credential (valid for 1 hour) that the Gmail API actually accepts. It is generated from the refresh token at runtime.
- Before every Gmail API call, Threadr calls `oauth2Client.refreshAccessToken()` to obtain a fresh access token. This happens inline inside `lib/gmail.js` and is transparent to the rest of the pipeline.
- No scheduled token refresh job is needed. The refresh happens on demand, every run.

### 4.2 Bootstrap (one-time setup)

This is done once when the service is first deployed.

1. Ensure `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and the callback URL are set in Railway environment variables
2. Hit `GET /auth/gmail` in the browser — this redirects to the Google OAuth consent screen
3. **Scopes required:**
   - `https://www.googleapis.com/auth/gmail.readonly` — to read emails
   - `https://www.googleapis.com/auth/gmail.modify` — to apply the `digest/processed` label after each run
4. After granting consent, Google redirects to `/auth/gmail/callback` with an authorisation code
5. The callback handler exchanges the code for a refresh token and prints it to the response
6. Copy the refresh token and add it to Railway as `GMAIL_REFRESH_TOKEN`
7. The bootstrap route can be disabled or removed after this step

### 4.3 Google Cloud Console setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project named `threadr`
2. In the left sidebar: **APIs & Services → Library** — search for and enable the **Gmail API**
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Add authorised redirect URI: `https://<your-railway-domain>/auth/gmail/callback`
6. Copy the **Client ID** and **Client Secret** into Railway environment variables

---

## 5. Content pipeline

### 5.1 Gmail fetch (`fetchEmails.js`)

- Query: `label:<GMAIL_NEWSLETTER_LABEL> -label:digest/processed`
- Filter results to emails where `internalDate >= now - 12h` (primary window)
- Also include any emails outside the 12h window that have not been processed (soft window — catches stragglers from delayed delivery)
- Cap at **60 emails per run**; log a warning if the cap is hit
- Output: `{ messageId, subject, sender, receivedAt, htmlBody }[]`

### 5.2 Link extraction (`extractLinks.js`)

- Load raw email HTML through `cheerio`
- Run through `@mozilla/readability` to strip boilerplate (headers, footers, unsubscribe blocks)
- Extract all `<a>` tags: `{ anchorText, rawUrl, surroundingSnippet }`
- Filter out:
  - Unsubscribe and preference-centre links
  - `mailto:` links
  - Image-only anchors (no meaningful anchor text)
  - Links pointing back to the newsletter's own archive or web version
  - Social media profile links (Twitter, LinkedIn, Instagram homepages)
- Output per email: `{ source, candidates: [{anchorText, rawUrl, surroundingSnippet}] }`

### 5.3 Link resolution (`resolveLinks.js`)

This is a dedicated step that runs after extraction and before fetching. Its job is to ensure every URL passed downstream is the **final canonical destination** — not an intermediate tracking hop.

**Why this matters:** Newsletter links are almost always wrapped. Substack wraps links through `substack.com/redirect`. Mailchimp uses `clicks.mailchimp.com`. ConvertKit, Beehiiv, and others do the same. If these raw URLs are stored or shown in the digest, they break when the tracking infrastructure expires and they expose no information about where they actually lead.

**How it works:**
- For each candidate URL, make a `HEAD` request (with `got`) following all redirects
- `got` is configured with `followRedirect: true` and `maxRedirects: 10`
- Capture the final URL after the redirect chain settles
- Timeout: **5 seconds** per resolution attempt
- If resolution fails (timeout, DNS error, 4xx/5xx on the final hop), fall back to the raw URL and flag it as `resolvedSuccessfully: false`
- Strip UTM parameters and other tracking query strings from the final URL (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `ref`, `mc_cid`, etc.)

**Output per link:** `{ anchorText, resolvedUrl, surroundingSnippet, resolvedSuccessfully }`

> All downstream steps — article fetching, Claude curation, and Slack formatting — use `resolvedUrl` exclusively. The raw tracking URL is never surfaced in the digest.

### 5.4 Article fetch (`fetchArticles.js`)

- For each email, take top 3–5 candidate links ranked by snippet substance (length + keyword density heuristic)
- Fetch each `resolvedUrl` with `got`; pipe response through `@mozilla/readability` to extract clean article body
- Timeout: **8 seconds** per fetch; max **2 retries**
- Truncate article body to **~1,200 tokens** before passing to Claude

**Fallback hierarchy when fetch fails or page is paywalled/blocked:**

| Priority | Source |
|---|---|
| 1 | Full article body (readability success) |
| 2 | Open Graph `og:description` meta tag from the page |
| 3 | Email snippet (always available as last resort) |

- Output per article: `{ title, resolvedUrl, body, source, fallbackUsed: boolean }`

### 5.5 Claude curation (`curate.js`)

- Single Anthropic API call per digest run
- **Model:** `claude-haiku-4-5-20251001`
- **System prompt:** contents of `preferences.md` and `format.md` injected as distinct labelled sections
- **User prompt:** all fetched article objects serialised as JSON, each carrying `resolvedUrl`
- Claude instructed to return **valid JSON only** — array of `DigestItem` objects
- `DigestItem` schema: `{ category, title, resolvedUrl, synopsis }`
- Claude must use `resolvedUrl` as the hyperlink in every item — not infer, reconstruct, or modify URLs
- Target: 7–10 items; send whatever is available on slow days (even 2–3 is fine)
- Estimated cost per run: **~$0.037** → ~$2.20/month at 2 runs/day

> **Prompt caching opportunity:** `preferences.md` and `format.md` are static within a day — ideal candidates for Anthropic prompt caching (`cache_control`), which reduces cache-hit input tokens to 10% of base price. Enable in a later iteration once the pipeline is stable.

### 5.6 Slack formatting (`formatSlack.js`)

Translates the `DigestItem[]` array into a Slack message string, following the rules defined in `format.md` exactly. This module does not make judgement calls — it is a pure renderer.

Example output structure (actual formatting governed by `format.md`):

```
*🗞  Morning Digest — Mon 12 Apr*
_42 emails scanned · 9 articles curated_

*AI & Tech*
• *[Article title](https://canonical-url.com/article)*
  What this article is about. Why you should read it.

*India Markets*
• *[Article title](https://canonical-url.com/article)*
  ...

*Culture & Society*
• ...
```

All hyperlinks in the output use `resolvedUrl` from the `DigestItem`. No tracking URLs, no redirects, no raw URLs displayed as plain text.

---

## 6. Slack app setup

Threadr uses a **dedicated Slack bot app** — not your personal token. The bot sends you DMs. You never appear as the sender.

### Step 1 — Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**
3. Name the app `Threadr`; select your workspace
4. Click **Create App**

### Step 2 — Configure bot permissions

1. In the left sidebar, go to **OAuth & Permissions**
2. Scroll to **Scopes → Bot Token Scopes**
3. Add the following scopes:
   - `chat:write` — to send messages
   - `im:write` — to open DM channels with users
   - `users:read` — to resolve your user ID if needed
4. Scroll up and click **Install to Workspace**
5. Authorise the app — you will be redirected back
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`) — this is `SLACK_BOT_TOKEN`

> Threadr does not need Event Subscriptions, Slash Commands, or Socket Mode. It is outbound-only — it sends DMs and does nothing else.

### Step 3 — Get your Slack user ID

1. In Slack, click your profile picture or name in the top-left corner
2. Click **Profile**
3. Click the three-dot menu (⋯) → **Copy member ID**
4. This is `SLACK_USER_ID` — the bot will open a DM to this ID and post into it

### Step 4 — Add to Railway environment

In your Railway service → **Variables**, add:

```
SLACK_BOT_TOKEN   = xoxb-...
SLACK_USER_ID     = U...
```

### Step 5 — Test the connection

Once the service is running, hit `POST /test/slack`. This sends a test DM:

> *Threadr is connected. Digests will arrive at 8:00 AM and 8:00 PM IST.*

If you receive the DM, the Slack integration is working correctly.

---

## 7. Supabase schema

Two tables. Lightweight enough to debug a bad digest or replay a run.

### `digest_runs`

```sql
create table digest_runs (
  id                uuid primary key default gen_random_uuid(),
  run_at            timestamptz not null default now(),
  period            text,         -- 'morning' | 'evening'
  emails_fetched    int,
  articles_fetched  int,
  items_curated     int,
  status            text,         -- 'success' | 'error'
  error_message     text,
  digest_output     jsonb         -- full DigestItem[] array
);
```

### `processed_emails`

```sql
create table processed_emails (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid references digest_runs(id),
  gmail_message_id  text unique not null,
  subject           text,
  sender            text,
  received_at       timestamptz
);
```

---

## 8. Environment variables

| Variable | Description |
|---|---|
| `GMAIL_CLIENT_ID` | Google OAuth client ID |
| `GMAIL_CLIENT_SECRET` | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Long-lived refresh token (set after one-time bootstrap) |
| `GMAIL_NEWSLETTER_LABEL` | Gmail label name, e.g. `newsletters` |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_USER_ID` | Your Slack member ID for DM delivery |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `CRON_SECRET` | Shared secret to authenticate cron POST calls |
| `PORT` | Express port (Railway sets this automatically) |

---

## 9. Railway cron schedule

Two cron jobs in `railway.toml`. Both call the same endpoint.

```toml
[[cron.jobs]]
schedule = "30 2 * * *"    # 8:00 AM IST (UTC+5:30 = 02:30 UTC)
command  = "node scripts/triggerDigest.js"

[[cron.jobs]]
schedule = "30 14 * * *"   # 8:00 PM IST
command  = "node scripts/triggerDigest.js"
```

`triggerDigest.js` calls `POST /jobs/digest` internally with the `CRON_SECRET` header.

A manual trigger is also available for testing outside cron hours:

```
POST /jobs/digest?force=true
```

---

## 10. Cost estimate

Claude Haiku 4.5 pricing: **$1.00 / million input tokens**, **$5.00 / million output tokens**.

| Component | Tokens (est.) | Notes |
|---|---|---|
| System prompt (both config files) | ~2,000 input | Injected once per run |
| 25 emails × 300 tokens (stripped) | ~7,500 input | After cheerio extraction |
| 15 articles × 1,200 tokens each | ~18,000 input | Top 3–5 per email, truncated |
| **Total input per run** | **~27,500** | |
| Output (formatted digest) | ~1,500 output | 8–10 items with synopses |
| **Cost per run** | **~$0.037** | $0.0275 input + $0.0075 output |
| Cost per day (2 runs) | ~$0.074 | |
| **Cost per month** | **~$2.20** | |

On heavy days (40–50 emails), cost may reach ~$0.06/run — still under $4/month. Once prompt caching is enabled for the config files, effective input cost drops by ~60% on cache hits.

---

## 11. NPM dependencies

| Package | Purpose |
|---|---|
| `express` | HTTP server and routing |
| `googleapis` | Gmail API client |
| `@mozilla/readability` | Article and email HTML extraction |
| `cheerio` | HTML parsing and link extraction |
| `got` | HTTP client for article fetching and link resolution |
| `@anthropic-ai/sdk` | Claude API |
| `@slack/bolt` | Slack bot framework |
| `@supabase/supabase-js` | Supabase client |
| `node-cron` | Local cron (dev only; Railway cron used in prod) |
| `dotenv` | Local env var loading |

---

## 12. Future iterations

- **Weekly Sunday digest** — pull from the week's `digest_runs.digest_output` in Supabase rather than re-fetching Gmail; a best-of-week retrospective with no additional API cost
- **Prompt caching** — enable `cache_control` on the config file sections in the Anthropic API call; reduces effective input cost by ~60% for every run after the first daily cache write
- **Config API** — a simple authenticated endpoint to edit `preferences.md` and `format.md` in place, without needing a git commit or redeploy
- **Source scoring** — track which sources produce curated items most often (join on `processed_emails` + `digest_output`) to auto-tune source weights in `preferences.md`
- **Multi-label support** — run separate digest passes for different Gmail labels (e.g. investor updates vs consumer newsletters)
- **Productisation** — multi-user support, onboarding flow, per-user config storage in Supabase rather than flat files

---

*— end of spec —*
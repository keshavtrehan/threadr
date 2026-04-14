# Threadr

A personal newsletter intelligence agent. Runs twice daily, reads your Gmail inbox, and delivers a curated digest of the most important articles to Slack — ranked, annotated, and filtered to your exact interests.

---

## How it works

```
Gmail inbox
    ↓
Fetch all emails from last 12h
    ↓
Pass plain text of each email to Claude
    ↓
Claude reads your preferences.md and curates 8–12 articles
    ↓
Clean numbered digest → Slack DM
```

Every run is logged to Supabase. Processed emails are tracked so nothing gets curated twice. Two config files control everything — no redeployment needed to change curation behaviour or output format.

---

## Stack

- **Runtime** — Node.js / Express on Railway
- **Scheduler** — node-cron (runs inside the Express process)
- **Email** — Gmail API with OAuth2
- **AI** — Anthropic API (`claude-sonnet-4-5`)
- **Delivery** — Slack Block Kit via `@slack/web-api`
- **Database** — Supabase (Postgres)

---

## Environment variables

| Variable | Where to get it |
|---|---|
| `GMAIL_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID |
| `GMAIL_CLIENT_SECRET` | Same as above |
| `GMAIL_REFRESH_TOKEN` | Hit `/auth/gmail` after deploying — see Gmail setup below |
| `GMAIL_EMAIL_ADDRESS` | The Gmail address being scanned |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `SLACK_BOT_TOKEN` | api.slack.com → your app → OAuth & Permissions → Bot User OAuth Token |
| `SLACK_USER_ID` | Slack → your profile → ··· → Copy member ID |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → service_role key |
| `CRON_SECRET` | Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `BASE_URL` | Your Railway service domain, e.g. `https://threadr-production.up.railway.app` |
| `PORT` | Set to `3000` (Railway overrides this automatically) |

---

## Setup

### 1. Supabase

Create a new project and run these two migrations in the SQL Editor:

```sql
create table digest_runs (
  id                uuid primary key default gen_random_uuid(),
  run_at            timestamptz not null default now(),
  period            text,
  emails_fetched    int,
  items_curated     int,
  status            text,
  error_message     text,
  digest_output     jsonb
);

create table processed_emails (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid references digest_runs(id),
  gmail_message_id  text unique not null,
  subject           text,
  sender            text,
  received_at       timestamptz
);
```

### 2. Google Cloud Console

1. Create a new project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Gmail API**
3. Go to **OAuth consent screen** → External → fill in app name and contact email
4. Add the Gmail address you want to scan as a **Test user**
5. Go to **Credentials** → Create OAuth 2.0 Client ID → Web application
6. Add authorised redirect URI: `https://your-railway-domain/auth/gmail/callback`
7. Copy Client ID and Client Secret into your env vars

### 3. Gmail bootstrap (one-time)

After deploying to Railway with your Google credentials set, open this in your browser:

```
https://your-railway-domain/auth/gmail
```

Sign in as the Gmail account you want to scan. Copy the refresh token from the callback page and add it as `GMAIL_REFRESH_TOKEN` in Railway.

> **Note:** If scanning a different Gmail account than the one that owns the Google Cloud project, add that account as a test user in the OAuth consent screen first.

### 4. Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. Name it `Threadr`, select your workspace
3. Go to **OAuth & Permissions** → Bot Token Scopes → add:
   - `chat:write`
   - `im:write`
   - `users:read`
4. Click **Install to Workspace** → copy the Bot User OAuth Token (`xoxb-...`)
5. In Slack, go to your profile → ··· → Copy member ID — this is your `SLACK_USER_ID`

Test the connection after deploying:
```bash
curl -X POST https://your-railway-domain/test/slack
```

You should receive a DM from the Threadr bot.

### 5. Deploy to Railway

1. Push the repo to GitHub
2. New project on Railway → Deploy from GitHub repo
3. Add all environment variables
4. Generate a domain under Settings → Networking
5. The cron schedules (8:00 AM and 8:00 PM IST) start automatically when the service starts

---

## Manual trigger

Force a digest run outside of the cron schedule:

```bash
curl -X POST "https://your-railway-domain/jobs/digest?force=true"
```

Reset processed emails (re-scans full inbox on next run — useful for testing):

```bash
curl -X POST "https://your-railway-domain/jobs/reset-processed" \
  -H "x-cron-secret: YOUR_CRON_SECRET"
```

---

## Customising the digest

Two files in `/config` control everything. Edit them and push — changes take effect on the next run with no redeployment.

### `config/preferences.md`

This is your brief to the agent. It tells Claude who you are, what you care about, and how to choose between articles. The more specific it is, the better the curation.

**Template:**

```markdown
# Curation preferences

## Who I am
[Your professional context, what you work on, how you think about the world.
The agent uses this to understand your perspective, not just your topics.]

## What to select
[How many articles per run. What signals indicate something is worth including.
What signals indicate something should be skipped.]

## Topics I care about (ranked)
1. [Highest priority topic — be specific]
2. [Second priority]
3. [Third priority]
4. [etc.]

## Sources I trust
[Newsletters, publications, or authors whose work should be weighted more heavily]

## What to deprioritise
[Topics, content types, or sources to filter down or skip entirely]

## Selection criteria
[How to choose when there's more good content than slots.
What "important" means in your context.
Any diversity rules — e.g. no more than 2 items from the same source.]

## How I want to read
[Do you want depth or breadth? News or analysis? 
What tone of synopsis works for you?]
```

**Example:**

```markdown
# Curation preferences

## Who I am
I am a founder and technical marketing consultant based in India,
working in B2B SaaS and AI. I am an active investor in Indian financial
markets. I do not check my newsletter inbox daily — this digest is my
primary mechanism for staying current.

## What to select
Select 8-12 articles per run. Prioritise original analysis and ideas
over news aggregation. A thoughtful essay is as valuable as a breaking
story. Prefer pieces with an India-specific angle when available.

## Topics I care about (ranked)
1. AI — models, enterprise adoption, implementation, strategy
2. B2B SaaS — GTM, pricing, product, competitive dynamics
3. Indian markets — equities, macro, RBI, startup funding
4. Global business and finance
5. Internet culture and ideas

## What to deprioritise
- Press releases with no analysis
- Duplicate coverage of the same story
- Crypto unless directly relevant to AI or markets

## Selection criteria
- No more than 2 items from the same sender per digest
- On a heavy day, apply stricter quality filters
- On a slow day, include anything a well-read person would regret missing
```

---

### `config/format.md`

This controls the structure and style of the Slack output. Edit this to change the number of items, synopsis length, emoji usage, or anything about how the digest looks.

**Template:**

```markdown
# Output format

## Response format
Return a valid JSON array only. No preamble, no explanation,
no markdown fences. First character must be [ last must be ].

## DigestItem schema
{
  "title": "Article title",
  "resolvedUrl": "URL from the email — copy exactly, never modify",
  "synopsis": "Line 1: what this is about.\nLine 2: why you should read it.",
  "senderName": "Newsletter or sender name",
  "emailSubject": "Subject line of the email",
  "emoji": "single emoji that best represents the article topic"
}

## Emoji guide
[Map topics to emojis so the agent assigns them consistently.
Example:]
🤖 AI, models, machine learning
📈 Financial markets, investing
🇮🇳 India-specific business or startup news
💼 B2B, SaaS, enterprise software
🌍 Geopolitics, world news
🚀 Startups, funding
🧠 Ideas, essays, opinion

## Digest header format
[Describe how you want the header line to look]

## Item format
[Describe the structure of each item — numbering, spacing, 
what information appears on each line]

## Synopsis rules
[How long, what tone, what to avoid, what to emphasise]

## Constraints
[Any hard rules — max items, URL handling, emoji usage, etc.]
```

---

## Project structure

```
threadr/
├── src/
│   ├── auth/gmail.js          # OAuth2 bootstrap routes
│   ├── jobs/digest.js         # Main pipeline orchestrator
│   ├── pipeline/
│   │   ├── fetchEmails.js     # Gmail API fetch
│   │   ├── curate.js          # Claude curation
│   │   ├── formatSlack.js     # Block Kit renderer
│   │   └── postSlack.js       # Slack delivery
│   └── lib/
│       ├── gmail.js           # Gmail client with token refresh
│       ├── slack.js           # Slack WebClient
│       └── supabase.js        # Supabase client
├── config/
│   ├── preferences.md         # Your curation brief
│   └── format.md              # Digest output format
└── index.js                   # Express app + cron schedules
```

---

## Cost

Running twice daily on `claude-sonnet-4-5`:

| | Est. per run |
|---|---|
| Input (~80 candidates) | ~$0.05 |
| Output (8–12 items) | ~$0.02 |
| **Total per run** | **~$0.07** |
| **Total per month** | **~$4** |

---

## Licence

MIT

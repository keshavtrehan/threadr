require('dotenv').config();
const express = require('express');

const gmailAuthRouter = require('./src/auth/gmail');
const { runDigest }   = require('./src/jobs/digest');
const { postSlack }   = require('./src/pipeline/postSlack');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

// GET /health — used by Railway to confirm the process is alive.
// Must respond quickly and always return 200 so health checks never
// interrupt a long-running background digest job.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// GET /auth/gmail           — redirects to Google OAuth consent screen
// GET /auth/gmail/callback  — exchanges code for refresh token, displays it
app.use(gmailAuthRouter);

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

// POST /jobs/digest
// Protected by CRON_SECRET header. Pass ?force=true to bypass (manual runs).
app.post('/jobs/digest', async (req, res) => {
  const isForced = req.query.force === 'true';
  const secret   = req.headers['x-cron-secret'];

  if (!isForced && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorised — invalid or missing x-cron-secret header.' });
  }

  // Respond immediately so Railway's cron HTTP timeout isn't a concern.
  // The job runs asynchronously; check Railway logs for outcome.
  res.json({ ok: true, message: `Digest job started (${isForced ? 'forced' : 'scheduled'}).` });

  const result = await runDigest();
  if (!result.ok) {
    console.error('[/jobs/digest] Job finished with error:', result.error);
  }
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

// POST /test/slack — sends a connection confirmation DM.
app.post('/test/slack', async (req, res) => {
  try {
    await postSlack('Threadr is connected. Digests will arrive at 8:00 AM and 8:00 PM IST.');
    res.json({ ok: true });
  } catch (err) {
    console.error('[/test/slack]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Threadr running on port ${PORT}`);
});

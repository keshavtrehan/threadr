const { Router } = require('express');
const { createOAuth2Client } = require('../lib/gmail');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

const router = Router();

// Step 1: redirect to Google OAuth consent screen.
// Hit this once in the browser to kick off the bootstrap flow.
router.get('/auth/gmail', (req, res) => {
  const oauth2Client = createOAuth2Client();

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force refresh_token to be returned even if previously granted
  });

  res.redirect(url);
});

// Step 2: Google redirects here with an authorisation code.
// Exchange it for tokens and display the refresh token to copy into Railway.
router.get('/auth/gmail/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`OAuth error: ${error}`);
  }

  if (!code) {
    return res.status(400).send('Missing authorisation code.');
  }

  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    return res.status(400).send(
      'No refresh token returned. Revoke app access in your Google account and try again.'
    );
  }

  res.send(`
    <h2>Gmail authorisation complete</h2>
    <p>Copy the refresh token below and add it to Railway as <code>GMAIL_REFRESH_TOKEN</code>:</p>
    <pre style="background:#f4f4f4;padding:1rem;word-break:break-all">${tokens.refresh_token}</pre>
    <p>This route can be disabled once the token is saved.</p>
  `);
});

module.exports = router;

const { google } = require('googleapis');

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/gmail/callback`
  );
}

// Returns an authenticated Gmail API client with a fresh access token.
// Call this before every Gmail API operation — token refresh is inline and transparent.
async function getGmailClient() {
  const oauth2Client = createOAuth2Client();

  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  });

  await oauth2Client.refreshAccessToken();

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

module.exports = { createOAuth2Client, getGmailClient };

const { App } = require('@slack/bolt');

// Threadr is outbound-only — no event subscriptions, no socket mode.
// Bolt is initialised here solely to get access to app.client (the Web API).
// signingSecret is required by Bolt's constructor but is never exercised
// because we never start a receiver or validate incoming webhooks.
const app = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET || 'not-used-outbound-only',
});

module.exports = app;

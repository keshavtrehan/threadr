const slackApp = require('../lib/slack');

/**
 * Open a DM channel to SLACK_USER_ID and post a message.
 * Uses the Bolt app's underlying Web API client.
 *
 * @param {string} text  Slack markdown string to send.
 */
async function postSlack(text) {
  const userId = process.env.SLACK_USER_ID;
  if (!userId) throw new Error('[postSlack] SLACK_USER_ID is not set.');

  const client = slackApp.client;

  // Open (or reuse) a DM channel with the target user.
  const openRes = await client.conversations.open({ users: userId });
  const channelId = openRes.channel?.id;

  if (!channelId) {
    throw new Error(`[postSlack] Failed to open DM channel with user ${userId}.`);
  }

  await client.chat.postMessage({
    channel: channelId,
    text,
    // unfurl_links / unfurl_media kept at Slack defaults (true).
    // Disable if digest links generate noisy previews.
  });

  console.log(`[postSlack] Message posted to DM channel ${channelId} (user ${userId}).`);
}

module.exports = { postSlack };

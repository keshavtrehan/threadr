const { WebClient } = require('@slack/web-api');

/**
 * Post a Block Kit message as a DM to SLACK_USER_ID.
 *
 * @param {{ blocks: object[], fallbackText: string }} payload
 *   Output of formatSlack().
 */
async function postSlack({ blocks, fallbackText }) {
  const userId = process.env.SLACK_USER_ID;
  if (!userId) throw new Error('[postSlack] SLACK_USER_ID is not set.');

  const client = new WebClient(process.env.SLACK_BOT_TOKEN);

  await client.chat.postMessage({
    channel:      userId,  // Slack accepts a user ID directly for DMs
    text:         fallbackText,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });

  console.log(`[postSlack] Digest posted to DM (user ${userId}).`);
}

module.exports = { postSlack };

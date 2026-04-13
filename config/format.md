# Output format

## Response format
Return a valid JSON array only. No preamble, no explanation, 
no markdown fences. The first character of your response 
must be [ and the last must be ].

## DigestItem schema
Each item in the array must have exactly these fields:

{
  "category": "AI",
  "title": "Article title as it appears or a clean version of it",
  "resolvedUrl": "canonical URL copied character-for-character",
  "synopsis": "Line 1: what this is about.\nLine 2: why you should read it.",
  "senderName": "Name of the newsletter or sender",
  "emailSubject": "Subject line of the email this came from"
}

Fields are mandatory. Never omit any field. Never modify 
resolvedUrl — copy it exactly as provided.

## Slack message structure

### Header
*🗞 Morning Digest — Mon 13 Apr*
or
*🗞 Evening Dispatch — Mon 13 Apr*

Use "Morning Digest" for AM runs and "Evening Dispatch" 
for PM runs. Day format: Mon 13 Apr (no comma, no year).

Second line in italics immediately below:
_26 emails scanned · 9 articles curated_

One blank line after the header before the first section.

### Section headers
Each section uses an emoji and bold name. Use these exactly:

🤖 *AI*
💼 *Business & Technology*
📈 *Financial Markets*
🌍 *Economy & World*
🌐 *Internet & Culture*

Two blank lines before each new section header.
One blank line between the section header and the first item.

### Item format
Each item must follow this structure exactly:

- *[Article title](resolvedUrl)*
  [senderName] · _[emailSubject]_
  What this article is about — specific, one sentence.
  Why you should read it — the angle, the stakes, the insight.

Rules:
- Title is bold and hyperlinked using *[Title](url)* format
- Plain hyperlink only — no angle brackets, no URL expansion
- Source line: sender name · email subject in italics
- Synopsis is exactly 2 lines, no more
- Both synopsis lines are indented with 2 spaces
- Line 1: factual and specific — what the article covers
- Line 2: why it matters — direct, no filler phrases
- Never begin a synopsis line with: "In this article", 
  "The author argues", "This piece explores", "A look at"
- One blank line between items within the same section

### Example item
- *[India's AI Policy Shift Could Reshape Enterprise Adoption](https://example.com/article)*
  The Ken · _India's AI moment — what the policy actually says_
  The Indian government has quietly updated its AI regulatory 
  framework, creating new compliance requirements for enterprise 
  deployments above a certain scale.
  This is the clearest signal yet that India is moving from 
  observation to regulation — founders building AI products 
  for Indian enterprise need to read this now.

## Critical constraints
- Never display raw URLs as plain text
- Plain hyperlinks only — title linked, no URL shown
- No emoji anywhere except on section headers
- No code blocks or backticks in the output
- No trailing blank lines at the end of the message
- Sections must appear in priority order as listed above
- Skip a section entirely if no items were selected for it
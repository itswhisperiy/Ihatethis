const { Client, WebhookClient } = require('discord.js-selfbot-v13');
require("hjson/lib/require-config");
const config = require("./config.hjson");

const TOKEN = (config.token || "").trim();
const CHANNELS = Array.isArray(config.channels) ? config.channels : [];
const DELAY = Number(config.delayInterval) || 60;
const LIMIT = Number(config.readMessages) || 20;
const MUST = config.messageMustInclude || "";
const ANY = Array.isArray(config.messageAnyIncludes) ? config.messageAnyIncludes.filter(Boolean) : [];

if (!TOKEN || CHANNELS.length === 0) {
  console.error("Missing token or channels in config.hjson");
  process.exit(1);
}

// source → destination map (for edit handler quick lookup)
const sourceToDest = {};
const sourceToPair = {};
for (const pair of CHANNELS) {
  if (pair.source && pair.destination) {
    sourceToDest[pair.source] = pair.destination;
    sourceToPair[pair.source] = pair;
  }
}

const client = new Client({ checkUpdate: false });
const lastMessages = {};
let ready = false;

// Cache for WebhookClient instances
const webhookCache = {};

function getWebhook(url) {
  if (!url) return null;
  if (!webhookCache[url]) {
    webhookCache[url] = new WebhookClient({ url });
  }
  return webhookCache[url];
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  ready = true;
});

// ========== Forward helper ==========
async function forwardMessage(pair, content, embeds, files, label) {
  try {
    const hook = getWebhook(pair.webhookUrl);
    if (hook) {
      await hook.send({ content: content || undefined, embeds, files });
    } else {
      const dest = await client.channels.fetch(pair.destination);
      await dest.send({ content: content || undefined, files });
    }
    console.log(label);
  } catch (err) {
    console.error("Forward failed:", err.message);
  }
}

// ========== NEW messages (polling) ==========
async function checkPair(pair) {
  const sourceId = pair.source;
  if (!sourceId || !pair.destination) return;

  try {
    const channel = await client.channels.fetch(sourceId);
    const messages = await channel.messages.fetch({ limit: LIMIT });
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const last = lastMessages[sourceId] || 0;

    for (const msg of sorted) {
      if (msg.createdTimestamp <= last) continue;
      lastMessages[sourceId] = msg.createdTimestamp;

      if (MUST && !msg.content.includes(MUST)) continue;
      if (ANY.length && !ANY.some(v => msg.content.includes(v))) continue;

      await forwardMessage(
        pair,
        msg.content,
        [...msg.embeds],
        [...msg.attachments.values()],
        `➡️ NEW  ${sourceId} → ${pair.destination}`
      );
    }
  } catch (err) {
    console.error(`Error on ${sourceId}:`, err.message);
  }
}

async function checkAll() {
  if (!ready) return;
  for (const pair of CHANNELS) {
    await checkPair(pair);
  }
}

// ========== EDITED messages ==========
client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!ready) return;
  if (!newMessage.guild) return;
  if (newMessage.author?.bot) return;

  const pair = sourceToPair[newMessage.channelId];
  if (!pair) return;

  // Filters
  if (MUST && !newMessage.content.includes(MUST)) return;
  if (ANY.length && !ANY.some(v => newMessage.content.includes(v))) return;

  // Only if content actually changed
  if (oldMessage.content === newMessage.content) return;

  await forwardMessage(
    pair,
    `📝 **Edited:**\n${newMessage.content || "*empty*"}`,
    [...newMessage.embeds],
    [...newMessage.attachments.values()],
    `✏️ EDIT ${newMessage.channelId} → ${pair.destination}`
  );
});

// Login
client.login(TOKEN).catch(e => {
  console.error("Login failed:", e.message);
  process.exit(1);
});

setInterval(checkAll, DELAY * 1000);

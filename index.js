const fs = require("fs");
const { Client, WebhookClient, MessageActionRow, MessageButton } = require('discord.js-selfbot-v13');
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
let ready = false;

// ========== State persistence ==========
const STATE_PATH = "./state.json";

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const lastMessages = loadState();

// Cache for WebhookClient instances
const webhookCache = {};

function getWebhook(url) {
  if (!url) return null;
  if (!webhookCache[url]) {
    webhookCache[url] = new WebhookClient({ url });
  }
  return webhookCache[url];
}

// ========== Component reconstruction ==========
function reconstructComponents(components) {
  if (!components || components.length === 0) return [];

  return components.map(row => {
    const actionRow = new MessageActionRow();
    const buttons = row.components.map(btn => {
      // Link buttons (URLs) work anywhere
      if (btn.url) {
        return new MessageButton()
          .setStyle('LINK')
          .setLabel(btn.label || 'Link')
          .setURL(btn.url)
          .setEmoji(btn.emoji?.id || btn.emoji?.name || null)
          .setDisabled(btn.disabled || false);
      }
      // Custom ID buttons will appear but won't function in the dest
      // unless you also handle interactions there. We keep them for visuals.
      return new MessageButton()
        .setStyle(btn.style || 'SECONDARY')
        .setLabel(btn.label || '\u200b')
        .setCustomId(btn.customId || 'dead-btn')
        .setEmoji(btn.emoji?.id || btn.emoji?.name || null)
        .setDisabled(true); // disable non-link buttons since they won't work in dest
    });
    return actionRow.addComponents(buttons);
  });
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  ready = true;
});

// ========== Forward helper ==========
async function forwardMessage(pair, content, embeds, files, components, label) {
  try {
    const payload = {
      content: content || undefined,
      embeds: embeds?.length ? embeds : undefined,
      components: components?.length ? components : undefined,
      files: files?.length ? files : undefined,
    };

    const hook = getWebhook(pair.webhookUrl);
    if (hook) {
      await hook.send(payload);
    } else {
      const dest = await client.channels.fetch(pair.destination);
      // Normal user accounts cannot send components, so strip them
      delete payload.components;
      await dest.send(payload);
    }
    console.log(label);
  } catch (err) {
    console.error("Forward failed:", err.message);
  }
}

// ========== History backfill ==========
async function fetchHistory(channel, count) {
  const all = [];
  let before = null;
  while (all.length < count) {
    const options = { limit: Math.min(100, count - all.length) };
    if (before) options.before = before;
    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
  }
  return all.reverse(); // oldest first
}

async function backfillPair(pair) {
  const sourceId = pair.source;
  const count = Number(pair.backfillCount) || 0;
  if (!sourceId || !pair.destination || count <= 0) return;
  if (lastMessages[sourceId]) return; // already has state, skip backfill

  console.log(`📜 Backfilling ${count} messages from ${sourceId}...`);

  try {
    const channel = await client.channels.fetch(sourceId);
    const messages = await fetchHistory(channel, count);

    for (const msg of messages) {
      if (MUST && !msg.content.includes(MUST)) continue;
      if (ANY.length && !ANY.some(v => msg.content.includes(v))) continue;

      await forwardMessage(
        pair,
        msg.content,
        [...msg.embeds],
        [...msg.attachments.values()],
        reconstructComponents(msg.components),
        `📜 BACK ${sourceId} → ${pair.destination}`
      );

      // update state so we don't re-forward on restart
      lastMessages[sourceId] = msg.createdTimestamp;
      saveState(lastMessages);
    }

    console.log(`✅ Backfill done for ${sourceId}`);
  } catch (err) {
    console.error(`Backfill failed on ${sourceId}:`, err.message);
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
        reconstructComponents(msg.components),
        `➡️ NEW  ${sourceId} → ${pair.destination}`
      );
    }

    saveState(lastMessages);
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
    reconstructComponents(newMessage.components),
    `✏️ EDIT ${newMessage.channelId} → ${pair.destination}`
  );
});

// Login + backfill on ready + start polling
client.login(TOKEN).catch(e => {
  console.error("Login failed:", e.message);
  process.exit(1);
});

client.on('ready', async () => {
  for (const pair of CHANNELS) {
    await backfillPair(pair);
  }
  setInterval(checkAll, DELAY * 1000);
});

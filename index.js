const { Client } = require('discord.js-selfbot-v13');
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

// source â†’ destination map
const sourceToDest = {};
for (const pair of CHANNELS) {
  if (pair.source && pair.destination) {
    sourceToDest[pair.source] = pair.destination;
  }
}

const client = new Client({ checkUpdate: false });
const lastMessages = {};
let ready = false;

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  ready = true;
});

// ========== NEW messages (polling) ==========
async function checkPair(pair) {
  const sourceId = pair.source;
  const destId = pair.destination;
  if (!sourceId || !destId) return;

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

      const dest = await client.channels.fetch(destId);
      await dest.send({
        content: msg.content || undefined,
        files: [...msg.attachments.values()]
      });
      console.log(`âž¡ï¸ NEW  ${sourceId} â†’ ${destId}`);
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

  const destId = sourceToDest[newMessage.channelId];
  if (!destId) return;

  // Filters (using return, NOT continue)
  if (MUST && !newMessage.content.includes(MUST)) return;
  if (ANY.length && !ANY.some(v => newMessage.content.includes(v))) return;

  // Only if content actually changed
  if (oldMessage.content === newMessage.content) return;

  try {
    const dest = await client.channels.fetch(destId);
    await dest.send({
      content: `ðŸ“ **Edited:**\n${newMessage.content || "*empty*"}`,
      files: [...newMessage.attachments.values()]
    });
    console.log(`âœï¸ EDIT ${newMessage.channelId} â†’ ${destId}`);
  } catch (err) {
    console.error("Failed to forward edit:", err.message);
  }
});

// Login
client.login(TOKEN).catch(e => {
  console.error("Login failed:", e.message);
  process.exit(1);
});

setInterval(checkAll, DELAY * 1000);  console.log(`Logged in as ${client.user.tag}`);
  ready = true;
});

// ========== NEW messages (polling) ==========
async function checkPair(pair) {
  const sourceId = pair.source;
  const destId = pair.destination;
  if (!sourceId || !destId) return;

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

      const dest = await client.channels.fetch(destId);
      await dest.send({
        content: msg.content || undefined,
        files: [...msg.attachments.values()]
      });
      console.log(`➡️ NEW  ${sourceId} → ${destId}`);
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

  const destId = sourceToDest[newMessage.channelId];
  if (!destId) return;

  // Filters (using return, NOT continue)
  if (MUST && !newMessage.content.includes(MUST)) return;
  if (ANY.length && !ANY.some(v => newMessage.content.includes(v))) return;

  // Only if content actually changed
  if (oldMessage.content === newMessage.content) return;

  try {
    const dest = await client.channels.fetch(destId);
    await dest.send({
      content: `📝 **Edited:**\n${newMessage.content || "*empty*"}`,
      files: [...newMessage.attachments.values()]
    });
    console.log(`✏️ EDIT ${newMessage.channelId} → ${destId}`);
  } catch (err) {
    console.error("Failed to forward edit:", err.message);
  }
});

// Login
client.login(TOKEN).catch(e => {
  console.error("Login failed:", e.message);
  process.exit(1);
});

setInterval(checkAll, DELAY * 1000);  const destId = pair.destination;
  if (!sourceId || !destId) return;

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

      const dest = await client.channels.fetch(destId);
      await dest.send({
        content: msg.content || undefined,
        files: [...msg.attachments.values()]
      });
      console.log(`➡️ NEW  ${sourceId} → ${destId} | ${msg.author.tag}`);
    }
  } catch (err) {
    console.error(`Error checking ${sourceId}:`, err.message);
  }
}

async function checkAll() {
  if (!ready) return;
  for (const pair of CHANNELS) {
    await checkPair(pair);
  }
}

// ========== Handle EDITED messages ==========
client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!ready) return;
  if (!newMessage.guild) return; // ignore DMs
  if (newMessage.author?.bot) return;

  const destId = sourceToDest[newMessage.channelId];
  if (!destId) return; // this channel is not being tracked

  // Apply the same filters
  if (MUST && !newMessage.content.includes(MUST)) return;
  if (ANY.length && !ANY.some(v => newMessage.content.includes(v))) return;

  // Only forward if the content actually changed
  if (oldMessage.content === newMessage.content) return;

  try {
    const dest = await client.channels.fetch(destId);
    await dest.send({
      content: `📝 **Edited message:**\n${newMessage.content || "*empty*"}`,
      files: [...newMessage.attachments.values()]
    });
    console.log(`✏️ EDIT ${newMessage.channelId} → ${destId} | ${newMessage.author.tag}`);
  } catch (err) {
    console.error("Failed to forward edited message:", err.message);
  }
});

// Login + start polling
client.login(TOKEN).catch(e => {
  console.error("Login failed:", e.message);
  process.exit(1);
});

setInterval(checkAll, DELAY * 1000);
      if (MUST && !msg.content.includes(MUST)) continue;
      if (ANY.length && !ANY.some(v => msg.content.includes(v))) continue;

      const dest = await client.channels.fetch(DEST);
      await dest.send({
        content: msg.content || undefined,
        files: [...msg.attachments.values()]
      });
      console.log(`Forwarded: ${msg.author.tag}`);
    }
  } catch (e) {
    console.error(e.message);
  }
}

client.login(TOKEN).catch(e => {
  console.error("Login failed:", e.message);
  process.exit(1);
});

setInterval(check, DELAY * 1000);

const { Client } = require('discord.js-selfbot-v13');
require("hjson/lib/require-config");
const config = require("./config.hjson");

const TOKEN = (config.token || "").trim();
const SOURCE = (config.sourceChannel || "").trim();
const DEST = (config.destinationChannel || "").trim();
const DELAY = Number(config.delayInterval) || 60;
const LIMIT = Number(config.readMessages) || 20;
const MUST = config.messageMustInclude || "";
const ANY = Array.isArray(config.messageAnyIncludes) ? config.messageAnyIncludes.filter(Boolean) : [];

if (!TOKEN || !SOURCE || !DEST) {
  console.error("Missing token or channel IDs in config.hjson");
  process.exit(1);
}

const client = new Client({ checkUpdate: false });
let lastMessage = 0;
let ready = false;

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  ready = true;
});

async function check() {
  if (!ready) return;
  try {
    const channel = await client.channels.fetch(SOURCE);
    const messages = await channel.messages.fetch({ limit: LIMIT });
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const msg of sorted) {
      if (msg.createdTimestamp <= lastMessage) continue;
      lastMessage = msg.createdTimestamp;

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

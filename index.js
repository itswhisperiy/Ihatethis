const fs = require("fs");
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { Client: BotClient, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
require("hjson/lib/require-config");
const config = require("./config.hjson");

const SELFBOT_TOKEN = (config.selfbotToken || "").trim();
const BOT_TOKEN = (config.botToken || "").trim();
const CHANNELS = Array.isArray(config.channels) ? config.channels : [];
const DELAY = Number(config.delayInterval) || 60;
const LIMIT = Number(config.readMessages) || 20;
const MUST = config.messageMustInclude || "";
const ANY = Array.isArray(config.messageAnyIncludes) ? config.messageAnyIncludes.filter(Boolean) : [];

if (!SELFBOT_TOKEN || !BOT_TOKEN || CHANNELS.length === 0) {
  console.error("Missing selfbotToken, botToken, or channels in config.hjson");
  process.exit(1);
}

// source → pair map
const sourceToPair = {};
for (const pair of CHANNELS) {
  if (pair.source && pair.destination) {
    sourceToPair[pair.source] = pair;
  }
}

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

// ========== Message mapping ==========
// destMessageId -> { sourceMessageId, sourceChannelId, customId }
const messageMap = new Map();
// sourceMessageId -> destMessageId
const reverseMap = new Map();

let ready = false;

// ========== Selfbot ==========
const selfbot = new SelfbotClient({ checkUpdate: false });

selfbot.on('ready', () => {
  console.log(`[Selfbot] Logged in as ${selfbot.user.tag}`);
  ready = true;
});

// ========== Real Bot ==========
const bot = new BotClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

bot.on('ready', () => {
  console.log(`[Bot] Logged in as ${bot.user.tag}`);
});

// ========== Component reconstruction ==========
function styleNameToEnum(style) {
  const map = {
    1: ButtonStyle.Primary,
    2: ButtonStyle.Secondary,
    3: ButtonStyle.Success,
    4: ButtonStyle.Danger,
    5: ButtonStyle.Link,
    'PRIMARY': ButtonStyle.Primary,
    'SECONDARY': ButtonStyle.Secondary,
    'SUCCESS': ButtonStyle.Success,
    'DANGER': ButtonStyle.Danger,
    'LINK': ButtonStyle.Link,
  };
  return map[style] ?? ButtonStyle.Secondary;
}

function reconstructComponents(components, sourceMsgId, sourceChId) {
  if (!components || components.length === 0) return [];

  return components.map(row => {
    const actionRow = new ActionRowBuilder();
    const buttons = row.components.map(btn => {
      const style = styleNameToEnum(btn.style);
      const builder = new ButtonBuilder()
        .setStyle(style)
        .setLabel(btn.label || '\u200b')
        .setDisabled(false);

      if (style === ButtonStyle.Link && btn.url) {
        builder.setURL(btn.url);
      } else {
        // Proxy button — encode source info in customId
        const proxyId = `proxy:${sourceChId}:${sourceMsgId}:${btn.customId || btn.custom_id || 'btn'}`;
        builder.setCustomId(proxyId);
      }

      if (btn.emoji) {
        builder.setEmoji(btn.emoji.id || btn.emoji.name);
      }

      return builder;
    });
    return actionRow.addComponents(buttons);
  });
}

// ========== Forward helper (bot posts to destination) ==========
async function forwardToDest(pair, content, embeds, files, components, sourceMsgId, sourceChId) {
  try {
    const destChannel = await bot.channels.fetch(pair.destination);
    const payload = {
      content: content || undefined,
      embeds: embeds?.length ? embeds : undefined,
      components: components?.length ? components : undefined,
      files: files?.length ? files : undefined,
    };

    const sent = await destChannel.send(payload);
    console.log(`➡️ NEW  ${sourceChId} → ${pair.destination}`);

    // Map destination message back to source for interaction proxying
    messageMap.set(sent.id, { sourceMessageId: sourceMsgId, sourceChannelId: sourceChId });
    reverseMap.set(sourceMsgId, sent.id);
    return sent;
  } catch (err) {
    console.error("Forward failed:", err.message);
    return null;
  }
}

// ========== Selfbot clicks button in source ==========
async function clickSourceButton(sourceChId, sourceMsgId, customId) {
  return new Promise(async (resolve) => {
    try {
      const channel = await selfbot.channels.fetch(sourceChId);
      const msg = await channel.messages.fetch(sourceMsgId);

      // Try to find and click the button component
      let clicked = false;
      for (const row of msg.components || []) {
        for (const comp of row.components) {
          if ((comp.customId || comp.custom_id) === customId) {
            await comp.click();
            clicked = true;
            break;
          }
        }
        if (clicked) break;
      }

      if (!clicked) {
        resolve({ success: false, text: "Button not found on source message." });
        return;
      }

      // Race: ephemeral reply OR message update OR timeout
      const timeout = setTimeout(() => {
        resolve({ success: false, text: "Timed out waiting for source bot response." });
      }, 10000);

      // Listen for ephemeral message in the channel
      const collector = channel.createMessageCollector({
        filter: m => m.author?.bot && m.content?.length > 0,
        max: 1,
        time: 10000,
      });

      collector.on('collect', (m) => {
        clearTimeout(timeout);
        resolve({ success: true, text: m.content, embeds: [...m.embeds] });
      });

      // Also listen for message update (some bots edit instead of replying)
      const onUpdate = async (oldMsg, newMsg) => {
        if (newMsg.id === sourceMsgId && newMsg.content !== oldMsg.content) {
          clearTimeout(timeout);
          selfbot.off('messageUpdate', onUpdate);
          resolve({ success: true, text: newMsg.content, embeds: [...newMsg.embeds] });
        }
      };
      selfbot.on('messageUpdate', onUpdate);

    } catch (err) {
      resolve({ success: false, text: `Error: ${err.message}` });
    }
  });
}

// ========== Bot handles button clicks in destination ==========
bot.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('proxy:')) return;

  const [, sourceChId, sourceMsgId, originalCustomId] = interaction.customId.split(':');
  if (!sourceChId || !sourceMsgId || !originalCustomId) return;

  await interaction.deferReply({ ephemeral: true });

  const result = await clickSourceButton(sourceChId, sourceMsgId, originalCustomId);

  if (result.success) {
    const payload = { content: result.text || "Done!" };
    if (result.embeds?.length) payload.embeds = result.embeds;
    await interaction.editReply(payload);
  } else {
    await interaction.editReply({ content: `⚠️ ${result.text}` });
  }
});

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
  return all.reverse();
}

async function backfillPair(pair) {
  const sourceId = pair.source;
  const count = Number(pair.backfillCount) || 0;
  if (!sourceId || !pair.destination || count <= 0) return;
  if (lastMessages[sourceId]) return;

  console.log(`📜 Backfilling ${count} messages from ${sourceId}...`);

  try {
    const channel = await selfbot.channels.fetch(sourceId);
    const messages = await fetchHistory(channel, count);

    for (const msg of messages) {
      if (MUST && !msg.content.includes(MUST)) continue;
      if (ANY.length && !ANY.some(v => msg.content.includes(v))) continue;

      const components = reconstructComponents(msg.components, msg.id, sourceId);
      await forwardToDest(
        pair,
        msg.content,
        [...msg.embeds],
        [...msg.attachments.values()],
        components,
        msg.id,
        sourceId
      );

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
    const channel = await selfbot.channels.fetch(sourceId);
    const messages = await channel.messages.fetch({ limit: LIMIT });
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const last = lastMessages[sourceId] || 0;

    for (const msg of sorted) {
      if (msg.createdTimestamp <= last) continue;
      lastMessages[sourceId] = msg.createdTimestamp;

      if (MUST && !msg.content.includes(MUST)) continue;
      if (ANY.length && !ANY.some(v => msg.content.includes(v))) continue;

      const components = reconstructComponents(msg.components, msg.id, sourceId);
      await forwardToDest(
        pair,
        msg.content,
        [...msg.embeds],
        [...msg.attachments.values()],
        components,
        msg.id,
        sourceId
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
selfbot.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!ready) return;
  if (!newMessage.guild) return;
  if (newMessage.author?.bot) return;

  const pair = sourceToPair[newMessage.channelId];
  if (!pair) return;

  if (MUST && !newMessage.content.includes(MUST)) return;
  if (ANY.length && !ANY.some(v => newMessage.content.includes(v))) return;
  if (oldMessage.content === newMessage.content) return;

  const destMsgId = reverseMap.get(newMessage.id);
  if (!destMsgId) return;

  try {
    const destChannel = await bot.channels.fetch(pair.destination);
    const destMsg = await destChannel.messages.fetch(destMsgId);
    await destMsg.edit({
      content: `📝 **Edited:**\n${newMessage.content || "*empty*"}`,
      embeds: [...newMessage.embeds],
    });
    console.log(`✏️ EDIT ${newMessage.channelId} → ${pair.destination}`);
  } catch (err) {
    console.error("Failed to forward edit:", err.message);
  }
});

// ========== Startup ==========
async function start() {
  await bot.login(BOT_TOKEN);
  await selfbot.login(SELFBOT_TOKEN);

  selfbot.on('ready', async () => {
    for (const pair of CHANNELS) {
      await backfillPair(pair);
    }
    setInterval(checkAll, DELAY * 1000);
  });
}

start().catch(e => {
  console.error("Startup failed:", e.message);
  process.exit(1);
});

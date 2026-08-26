const fs = require("fs");
const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require("axios");
require("hjson/lib/require-config");
const config = require("../config.hjson");

const TOKEN = (config.botToken || "").trim();
const CHANNELS = Array.isArray(config.channels) ? config.channels : [];

if (!TOKEN) {
  console.error("[Bot] Missing botToken in config.hjson");
  process.exit(1);
}

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildEmojis,
  ],
});

const SELFBOT_URL = "http://127.0.0.1:3002";

// destMsgId -> { sourceMessageId, sourceChannelId }
const messageMap = new Map();

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

// ========== Emoji resolver (async, force-fetches if cache empty) ==========
async function findEmoji(name, guild) {
  if (!guild) return null;

  // Try cache first
  let emoji = guild.emojis.cache.find(e => e.name === name);
  if (!emoji) {
    emoji = guild.emojis.cache.find(e => e.name.toLowerCase() === name.toLowerCase());
  }
  if (emoji) return emoji;

  // Cache empty or emoji not found â€” force fetch
  if (guild.emojis.cache.size === 0 || !emoji) {
    try {
      await guild.emojis.fetch();
      emoji = guild.emojis.cache.find(e => e.name === name);
      if (!emoji) {
        emoji = guild.emojis.cache.find(e => e.name.toLowerCase() === name.toLowerCase());
      }
      if (emoji) return emoji;
    } catch (e) {
      console.error(`[Bot] Failed to fetch emojis for ${guild.name}:`, e.message);
    }
  }

  // Fallback: search ALL guilds the bot is in
  for (const g of bot.guilds.cache.values()) {
    if (g.id === guild.id) continue;
    let e = g.emojis.cache.find(e => e.name === name);
    if (!e) e = g.emojis.cache.find(e => e.name.toLowerCase() === name.toLowerCase());
    if (e) {
      console.log(`[Bot Emoji] Found "${name}" in fallback guild "${g.name}"`);
      return e;
    }
  }

  return null;
}

async function resolveEmojis(text, guild) {
  if (!text || typeof text !== 'string') return text;

  // Replace existing Discord emoji mentions from source server with destination equivalents
  let resolved = text;
  const mentionRegex = /<(a?):(\w+):(\d+)>/g;
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    const [full, animated, name, oldId] = match;
    const emoji = await findEmoji(name, guild);
    if (emoji) {
      const replacement = emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
      resolved = resolved.replace(full, replacement);
    } else {
      // No matching emoji â€” strip the broken mention, keep just the name
      resolved = resolved.replace(full, `:${name}:`);
    }
  }

  // Also handle bare :name: patterns (fallback)
  const bareRegex = /:([a-zA-Z0-9_]+):/g;
  while ((match = bareRegex.exec(text)) !== null) {
    const [full, name] = match;
    // Skip if already replaced above or if it's a standard Discord timestamp
    if (resolved.includes(full)) {
      const emoji = await findEmoji(name, guild);
      if (emoji) {
        const replacement = emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
        resolved = resolved.replace(full, replacement);
      }
    }
  }

  return resolved;
}

async function resolveEmbedEmojis(embed, guild) {
  if (!embed) return embed;
  const resolved = { ...embed };
  if (resolved.title) resolved.title = await resolveEmojis(resolved.title, guild);
  if (resolved.description) resolved.description = await resolveEmojis(resolved.description, guild);
  if (resolved.footer?.text) resolved.footer.text = await resolveEmojis(resolved.footer.text, guild);
  if (resolved.author?.name) resolved.author.name = await resolveEmojis(resolved.author.name, guild);
  if (Array.isArray(resolved.fields)) {
    resolved.fields = await Promise.all(resolved.fields.map(async f => ({
      ...f,
      name: await resolveEmojis(f.name, guild),
      value: await resolveEmojis(f.value, guild),
    })));
  }
  return resolved;
}

bot.on('ready', () => {
  console.log(`[Bot] Logged in as ${bot.user.tag}`);
});

// ========== HTTP endpoints ==========
const http = require("http");
const url = require("url");

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  res.setHeader("Content-Type", "application/json");

  if (parsed.pathname === "/forward" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const destChannel = await bot.channels.fetch(data.destination);
        const guild = destChannel.guild || null;
        const components = reconstructComponents(data.components, data.sourceId, data.sourceChannelId);

        const resolvedContent = await resolveEmojis(data.content, guild);
        const resolvedEmbeds = data.embeds?.length
          ? await Promise.all(data.embeds.map(e => resolveEmbedEmojis(e, guild)))
          : undefined;

        const payload = {
          content: resolvedContent || undefined,
          embeds: resolvedEmbeds,
          components: components?.length ? components : undefined,
          files: data.attachments?.length ? data.attachments : undefined,
        };
        const sent = await destChannel.send(payload);
        messageMap.set(sent.id, {
          sourceMessageId: data.sourceId,
          sourceChannelId: data.sourceChannelId,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, destMessageId: sent.id }));
      } catch (err) {
        console.error("[Bot] /forward error:", err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (parsed.pathname === "/edit" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const destChannel = await bot.channels.fetch(data.destination);
        const destMsg = await destChannel.messages.fetch(data.destMessageId);
        const guild = destChannel.guild || null;

        const resolvedEmbeds = data.embeds?.length
          ? await Promise.all(data.embeds.map(e => resolveEmbedEmojis(e, guild)))
          : undefined;

        const editPayload = {
          content: data.content || undefined,
          embeds: resolvedEmbeds,
        };
        if (destMsg.components?.length) {
          editPayload.components = destMsg.components;
        }

        await destMsg.edit(editPayload);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error("[Bot] /edit error:", err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(3001, () => {
  console.log("[Bot] HTTP server on port 3001");
});

// ========== Handle button clicks ==========
bot.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('proxy:')) return;

  const parts = interaction.customId.split(':');
  if (parts.length < 4) return;
  const sourceChId = parts[1];
  const sourceMsgId = parts[2];
  const originalCustomId = parts[3];

  await interaction.deferReply({ ephemeral: true });

  try {
    const res = await axios.post(`${SELFBOT_URL}/click`, {
      sourceChannelId: sourceChId,
      sourceMessageId: sourceMsgId,
      customId: originalCustomId,
    }, { timeout: 20000 });

    const result = res.data;
    if (result.success) {
      const payload = { content: result.text || "Done!" };
      if (result.embeds?.length) payload.embeds = result.embeds;
      await interaction.editReply(payload);
    } else {
      await interaction.editReply({ content: `âš ï¸ ${result.text}` });
    }
  } catch (err) {
    console.error("[Bot] Proxy click failed:", err.message);
    await interaction.editReply({ content: "âš ï¸ Failed to reach selfbot. Is it running?" });
  }
});

bot.login(TOKEN).catch(e => {
  console.error("[Bot] Login failed:", e.message);
  process.exit(1);
});

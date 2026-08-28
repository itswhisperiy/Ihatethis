const fs = require("fs");
const { Client, Options } = require('discord.js-selfbot-v13');
const axios = require("axios");
require("hjson/lib/require-config");
const config = require("../config.hjson");

const TOKEN = (config.selfbotToken || "").trim();
const CHANNELS = Array.isArray(config.channels) ? config.channels : [];
const DELAY = Number(config.delayInterval) || 60;
const LIMIT = Number(config.readMessages) || 20;
const MUST = config.messageMustInclude || "";
const ANY = Array.isArray(config.messageAnyIncludes) ? config.messageAnyIncludes.filter(Boolean) : [];
const BOT_URL = (config.botUrl || "http://127.0.0.1:3001").trim();

if (!TOKEN || CHANNELS.length === 0) {
  console.error("[Selfbot] Missing token or channels in config.hjson");
  process.exit(1);
}

const sourceToPair = {};
for (const pair of CHANNELS) {
  if (pair.source && pair.destination) {
    sourceToPair[pair.source] = pair;
  }
}

const STATE_PATH = "./state.json";
const MAP_PATH = "./map.json";

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function loadMap() {
  try { return JSON.parse(fs.readFileSync(MAP_PATH, "utf8")); } catch { return {}; }
}
function saveMap(map) {
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
}

const lastMessages = loadState();
const msgMap = loadMap();
let ready = false;

const client = new Client({
  checkUpdate: false,
  ...(Options && Options.cacheWithLimits ? {
    makeCache: Options.cacheWithLimits({
      MessageManager: 10,
      UserManager: 50,
      GuildMemberManager: 50,
      ChannelManager: 20,
      GuildManager: 5,
      PresenceManager: 0,
      ReactionManager: 0,
      ReactionUserManager: 0,
      StageInstanceManager: 0,
      VoiceStateManager: 0,
    })
  } : {}),
});

// Periodic cache sweep to prevent unbounded memory growth
setInterval(() => {
  try {
    client.sweepMessages(60);
    if (client.users.cache.size > 100) client.users.cache.sweep(() => true);
    if (client.channels.cache.size > 30) {
      const keepIds = new Set(CHANNELS.map(c => c.source));
      client.channels.cache.sweep(ch => !keepIds.has(ch.id));
    }
  } catch (e) {
    // ignore sweep errors
  }
}, 60000);

client.on('ready', () => {
  console.log(`[Selfbot] Logged in as ${client.user.tag}`);
  ready = true;
});

// ========== Linkvertise bypass ==========
const LINKVERTISE_DOMAINS = [
  'linkvertise.com',
  'link-to.net',
  'direct-link.net',
  'up-to-down.net',
  'linkvertise.download',
  'link-center.net',
  'link-target.net',
  'linkvertise.net',
];

const bypassCache = new Map();
setInterval(() => bypassCache.clear(), 3600000); // clear every hour

function isLinkvertiseUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return LINKVERTISE_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

async function bypassLinkvertise(url) {
  if (bypassCache.has(url)) return bypassCache.get(url);

  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      maxRedirects: 5,
    });

    const html = res.data;
    let realUrl = null;

    // Pattern 1: window.location.href = "..."
    let m = html.match(/window\.location\.href\s*=\s*["'](https?:\/\/[^"']+)["']/i);
    if (m && !isLinkvertiseUrl(m[1])) realUrl = m[1];

    // Pattern 2: window.location.replace("...")
    if (!realUrl) {
      m = html.match(/window\.location\.replace\s*\(\s*["'](https?:\/\/[^"']+)["']\s*\)/i);
      if (m && !isLinkvertiseUrl(m[1])) realUrl = m[1];
    }

    // Pattern 3: window.location.assign("...")
    if (!realUrl) {
      m = html.match(/window\.location\.assign\s*\(\s*["'](https?:\/\/[^"']+)["']\s*\)/i);
      if (m && !isLinkvertiseUrl(m[1])) realUrl = m[1];
    }

    // Pattern 4: "target":"https://..." (JSON-escaped)
    if (!realUrl) {
      m = html.match(/"target"\s*:\s*"((?:https?:\\/\\/|https?:\/\/)[^"]+)"/i);
      if (m) {
        let target = m[1].replace(/\\u002f/g, '/').replace(/\\\//g, '/');
        if (!isLinkvertiseUrl(target)) realUrl = target;
      }
    }

    // Pattern 5: const/var/let targetUrl = '...'
    if (!realUrl) {
      m = html.match(/(?:const|var|let)\s+\w*[Tt]arget\w*\s*=\s*["'](https?:\/\/[^"']+)["']/i);
      if (m && !isLinkvertiseUrl(m[1])) realUrl = m[1];
    }

    // Pattern 6: data-url="..." or data-href="..."
    if (!realUrl) {
      m = html.match(/data-(?:url|href)\s*=\s*["'](https?:\/\/[^"']+)["']/i);
      if (m && !isLinkvertiseUrl(m[1])) realUrl = m[1];
    }

    // Pattern 7: meta refresh
    if (!realUrl) {
      m = html.match(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+url\s*=\s*(https?:\/\/[^"'>]+)/i);
      if (m && !isLinkvertiseUrl(m[1])) realUrl = m[1];
    }

    // Pattern 8: <a id="..." href="https://..."> where href is not linkvertise
    if (!realUrl) {
      const hrefMatches = html.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi);
      for (const match of hrefMatches) {
        if (!isLinkvertiseUrl(match[1])) {
          realUrl = match[1];
          break;
        }
      }
    }

    const result = realUrl || url;
    bypassCache.set(url, result);
    if (result !== url) {
      console.log(`[Selfbot] â›“ï¸â€ðŸ’¥ Bypassed Linkvertise: ${url} â†’ ${result}`);
    }
    return result;
  } catch (err) {
    console.error(`[Selfbot] Linkvertise bypass failed for ${url}:`, err.message);
    bypassCache.set(url, url);
    return url;
  }
}

async function resolveLinkvertise(text) {
  if (!text || typeof text !== 'string') return text;

  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  const matches = [...text.matchAll(urlRegex)].map(m => m[0]);
  if (matches.length === 0) return text;

  let resolved = text;
  for (const url of matches) {
    if (isLinkvertiseUrl(url)) {
      const real = await bypassLinkvertise(url);
      if (real !== url) {
        resolved = resolved.replace(url, real);
      }
    }
  }
  return resolved;
}

async function resolveEmbedLinkvertise(embed) {
  if (!embed) return embed;
  const resolved = embed.toJSON ? embed.toJSON() : { ...embed };

  if (resolved.description) resolved.description = await resolveLinkvertise(resolved.description);
  if (resolved.title) resolved.title = await resolveLinkvertise(resolved.title);
  if (resolved.url && isLinkvertiseUrl(resolved.url)) {
    resolved.url = await bypassLinkvertise(resolved.url);
  }
  if (resolved.footer?.text) resolved.footer.text = await resolveLinkvertise(resolved.footer.text);
  if (resolved.author?.name) resolved.author.name = await resolveLinkvertise(resolved.author.name);
  if (resolved.author?.url && isLinkvertiseUrl(resolved.author.url)) {
    resolved.author.url = await bypassLinkvertise(resolved.author.url);
  }
  if (Array.isArray(resolved.fields)) {
    for (const field of resolved.fields) {
      if (field.name) field.name = await resolveLinkvertise(field.name);
      if (field.value) field.value = await resolveLinkvertise(field.value);
    }
  }
  if (resolved.image?.url && isLinkvertiseUrl(resolved.image.url)) {
    resolved.image.url = await bypassLinkvertise(resolved.image.url);
  }
  if (resolved.thumbnail?.url && isLinkvertiseUrl(resolved.thumbnail.url)) {
    resolved.thumbnail.url = await bypassLinkvertise(resolved.thumbnail.url);
  }

  return resolved;
}

async function resolveComponentsLinkvertise(components) {
  if (!components || components.length === 0) return [];

  const resolved = [];
  for (const row of components) {
    const newRow = {
      type: row.type,
      components: [],
    };
    for (const btn of row.components) {
      const newBtn = {
        type: btn.type,
        style: btn.style,
        label: btn.label,
        customId: btn.customId || btn.custom_id,
        url: btn.url,
        emoji: btn.emoji,
        disabled: btn.disabled,
      };

      // Link buttons (style 5) have URLs â€” resolve Linkvertise
      if (btn.style === 5 && btn.url && isLinkvertiseUrl(btn.url)) {
        newBtn.url = await bypassLinkvertise(btn.url);
      }

      newRow.components.push(newBtn);
    }
    resolved.push(newRow);
  }
  return resolved;
}

// ========== Forward to bot via HTTP ==========
async function forwardToBot(pair, msg) {
  try {
    // Resolve Linkvertise URLs in content, embeds, and components once per message
    const resolvedContent = await resolveLinkvertise(msg.content);
    const resolvedEmbeds = await Promise.all(msg.embeds.map(e => resolveEmbedLinkvertise(e)));
    const resolvedComponents = await resolveComponentsLinkvertise(msg.components);

    const payload = {
      sourceId: msg.id,
      sourceChannelId: msg.channelId,
      destination: pair.destination,
      content: resolvedContent,
      embeds: resolvedEmbeds,
      attachments: [...msg.attachments.values()].map(a => a.url),
      components: resolvedComponents,
    };
    const res = await axios.post(`${BOT_URL}/forward`, payload, { timeout: 15000 });
    if (res.data && res.data.destMessageId) {
      msgMap[msg.id] = { destId: res.data.destMessageId, destChannel: pair.destination };
      saveMap(msgMap);
    }
    console.log(`âž¡ï¸ NEW  ${msg.channelId} â†’ ${pair.destination}`);
  } catch (err) {
    console.error("[Selfbot] Forward failed:", err.message);
  }
}

// ========== History backfill ==========
async function fetchHistory(channel, count) {
  const all = [];
  let before = null;
  while (all.length < count) {
    const options = { limit: Math.min(100, count - all.length), cache: false };
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

  console.log(`[Selfbot] ðŸ“œ Backfilling ${count} messages from ${sourceId}...`);
  try {
    const channel = await client.channels.fetch(sourceId);
    const messages = await fetchHistory(channel, count);
    for (const msg of messages) {
      if (MUST && !msg.content.includes(MUST)) continue;
      if (ANY.length && !ANY.some(v => msg.content.includes(v))) continue;
      await forwardToBot(pair, msg);
      lastMessages[sourceId] = msg.createdTimestamp;
      saveState(lastMessages);
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`[Selfbot] âœ… Backfill done for ${sourceId}`);
  } catch (err) {
    console.error(`[Selfbot] Backfill failed on ${sourceId}:`, err.message);
  }
}

// ========== Polling ==========
async function checkPair(pair) {
  const sourceId = pair.source;
  if (!sourceId || !pair.destination) return;
  try {
    const channel = await client.channels.fetch(sourceId);
    const messages = await channel.messages.fetch({ limit: LIMIT, cache: false });
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const last = lastMessages[sourceId] || 0;
    for (const msg of sorted) {
      if (msg.createdTimestamp <= last) continue;
      lastMessages[sourceId] = msg.createdTimestamp;
      if (MUST && !msg.content.includes(MUST)) continue;
      if (ANY.length && !ANY.some(v => msg.content.includes(v))) continue;
      await forwardToBot(pair, msg);
    }
    saveState(lastMessages);
  } catch (err) {
    console.error(`[Selfbot] Error on ${sourceId}:`, err.message);
  }
}

async function checkAll() {
  if (!ready) return;
  for (const pair of CHANNELS) {
    await checkPair(pair);
  }
}

// ========== Edit tracking ==========
client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!ready) return;
  if (!newMessage.guild) return;
  if (newMessage.author?.id === client.user.id) return;
  const pair = sourceToPair[newMessage.channelId];
  if (!pair) return;
  if (MUST && !newMessage.content.includes(MUST)) return;
  if (ANY.length && !ANY.some(v => newMessage.content.includes(v))) return;

  if (oldMessage && oldMessage.content === newMessage.content && JSON.stringify(oldMessage.embeds) === JSON.stringify(newMessage.embeds)) return;

  const entry = msgMap[newMessage.id];
  const destMsgId = entry && typeof entry === 'object' ? entry.destId : entry;
  if (!destMsgId) return;

  try {
    // Also resolve Linkvertise on edits
    const resolvedContent = await resolveLinkvertise(newMessage.content);
    const resolvedEmbeds = await Promise.all(newMessage.embeds.map(e => resolveEmbedLinkvertise(e)));

    await axios.post(`${BOT_URL}/edit`, {
      destination: pair.destination,
      destMessageId: destMsgId,
      content: resolvedContent,
      embeds: resolvedEmbeds,
    }, { timeout: 15000 });
    console.log(`âœï¸ EDIT ${newMessage.channelId} â†’ ${pair.destination}`);
  } catch (err) {
    console.error("[Selfbot] Edit forward failed:", err.message);
  }
});

// ========== Delete tracking ==========
client.on('messageDelete', async (message) => {
  if (!ready) return;
  if (!message.guild) return;
  const pair = sourceToPair[message.channelId];
  if (!pair) return;

  const entry = msgMap[message.id];
  const destMsgId = entry && typeof entry === 'object' ? entry.destId : entry;
  if (!destMsgId) return;

  try {
    await axios.post(`${BOT_URL}/delete`, {
      destination: pair.destination,
      destMessageId: destMsgId,
    }, { timeout: 15000 });
    delete msgMap[message.id];
    saveMap(msgMap);
    console.log(`ðŸ—‘ï¸ DELETE ${message.channelId} â†’ ${pair.destination}`);
  } catch (err) {
    console.error("[Selfbot] Delete forward failed:", err.message);
  }
});

// ========== Button click endpoint ==========
const http = require("http");
const url = require("url");

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  res.setHeader("Content-Type", "application/json");

  if (parsed.pathname === "/click" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { sourceChannelId, sourceMessageId, customId } = JSON.parse(body);
        const result = await clickSourceButton(sourceChannelId, sourceMessageId, customId);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, text: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(3002, () => {
  console.log("[Selfbot] HTTP server on port 3002");
});

// ========== Click button in source ==========
async function clickSourceButton(sourceChId, sourceMsgId, customId) {
  return new Promise(async (resolve) => {
    let resolved = false;
    const collectedMessages = [];
    let editedMessage = null;

    function doResolve(data) {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(data);
    }

    function cleanup() {
      client.off('messageCreate', onMessage);
      client.off('messageUpdate', onUpdate);
      clearTimeout(timeout);
      collectedMessages.length = 0;
      editedMessage = null;
    }

    function onMessage(m) {
      if (m.channelId !== sourceChId) return;
      if (m.id === sourceMsgId) return;

      const text = (m.content || "").trim();
      collectedMessages.push(m);

      if (text.length > 0 && text.length < 300 && (!m.embeds || m.embeds.length === 0)) {
        doResolve({ success: true, text: text, embeds: [] });
      }
    }

    function onUpdate(oldMsg, newMsg) {
      if (newMsg.id === sourceMsgId) {
        editedMessage = newMsg;
      }
    }

    client.on('messageCreate', onMessage);
    client.on('messageUpdate', onUpdate);

    const timeout = setTimeout(() => {
      const candidates = collectedMessages.filter(m => {
        const text = (m.content || "").trim();
        return m.id !== sourceMsgId && (text.length > 0 || (m.embeds && m.embeds.length > 0));
      });

      if (candidates.length === 0) {
        const channel = client.channels.cache.get(sourceChId);
        if (channel) {
          const cacheRecent = channel.messages.cache.filter(m =>
            m.id !== sourceMsgId &&
            m.createdTimestamp > Date.now() - 20000
          );
          for (const m of cacheRecent.values()) {
            const text = (m.content || "").trim();
            if (text.length > 0 && text.length < 300 && (!m.embeds || m.embeds.length === 0)) {
              doResolve({ success: true, text: text, embeds: [] });
              return;
            }
          }
        }
      }

      if (candidates.length === 0 && editedMessage) {
        doResolve({
          success: true,
          text: editedMessage.content || "",
          embeds: editedMessage.embeds ? editedMessage.embeds.map(e => e.toJSON ? e.toJSON() : e) : [],
        });
        return;
      }

      if (candidates.length === 0) {
        doResolve({ success: false, text: "No response received from source bot." });
        return;
      }

      const plainText = candidates.filter(m => {
        const text = (m.content || "").trim();
        return text.length > 0 && (!m.embeds || m.embeds.length === 0);
      });

      let best;
      if (plainText.length > 0) {
        best = plainText.reduce((a, b) => a.content.length <= b.content.length ? a : b);
      } else {
        best = candidates[0];
      }

      doResolve({
        success: true,
        text: best.content || "",
        embeds: best.embeds ? best.embeds.map(e => e.toJSON ? e.toJSON() : e) : [],
      });
    }, 20000);

    try {
      const channel = await client.channels.fetch(sourceChId);
      const msg = await channel.messages.fetch(sourceMsgId);

      let clicked = false;
      for (const row of msg.components || []) {
        for (const comp of row.components) {
          if ((comp.customId || comp.custom_id) === customId) {
            await msg.clickButton(customId);
            clicked = true;
            console.log(`[Selfbot] Clicked button ${customId}`);
            break;
          }
        }
        if (clicked) break;
      }

      if (!clicked) {
        doResolve({ success: false, text: "Button not found on source message." });
      }
    } catch (err) {
      doResolve({ success: false, text: `Error: ${err.message}` });
    }
  });
}

// ========== Startup ==========
client.login(TOKEN).catch(e => {
  console.error("[Selfbot] Login failed:", e.message);
  process.exit(1);
});

client.on('ready', async () => {
  for (const pair of CHANNELS) {
    await backfillPair(pair);
  }
  setInterval(checkAll, DELAY * 1000);
});

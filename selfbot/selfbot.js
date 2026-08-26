const fs = require("fs");
const { Client } = require('discord.js-selfbot-v13');
const axios = require("axios");
require("hjson/lib/require-config");
const config = require("../config.hjson");

const TOKEN = (config.selfbotToken || "").trim();
const CHANNELS = Array.isArray(config.channels) ? config.channels : [];
const DELAY = Number(config.delayInterval) || 60;
const LIMIT = Number(config.readMessages) || 20;
const MUST = config.messageMustInclude || "";
const ANY = Array.isArray(config.messageAnyIncludes) ? config.messageAnyIncludes.filter(Boolean) : [];
const BOT_URL = "http://127.0.0.1:3001";

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

const client = new Client({ checkUpdate: false });

client.on('ready', () => {
  console.log(`[Selfbot] Logged in as ${client.user.tag}`);
  ready = true;
});

// ========== Forward to bot via HTTP ==========
async function forwardToBot(pair, msg) {
  try {
    const payload = {
      sourceId: msg.id,
      sourceChannelId: msg.channelId,
      destination: pair.destination,
      content: msg.content,
      embeds: msg.embeds.map(e => e.toJSON ? e.toJSON() : e),
      attachments: [...msg.attachments.values()].map(a => a.url),
      components: msg.components.map(row => ({
        type: row.type,
        components: row.components.map(btn => ({
          type: btn.type,
          style: btn.style,
          label: btn.label,
          customId: btn.customId || btn.custom_id,
          url: btn.url,
          emoji: btn.emoji,
          disabled: btn.disabled,
        }))
      })),
    };
    const res = await axios.post(`${BOT_URL}/forward`, payload, { timeout: 15000 });
    if (res.data && res.data.destMessageId) {
      msgMap[msg.id] = res.data.destMessageId;
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
    const messages = await channel.messages.fetch({ limit: LIMIT });
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
  if (newMessage.author?.bot) return;
  const pair = sourceToPair[newMessage.channelId];
  if (!pair) return;
  if (MUST && !newMessage.content.includes(MUST)) return;
  if (ANY.length && !ANY.some(v => newMessage.content.includes(v))) return;
  if (oldMessage.content === newMessage.content && JSON.stringify(oldMessage.embeds) === JSON.stringify(newMessage.embeds)) return;

  const destMsgId = msgMap[newMessage.id];
  if (!destMsgId) return;

  try {
    await axios.post(`${BOT_URL}/edit`, {
      destination: pair.destination,
      destMessageId: destMsgId,
      content: newMessage.content,
      embeds: newMessage.embeds.map(e => e.toJSON ? e.toJSON() : e),
    }, { timeout: 15000 });
    console.log(`âœï¸ EDIT ${newMessage.channelId} â†’ ${pair.destination}`);
  } catch (err) {
    console.error("[Selfbot] Edit forward failed:", err.message);
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
    }

    // Listen for ANY new message in the channel (ephemeral keys might not have bot flag)
    function onMessage(m) {
      if (m.channelId !== sourceChId) return;
      if (m.id === sourceMsgId) return;

      const text = (m.content || "").trim();
      console.log(`[Selfbot Debug] msgCreate: author=${m.author?.tag || "?"}, bot=${m.author?.bot}, text="${text.substring(0, 80)}", embeds=${m.embeds?.length || 0}`);

      collectedMessages.push(m);

      // Keys are short plain text â€” resolve immediately when we see one
      if (text.length > 0 && text.length < 300 && (!m.embeds || m.embeds.length === 0)) {
        console.log(`[Selfbot Debug] Resolved with key: ${text}`);
        doResolve({ success: true, text: text, embeds: [] });
      }
    }

    function onUpdate(oldMsg, newMsg) {
      if (newMsg.id === sourceMsgId) {
        editedMessage = newMsg;
      }
    }

    // SET UP LISTENERS BEFORE CLICKING â€” critical fix
    client.on('messageCreate', onMessage);
    client.on('messageUpdate', onUpdate);

    // Timeout fallback
    const timeout = setTimeout(() => {
      console.log(`[Selfbot Debug] Timeout. Collected ${collectedMessages.length} messages.`);

      const candidates = collectedMessages.filter(m => {
        const text = (m.content || "").trim();
        return m.id !== sourceMsgId && (text.length > 0 || (m.embeds && m.embeds.length > 0));
      });

      // Try cache as last resort
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
              console.log(`[Selfbot Debug] Resolved from cache: ${text}`);
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

      // Prefer plain text, shortest first (keys are short)
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

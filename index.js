require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_KEY = process.env.CLIENT_KEY;
const OWNER_CHAT_ID = String(process.env.CHAT_ID || "");
const POLL_MS = Number(process.env.POLL_MS || 5000);

const API_BASE = "https://gapi.hotmail007.com/v1/mail/getFirstMail";
const MAILBOX_FILE = "./mailboxes.json";
const STATE_FILE = "./state.json";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CLIENT_KEY) console.warn("CLIENT_KEY missing");
if (!OWNER_CHAT_ID) console.warn("CHAT_ID missing (owner-only blocked)");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let mailboxes = [];
const waiting = {}; // chatId -> "load" | "remove" | null

// Persistent "seen" state (like fakemailbot)
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { state = {}; }
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

// Anti-spam safety (kept, but now it won't spam even without it)
let warmedUp = false;
const lastSentAt = {};
const COOLDOWN_MS = 15 * 1000; // 15s safety; change to 0 to disable

function onlyOwner(msg) {
  return String(msg.chat.id) === OWNER_CHAT_ID;
}

function loadMailboxes() {
  try {
    if (!fs.existsSync(MAILBOX_FILE)) fs.writeFileSync(MAILBOX_FILE, "[]");
    mailboxes = JSON.parse(fs.readFileSync(MAILBOX_FILE, "utf8"));
    if (!Array.isArray(mailboxes)) mailboxes = [];
  } catch {
    mailboxes = [];
  }
}

function saveMailboxes() {
  fs.writeFileSync(MAILBOX_FILE, JSON.stringify(mailboxes, null, 2));
}

// ONLY accepts: email:password:refresh_token:client_id
function parseLines(text) {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const p = l.split(":");
      if (p.length !== 4) return null;
      if (!p[0] || !p[0].includes("@")) return null;
      return { name: p[0], account: l };
    })
    .filter(Boolean);
}

function extractOTP(text = "") {
  const m = String(text).match(/\b\d{4,8}\b/);
  return m ? m[0] : null;
}

function normalizeMail(data) {
  const m = Array.isArray(data) ? data[0] : (data?.data || data);
  if (!m || typeof m !== "object") return null;
  return {
    from: m.from || m.sender || "",
    subject: m.subject || "",
    text: m.text || m.body || m.content || ""
  };
}

async function fetchLatest(mailbox, folder) {
  const url =
    `${API_BASE}?clientKey=${encodeURIComponent(CLIENT_KEY)}` +
    `&account=${encodeURIComponent(mailbox.account)}` +
    `&folder=${encodeURIComponent(folder)}`;
  const res = await axios.get(url, { timeout: 10000 });
  return normalizeMail(res.data);
}

async function fetchInboxAndJunk(mailbox) {
  const inbox = await fetchLatest(mailbox, "inbox").catch(() => null);
  if (inbox) return inbox;
  const junk = await fetchLatest(mailbox, "junkemail").catch(() => null);
  return junk;
}

// stable fingerprint (works even when API id changes)
function fingerprint(mail) {
  const base = [
    mail.from || "",
    mail.subject || "",
    (mail.text || "").slice(0, 400)
  ].join("|");
  return crypto.createHash("sha1").update(base).digest("hex");
}

async function readTxtFromTelegramDocument(doc) {
  const name = (doc.file_name || "").toLowerCase();
  if (name && !name.endsWith(".txt")) throw new Error("Only .txt allowed");
  const link = await bot.getFileLink(doc.file_id);
  const res = await axios.get(link, { responseType: "arraybuffer" });
  return Buffer.from(res.data).toString("utf8");
}

// ---------- Commands ----------
loadMailboxes();

const HELP =
`Commands:
/help – show this
/list – list saved mailboxes
/latest <email> – latest mail

Owner:
/load – add mailboxes (paste lines OR upload .txt)
/remove – remove mailboxes (paste lines OR upload .txt)
/clear – remove ALL saved mailboxes

Format:
email:password:refresh_token:client_id`;

bot.onText(/\/start|\/help/, (msg) => bot.sendMessage(msg.chat.id, HELP));

bot.onText(/\/list$/, (msg) => {
  if (!mailboxes.length) return bot.sendMessage(msg.chat.id, "📭 No mailboxes saved.");
  bot.sendMessage(msg.chat.id, mailboxes.map(m => `• ${m.name}`).join("\n"));
});

bot.onText(/\/latest (.+)/, async (msg, m) => {
  const email = (m[1] || "").trim();
  const box = mailboxes.find(x => x.name === email);
  if (!box) return bot.sendMessage(msg.chat.id, "❌ Not found. Use /list");

  const mail = await fetchInboxAndJunk(box).catch(() => null);
  if (!mail) return bot.sendMessage(msg.chat.id, "📭 No mail / API error.");

  const otp = extractOTP(mail.subject + " " + mail.text);
  bot.sendMessage(msg.chat.id,
    `📬 ${email}\nFrom: ${mail.from || "?"}\nSubject: ${mail.subject || "?"}\nOTP: ${otp || "N/A"}`
  );
});

bot.onText(/\/load$/, (msg) => {
  if (!onlyOwner(msg)) return bot.sendMessage(msg.chat.id, "❌ Not allowed.");
  waiting[msg.chat.id] = "load";
  bot.sendMessage(msg.chat.id, "Send lines now OR upload a .txt (each line: email:pass:refresh:client_id).");
});

bot.onText(/\/remove$/, (msg) => {
  if (!onlyOwner(msg)) return bot.sendMessage(msg.chat.id, "❌ Not allowed.");
  waiting[msg.chat.id] = "remove";
  bot.sendMessage(msg.chat.id, "Send lines now OR upload a .txt to remove.");
});

bot.onText(/\/clear$/, (msg) => {
  if (!onlyOwner(msg)) return bot.sendMessage(msg.chat.id, "❌ Not allowed.");
  mailboxes = [];
  saveMailboxes();

  // clear persistent state too
  state = {};
  saveState();
  warmedUp = false;

  bot.sendMessage(msg.chat.id, "✅ Cleared all mailboxes + state.");
});

// Handle pasted text OR uploaded .txt while waiting
bot.on("message", async (msg) => {
  if (!onlyOwner(msg)) return;

  const mode = waiting[msg.chat.id];
  if (!mode) return;

  if (msg.text && msg.text.startsWith("/")) return;

  try {
    let content = null;

    if (msg.document) content = await readTxtFromTelegramDocument(msg.document);
    else if (msg.text) content = msg.text;
    else return;

    const entries = parseLines(content);
    waiting[msg.chat.id] = null;

    if (!entries.length) return bot.sendMessage(msg.chat.id, "❌ No valid lines found.");

    if (mode === "load") {
      let added = 0, skipped = 0;
      for (const e of entries) {
        if (mailboxes.some(m => m.name === e.name)) { skipped++; continue; }
        mailboxes.push(e);
        added++;
      }
      saveMailboxes();
      bot.sendMessage(msg.chat.id, `✅ Added ${added}, skipped ${skipped}`);
    } else if (mode === "remove") {
      const toRemove = new Set(entries.map(e => e.name));
      const before = mailboxes.length;
      mailboxes = mailboxes.filter(m => !toRemove.has(m.name));
      saveMailboxes();

      // also remove their state
      for (const email of toRemove) delete state[email];
      saveState();

      bot.sendMessage(msg.chat.id, `🗑️ Removed ${before - mailboxes.length}`);
    }
  } catch (e) {
    waiting[msg.chat.id] = null;
    bot.sendMessage(msg.chat.id, `⚠️ ${e.message || "Failed to read file"}`);
  }
});

// ---------- Auto-push on NEW mail (ONLY ONCE) ----------
setInterval(async () => {
  if (!mailboxes.length) return;

  for (const m of mailboxes) {
    const mail = await fetchInboxAndJunk(m).catch(() => null);
    if (!mail) continue;

    const fp = fingerprint(mail);

    // first cycle after boot: just sync, do not notify
    if (!warmedUp) {
      state[m.name] = fp;
      continue;
    }

    // already seen -> no notify
    if (state[m.name] === fp) continue;

    // cooldown safety
    const now = Date.now();
    if (COOLDOWN_MS > 0 && lastSentAt[m.name] && now - lastSentAt[m.name] < COOLDOWN_MS) {
      state[m.name] = fp;
      continue;
    }

    // new mail -> notify once, then persist
    state[m.name] = fp;
    lastSentAt[m.name] = now;
    saveState();

    const otp = extractOTP(mail.subject + " " + mail.text);
    await bot.sendMessage(
      OWNER_CHAT_ID,
      `📥 New mail (${m.name})\nFrom: ${mail.from || "?"}\nSubject: ${mail.subject || "?"}\nOTP: ${otp || "N/A"}`
    );
  }

  if (!warmedUp) {
    warmedUp = true;
    saveState(); // save the initial sync
  }
}, POLL_MS);

console.log("Bot running");

// index.js (manual-only: /latest, plus /load /remove (paste or .txt) and /clear)
// No auto-polling / no auto-DMs.

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_KEY = process.env.CLIENT_KEY;
const OWNER_CHAT_ID = String(process.env.CHAT_ID || "");

const API_BASE = "https://gapi.hotmail007.com/v1/mail/getFirstMail";
const MAILBOX_FILE = "./mailboxes.json";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CLIENT_KEY) console.warn("CLIENT_KEY missing");
if (!OWNER_CHAT_ID) console.warn("CHAT_ID missing (owner-only blocked)");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let mailboxes = [];
const waiting = {}; // chatId -> "load" | "remove" | null

function onlyOwner(msg) {
  return String(msg.chat.id) === OWNER_CHAT_ID;
}

function loadMailboxes() {
  try {
    if (!fs.existsSync(MAILBOX_FILE)) fs.writeFileSync(MAILBOX_FILE, "[]");
    const raw = fs.readFileSync(MAILBOX_FILE, "utf8").trim() || "[]";
    const parsed = JSON.parse(raw);
    mailboxes = Array.isArray(parsed) ? parsed : [];
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
      const email = (p[0] || "").trim();
      if (!email.includes("@")) return null;
      return { name: email, account: l.trim() };
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
    id: m.id || m.mailId || m.message_id || m.msgId || m.uid || null,
    from: m.from || m.sender || "",
    subject: m.subject || "",
    text: m.text || m.body || m.content || ""
  };
}

async function fetchLatest(mailbox, folder = "inbox") {
  const url =
    `${API_BASE}?clientKey=${encodeURIComponent(CLIENT_KEY)}` +
    `&account=${encodeURIComponent(mailbox.account)}` +
    `&folder=${encodeURIComponent(folder)}`;

  const res = await axios.get(url, { timeout: 10000 });
  return normalizeMail(res.data);
}

async function fetchLatestFromInboxAndJunk(mailbox) {
  const inbox = await fetchLatest(mailbox, "inbox").catch(() => null);
  if (inbox) return inbox;
  const junk = await fetchLatest(mailbox, "junkemail").catch(() => null);
  return junk;
}

async function readTxtFromTelegramDocument(doc) {
  const name = (doc.file_name || "").toLowerCase();
  if (name && !name.endsWith(".txt")) throw new Error("Only .txt allowed");
  const link = await bot.getFileLink(doc.file_id);
  const res = await axios.get(link, { responseType: "arraybuffer" });
  return Buffer.from(res.data).toString("utf8");
}

// ---- Commands ----
loadMailboxes();

const HELP =
`Commands:
/help – show this
/list – list saved mailboxes
/latest <email> – latest mail (inbox + junk)

Owner:
/load – add mailboxes (paste OR upload .txt)
/remove – remove mailboxes (paste OR upload .txt)
/clear – remove ALL saved mailboxes

Format:
email:password:refresh_token:client_id`;

bot.onText(/\/start|\/help/, (msg) => bot.sendMessage(msg.chat.id, HELP));

bot.onText(/\/list$/, (msg) => {
  if (!mailboxes.length) return bot.sendMessage(msg.chat.id, "📭 No mailboxes saved.");
  bot.sendMessage(msg.chat.id, `📧 Mailboxes:\n${mailboxes.map(m => `• ${m.name}`).join("\n")}`);
});

bot.onText(/\/latest (.+)/, async (msg, match) => {
  const email = (match[1] || "").trim();
  const box = mailboxes.find(x => x.name === email);
  if (!box) return bot.sendMessage(msg.chat.id, "❌ Not found. Use /list");

  try {
    const mail = await fetchLatestFromInboxAndJunk(box);
    if (!mail) return bot.sendMessage(msg.chat.id, "📭 No mail / API error.");

    const otp = extractOTP(`${mail.subject} ${mail.text}`);
    bot.sendMessage(
      msg.chat.id,
      `📬 ${email}\nFrom: ${mail.from || "?"}\nSubject: ${mail.subject || "?"}\nOTP: ${otp || "N/A"}`
    );
  } catch {
    bot.sendMessage(msg.chat.id, "⚠️ Error fetching mail.");
  }
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
  bot.sendMessage(msg.chat.id, "✅ Cleared all mailboxes.");
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
    }

    if (mode === "remove") {
      const toRemove = new Set(entries.map(e => e.name));
      const before = mailboxes.length;
      mailboxes = mailboxes.filter(m => !toRemove.has(m.name));
      saveMailboxes();
      bot.sendMessage(msg.chat.id, `🗑️ Removed ${before - mailboxes.length}`);
    }
  } catch (e) {
    waiting[msg.chat.id] = null;
    bot.sendMessage(msg.chat.id, `⚠️ ${e.message || "Failed to read input"}`);
  }
});

console.log("Bot running (manual mode)");

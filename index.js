require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_KEY = process.env.CLIENT_KEY;
const OWNER_CHAT_ID = String(process.env.CHAT_ID || "");
const POLL_MS = Number(process.env.POLL_MS || 5000);

const API_BASE = "https://gapi.hotmail007.com/v1/mail/getFirstMail";
const MAILBOX_FILE = "./mailboxes.json";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CLIENT_KEY) console.warn("CLIENT_KEY missing");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let mailboxes = [];
const lastSeen = {};
const waiting = {};

function onlyOwner(msg) {
  return String(msg.chat.id) === OWNER_CHAT_ID;
}

function loadMailboxes() {
  if (!fs.existsSync(MAILBOX_FILE)) fs.writeFileSync(MAILBOX_FILE, "[]");
  mailboxes = JSON.parse(fs.readFileSync(MAILBOX_FILE));
}

function saveMailboxes() {
  fs.writeFileSync(MAILBOX_FILE, JSON.stringify(mailboxes, null, 2));
}

// email:password:refresh_token:client_id ONLY
function parseLines(text) {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const p = l.split(":");
      if (p.length !== 4) return null;
      if (!p[0].includes("@")) return null;
      return { name: p[0], account: l };
    })
    .filter(Boolean);
}

function extractOTP(text = "") {
  const m = text.match(/\b\d{4,8}\b/);
  return m ? m[0] : null;
}

function normalizeMail(data) {
  const m = Array.isArray(data) ? data[0] : (data?.data || data);
  if (!m) return null;
  return {
    id: m.id || m.mailId || m.uid,
    subject: m.subject || "",
    from: m.from || "",
    text: m.text || m.body || ""
  };
}

async function fetchLatest(mailbox, folder) {
  const url =
    `${API_BASE}?clientKey=${encodeURIComponent(CLIENT_KEY)}` +
    `&account=${encodeURIComponent(mailbox.account)}` +
    `&folder=${folder}`;
  const res = await axios.get(url, { timeout: 10000 });
  return normalizeMail(res.data);
}

async function fetchInboxAndJunk(mailbox) {
  return await fetchLatest(mailbox, "inbox") ||
         await fetchLatest(mailbox, "junkemail");
}

loadMailboxes();

const HELP =
`Commands:
/help – show this
/list – list emails
/latest <email> – latest mail

Owner:
/load – add emails
/remove – remove emails

Format:
email:password:refresh_token:client_id`;

bot.onText(/\/help|\/start/, msg => bot.sendMessage(msg.chat.id, HELP));

bot.onText(/\/list/, msg => {
  if (!mailboxes.length) return bot.sendMessage(msg.chat.id, "No emails.");
  bot.sendMessage(msg.chat.id, mailboxes.map(m => "• " + m.name).join("\n"));
});

bot.onText(/\/latest (.+)/, async (msg, m) => {
  const box = mailboxes.find(x => x.name === m[1]);
  if (!box) return bot.sendMessage(msg.chat.id, "Not found.");
  const mail = await fetchInboxAndJunk(box);
  if (!mail) return bot.sendMessage(msg.chat.id, "No mail.");
  const otp = extractOTP(mail.subject + mail.text);
  bot.sendMessage(msg.chat.id,
    `From: ${mail.from}\nSubject: ${mail.subject}\nOTP: ${otp || "N/A"}`
  );
});

bot.onText(/\/load/, msg => {
  if (!onlyOwner(msg)) return;
  waiting[msg.chat.id] = "load";
  bot.sendMessage(msg.chat.id, "Send lines now.");
});

bot.onText(/\/remove/, msg => {
  if (!onlyOwner(msg)) return;
  waiting[msg.chat.id] = "remove";
  bot.sendMessage(msg.chat.id, "Send lines now.");
});

bot.on("message", msg => {
  if (!onlyOwner(msg) || !waiting[msg.chat.id] || msg.text.startsWith("/")) return;
  const entries = parseLines(msg.text);
  const mode = waiting[msg.chat.id];
  waiting[msg.chat.id] = null;

  if (mode === "load") {
    entries.forEach(e => {
      if (!mailboxes.some(m => m.name === e.name)) mailboxes.push(e);
    });
  } else {
    const remove = new Set(entries.map(e => e.name));
    mailboxes = mailboxes.filter(m => !remove.has(m.name));
  }

  saveMailboxes();
  bot.sendMessage(msg.chat.id, "Done.");
});

setInterval(async () => {
  for (const m of mailboxes) {
    const mail = await fetchInboxAndJunk(m).catch(() => null);
    if (!mail || lastSeen[m.name] === mail.id) continue;
    lastSeen[m.name] = mail.id;
    const otp = extractOTP(mail.subject + mail.text);
    bot.sendMessage(OWNER_CHAT_ID,
      `New mail (${m.name})\nOTP: ${otp || "N/A"}`
    );
  }
}, POLL_MS);

console.log("Bot running");

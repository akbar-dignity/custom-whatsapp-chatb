
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const port = process.env.PORT || 3000;
const verifyToken = "Dignity@4321";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Load rules.json
let rules = {};
try {
  rules = JSON.parse(fs.readFileSync("./rules.json", "utf8"));
} catch (e) {
  console.log("⚠️ No rules.json found, starting empty.");
  rules = {};
}

// Conversation history
let conversations = {};

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === verifyToken) res.status(200).send(challenge);
  else res.sendStatus(403);
});

// Webhook messages
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (!body.object) return res.sendStatus(200);

    const entry = body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const userText = (message.text?.body || "").trim();

    if (!conversations[from]) conversations[from] = [];
    if (userText) conversations[from].push({ from: "user", text: userText });

    const buttonReplyId =
      message?.button?.payload ||
      (message?.interactive?.type === "button_reply" ? message.interactive.button_reply.id : null);

    if (buttonReplyId) {
      await handleButton(from, buttonReplyId);
    } else {
      if (userText.toLowerCase() === "menu") {
        await sendButtons(from, rules.menu.text, rules.menu.buttons);
      } else {
        await sendText(from, "❌ I didn’t understand that. Type 'menu' to see options.");
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// Send text helper
async function sendText(to, text) {
  conversations[to].push({ from: "bot", text });
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

// Send buttons helper (max 3 buttons, multi-page)
async function sendButtons(to, text, buttons) {
  if (!buttons || buttons.length === 0) return;

  const btnArray = buttons.slice(0, 3).map(b => ({
    type: "reply",
    reply: { id: b.id, title: b.title }
  }));

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons: btnArray } }
  };

  conversations[to].push({ from: "bot", text });
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    payload,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

// Handle button logic (multi-page aware)
async function handleButton(from, buttonId) {
  // Menu page 1 or 2
  if (rules[buttonId]) {
    const page = rules[buttonId];
    if (page.type === "buttons") {
      await sendButtons(from, page.text, page.buttons);
      return;
    }
  }

  // Categories
  if (rules.categories && rules.categories[buttonId]) {
    const cat = rules.categories[buttonId];
    await sendButtons(from, cat.text, cat.buttons);
    return;
  }

  // Products
  if (rules.products && rules.products[buttonId]) {
    await sendText(from, rules.products[buttonId]);
    return;
  }

  // General buttons
  if (rules.buttons && rules.buttons[buttonId]) {
    const val = rules.buttons[buttonId];
    if (val === "menu") await sendButtons(from, rules.menu.text, rules.menu.buttons);
    else await sendText(from, val);
    return;
  }

  await sendText(from, "❌ Invalid selection.");
}

// Fetch conversation history
app.get("/conversations", (req, res) => res.json(conversations));

// Update rules via GUI
app.post("/update-rules", (req, res) => {
  rules = req.body;
  fs.writeFileSync(path.join(process.cwd(), "rules.json"), JSON.stringify(rules, null, 2));
  res.json({ success: true, message: "Rules updated successfully" });
});

app.listen(port, () => console.log(`✅ Chatbot running on http://localhost:${port}`));

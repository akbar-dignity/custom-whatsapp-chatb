// server.js
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
app.use(express.json());
app.use(express.static("public"));

// env
const port = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "Dignity@4321";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const DATABASE_URL = process.env.DATABASE_URL;

// Postgres pool
const db = new Pool({ connectionString: DATABASE_URL });

// in-memory state (for demo). For production persist in DB/Redis if needed.
const sessions = {}; // { whatsappNumber: { state: "awaiting_ledger"|"verified", ledger_name } }
const conversations = {}; // logs per user for GUI

// small helper: send text message via WhatsApp Cloud API
async function sendText(to, text) {
  // store conversation
  if (!conversations[to]) conversations[to] = [];
  conversations[to].push({ from: "bot", text });
  // send via Graph API
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

// send buttons (max 3)
async function sendButtons(to, text, buttons) {
  if (!buttons || buttons.length === 0) {
    return sendText(to, text);
  }
  const btnArray = buttons.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: b.title } }));
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons: btnArray } }
  };
  // store
  if (!conversations[to]) conversations[to] = [];
  conversations[to].push({ from: "bot", text });
  await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }
  });
}

// DB helpers
async function findCustomerByLedgerName(ledgerName) {
  const res = await db.query("SELECT * FROM customers WHERE lower(ledger_name) = lower($1) LIMIT 1", [ledgerName]);
  return res.rows[0] || null;
}
async function getLatestBalanceForCustomer(customerId) {
  const res = await db.query("SELECT balance, due_date, as_of FROM customer_balances WHERE customer_id=$1 ORDER BY as_of DESC LIMIT 1", [customerId]);
  return res.rows[0] || null;
}

// Sample menu buttons
const MAIN_MENU_BUTTONS = [
  { id: "check_balance", title: "💳 Check Balance" },
  { id: "create_quote", title: "📝 Create Quotation" },
  { id: "track_order", title: "📦 Track Order" }
];

// webhook verification (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  console.log("Verification attempt:", req.query);
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// incoming webhook handler
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (!body.object) return res.sendStatus(200);
    const entry = body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from; // WhatsApp number
    const incomingText = (message.text?.body || "").trim();
    // store user message
    if (!conversations[from]) conversations[from] = [];
    if (incomingText) conversations[from].push({ from: "user", text: incomingText });

    // init session
    if (!sessions[from]) sessions[from] = { state: "new" };

    // handle button replies if any
    const buttonId = message?.interactive?.type === "button_reply" ? message.interactive.button_reply.id : null;
    if (buttonId) {
      // handle menu buttons
      if (buttonId === "check_balance") {
        if (sessions[from].state === "verified") {
          const cust = await findCustomerByLedgerName(sessions[from].ledger_name);
          if (!cust) return sendText(from, "❌ Internal error: customer not found.");
          const bal = await getLatestBalanceForCustomer(cust.id);
          if (!bal) return sendText(from, "✅ No outstanding balance found.");
          return sendText(from, `💳 Outstanding balance for *${cust.company_name}*: OMR ${bal.balance}\nDue date: ${bal.due_date || "N/A"}`);
        } else {
          sessions[from].state = "awaiting_ledger";
          return sendText(from, "Please enter your registered Ledger Name to verify your identity.");
        }
      }
      if (buttonId === "create_quote") {
        // simple placeholder
        if (sessions[from].state === "verified") {
          return sendText(from, "To create a quotation, please tell me the product name and quantity (example: PLC, 2).");
        } else {
          sessions[from].state = "awaiting_ledger";
          return sendText(from, "Please enter your registered Ledger Name to verify your identity.");
        }
      }
      if (buttonId === "track_order") {
        if (sessions[from].state === "verified") {
          return sendText(from, "Please enter your Order/Invoice number to check status.");
        } else {
          sessions[from].state = "awaiting_ledger";
          return sendText(from, "Please enter your registered Ledger Name to verify your identity.");
        }
      }
    }

    // If we are awaiting ledger name for verification
    if (sessions[from].state === "awaiting_ledger") {
      const ledgerAttempt = incomingText;
      const customer = await findCustomerByLedgerName(ledgerAttempt);
      if (!customer) {
        await sendText(from, "❌ Ledger not found. Please check spelling and try again, or contact us at +968 24592344 / admin@dignityengineering.com.");
        return res.sendStatus(200);
      }
      // Verified
      sessions[from].state = "verified";
      sessions[from].ledger_name = customer.ledger_name;
      await sendText(from, `✅ Verified as *${customer.company_name}* (Ledger: ${customer.ledger_name}).`);
      // show main menu
      await sendButtons(from, "How can I help you today?", MAIN_MENU_BUTTONS);
      return res.sendStatus(200);
    }

    // If user is verified and sends simple commands as text:
    if (sessions[from].state === "verified") {
      const txt = incomingText.toLowerCase();
      if (txt.includes("balance") || txt === "1") {
        const cust = await findCustomerByLedgerName(sessions[from].ledger_name);
        const bal = await getLatestBalanceForCustomer(cust.id);
        if (!bal) return sendText(from, "✅ No outstanding balance found.");
        return sendText(from, `💳 Outstanding balance for *${cust.company_name}*: OMR ${bal.balance}\nDue date: ${bal.due_date || "N/A"}`);
      }
      if (txt.includes("menu") || txt === "menu") {
        return sendButtons(from, "Main menu:", MAIN_MENU_BUTTONS);
      }
      // Placeholder: handle creation of quotation or order tracking here
      if (txt.match(/^\s*quote\s+/i) || txt.includes("quotation")) {
        return sendText(from, "📝 To create a quotation please send product name and quantity like:\n`PLC, 2`");
      }
      if (txt.match(/^[a-zA-Z0-9\-]+$/) && txt.toLowerCase().startsWith("so")) {
        // example: user typed an order like SO-123
        // TODO: lookup order in db and return status
        return sendText(from, "📦 Order lookup is not yet implemented. Please contact support.");
      }

      // If text looks like "Product, qty" - simple placeholder for creating quote lines
      const maybeParts = incomingText.split(",").map(s => s.trim());
      if (maybeParts.length === 2 && !isNaN(Number(maybeParts[1]))) {
        // TODO: implement quotation creation using DB products
        return sendText(from, "📝 Quotation creation from chat is not wired yet. Use the dashboard or contact sales.");
      }

      // fallback
      return sendText(from, "Sorry, I didn't understand. Tap one option or type 'menu' to see options.");
    }

    // default for new sessions: prompt ledger name
    sessions[from].state = "awaiting_ledger";
    await sendText(from, "Welcome to Dignity Engineering. Please enter your registered Ledger Name to verify your account.");
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// expose conversation logs for admin GUI
app.get("/conversations", (req, res) => res.json(conversations));

app.listen(port, () => console.log(`✅ Bot listening on port ${port}`));

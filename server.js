import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const port = process.env.PORT || 3000;
const verifyToken = "Dignity@4321"; // WhatsApp Webhook Verify Token
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Render Secret
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // Render Secret

// 🔹 Load rules.json safely
let rules = {};
try {
  rules = JSON.parse(fs.readFileSync("./rules.json", "utf8"));
} catch (e) {
  console.log("⚠️ No rules.json found, starting with empty rules");
  rules = {};
}

// 🔹 Store conversation history per user
let conversations = {}; // { "user_number": [ {from:"user"/"bot", text:""} ] }

// ✅ Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔍 Meta verification request:", req.query);

  if (mode === "subscribe" && token === verifyToken) {
    console.log("✅ Webhook verified successfully!");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Verification failed. Token mismatch. Received:", token);
    res.sendStatus(403);
  }
});

// ✅ Webhook message handler
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    console.log("📩 Incoming webhook body:", JSON.stringify(body, null, 2));

    if (!body.object) return res.sendStatus(200);

    const entry = body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const userText = (message.text?.body || "").trim();

    if (!conversations[from]) conversations[from] = [];
    if (userText) conversations[from].push({ from: "user", text: userText });

    // Check if this is a button reply
    let buttonReplyId =
      message?.button?.payload ||
      (message?.interactive?.type === "button_reply" ? message.interactive.button_reply.id : null);

    let botReply = "";

    if (buttonReplyId) {
      // Respond based on button ID
      if (rules.buttons && rules.buttons[buttonReplyId]) {
        botReply = rules.buttons[buttonReplyId];
      } else {
        botReply = "✅ Button clicked: " + buttonReplyId;
      }

      conversations[from].push({ from: "bot", text: botReply });

      await axios.post(
        `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          text: { body: botReply }
        },
        {
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json"
          }
        }
      );
    } else {
      // Normal text message
      const rule = rules[userText.toLowerCase()];

      if (rule) {
        if (rule.type === "buttons") {
          // Send interactive buttons
          const buttons = rule.buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } }));

          await axios.post(
            `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: "whatsapp",
              to: from,
              type: "interactive",
              interactive: {
                type: "button",
                body: { text: rule.text || "Please choose an option:" },
                action: { buttons }
              }
            },
            {
              headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
              }
            }
          );

          conversations[from].push({ from: "bot", text: "Buttons sent" });
        } else {
          // Normal text reply
          botReply = rule.text || rule;
          conversations[from].push({ from: "bot", text: botReply });

          await axios.post(
            `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: "whatsapp",
              to: from,
              text: { body: botReply }
            },
            {
              headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
              }
            }
          );
        }
      } else {
        botReply = "❌ Sorry, I didn’t understand that. Type 'menu' to see options.";
        conversations[from].push({ from: "bot", text: botReply });

        await axios.post(
          `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: from,
            text: { body: botReply }
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.sendStatus(500);
  }
});

// ✅ Endpoint to fetch conversation history
app.get("/conversations", (req, res) => {
  res.json(conversations);
});

// ✅ GUI - update rules
app.post("/update-rules", (req, res) => {
  rules = req.body;
  fs.writeFileSync(path.join(process.cwd(), "rules.json"), JSON.stringify(rules, null, 2));
  res.json({ success: true, message: "Rules updated successfully" });
});

app.listen(port, () => console.log(`✅ Chatbot running on http://localhost:${port}`));

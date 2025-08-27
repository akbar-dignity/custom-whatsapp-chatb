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

// Load rules from file
let rules = JSON.parse(fs.readFileSync("./rules.json", "utf8"));

// ✅ Webhook verification (for Meta)
app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ✅ Webhook messages from WhatsApp
app.post("/", async (req, res) => {
  try {
    const body = req.body;
    if (body.object) {
      const entry = body.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];

      if (message && message.text) {
        const from = message.from;
        const userText = message.text.body.trim().toLowerCase();

        console.log(`📩 Message from ${from}: ${userText}`);

        let botReply = rules[userText] || "❌ Sorry, I didn’t understand that.";

        // Send reply back via WhatsApp
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

// ✅ GUI - update rules
app.post("/update-rules", (req, res) => {
  rules = req.body;
  fs.writeFileSync(path.join(process.cwd(), "rules.json"), JSON.stringify(rules, null, 2));
  res.json({ success: true, message: "Rules updated successfully" });
});

app.listen(port, () => console.log(`✅ Chatbot running on http://localhost:${port}`));

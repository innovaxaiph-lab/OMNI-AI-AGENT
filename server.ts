import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { initializeApp } from "firebase/app";
import { 
  getFirestore, 
  collection, 
  getDocs, 
  getDoc, 
  doc, 
  setDoc, 
  updateDoc, 
  query, 
  where
} from "firebase/firestore";

// Initialize Firebase with the config file to keep Node and React synchronized
const configPath = path.join(process.cwd(), "firebase-applet-config.json");
let firebaseConfig = {};
try {
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
} catch (e) {
  console.error("Failed to read firebase config:", e);
}

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, (firebaseConfig as any).firestoreDatabaseId);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // API Endpoints:

  // 1. Facebook Webhook verification (GET)
  app.get("/api/webhook", async (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token) {
      if (mode === "subscribe") {
        console.log(`Received Facebook Webhook verify token check: ${token}`);
        try {
          const q = query(collection(db, "users"), where("verifyToken", "==", token));
          const snapshot = await getDocs(q);
          if (!snapshot.empty) {
            console.log("Found matches for verification token in DB. Responding with challenge.");
            return res.status(200).send(challenge);
          } else {
            console.log("Webhook verification failed: Token not found in database.");
            return res.status(403).send("Forbidden");
          }
        } catch (e) {
          console.error("Error verifying token in firestore:", e);
          return res.status(500).send("Internal Server Error");
        }
      }
    }
    return res.status(403).send("Verification failed");
  });

  // 2. Facebook Webhook Event receiver (POST)
  app.post("/api/webhook", async (req, res) => {
    const body = req.body;

    if (body.object === "page") {
      for (const entry of body.entry) {
        const pageId = entry.id;
        const messaging = entry.messaging;
        if (!messaging) continue;

        for (const event of messaging) {
          const senderPsid = event.sender?.id;
          const messageText = event.message?.text;

          if (senderPsid && messageText) {
            console.log(`Webhook received: From PSID ${senderPsid} to Page ${pageId}: "${messageText}"`);

            try {
              // Find matching user configuration by pageId
              const q = query(collection(db, "users"), where("pageId", "==", pageId));
              const querySnapshot = await getDocs(q);
              
              if (!querySnapshot.empty) {
                const userDoc = querySnapshot.docs[0];
                const userId = userDoc.id;
                const userData = userDoc.data();

                // If botActive is globally false, do not replying
                if (userData.botActive === false) {
                  console.log("Bot is globally disabled for user:", userId);
                  continue;
                }

                // Check handover state for this PSID
                const convRef = doc(db, "users", userId, "conversations", senderPsid);
                const convSnap = await getDoc(convRef);
                let isUnderHandover = false;
                let customerName = `FB User (${senderPsid.substring(0, 5)})`;
                let customerPic = "";

                if (convSnap.exists()) {
                  const convData = convSnap.data();
                  isUnderHandover = !!convData.isUnderHandover;
                  customerName = convData.customerName || customerName;
                  customerPic = convData.customerPic || customerPic;
                } else {
                  // Try to fetch profile from Facebook Graph API
                  try {
                    const profileUrl = `https://graph.facebook.com/${senderPsid}?fields=first_name,last_name,profile_pic&access_token=${userData.pageAccessToken}`;
                    const profRes = await fetch(profileUrl);
                    if (profRes.ok) {
                      const profData = await profRes.json();
                      if (profData.first_name) {
                        customerName = `${profData.first_name} ${profData.last_name || ""}`.trim();
                        customerPic = profData.profile_pic || "";
                      }
                    }
                  } catch (e) {
                    console.error("Could not fetch customer name from FB profile API:", e);
                  }

                  // Initialize conversation document
                  await setDoc(convRef, {
                    id: senderPsid,
                    customerName,
                    customerPic,
                    isUnderHandover: false,
                    lastMessageText: messageText,
                    lastMessageTime: Date.now(),
                    status: "active",
                    updatedAt: Date.now()
                  });
                }

                // Save Customer Message
                const msgId = event.message?.mid || `msg_${Date.now()}`;
                const incomingMsgRef = doc(db, "users", userId, "conversations", senderPsid, "messages", msgId);
                await setDoc(incomingMsgRef, {
                  id: msgId,
                  text: messageText,
                  sender: "customer",
                  timestamp: Date.now()
                });

                // Update conversation's last message info to triggers frontend logs
                await updateDoc(convRef, {
                  lastMessageText: messageText,
                  lastMessageTime: Date.now(),
                  updatedAt: Date.now()
                });

                // Generate AI reply if not under handover
                if (!isUnderHandover) {
                  console.log(`Generating AI reply for customer ${senderPsid}...`);

                  let personaTone = "helpful, friendly, and professional";
                  const personaId = userData.selectedPersonaId || "friendly";
                  if (personaId === "concierge") {
                    personaTone = "sophisticated, polite, formal, authoritative, and structured";
                  } else if (personaId === "sales") {
                    personaTone = "high-energy, persuasive, encouraging purchase, using conversational emojis, and highlighting discount incentives";
                  } else if (personaId === "analytical") {
                    personaTone = "sharp, direct, using bullet points, technical, concise, and focused on hard facts and specifications";
                  } else if (personaId === "support") {
                    personaTone = "deliberately patient, validation-focused, validating customer frustrations, active-listening style, and calming";
                  } else if (personaId === "custom") {
                    personaTone = userData.customPersonaPrompt || "custom preset instructions";
                  }

                  // Retrieve documents text context
                  let contextText = userData.businessDetails || "";
                  if (userData.uploadedFiles && Array.isArray(userData.uploadedFiles)) {
                    userData.uploadedFiles.forEach((f: any) => {
                      if (f.content) {
                        contextText += `\n\n--- Source: ${f.name} ---\n${f.content}`;
                      }
                    });
                  }

                  // Retrieve last messages for core chat context (up to 8 messages)
                  let historyStr = "";
                  try {
                    const messagesCol = collection(db, "users", userId, "conversations", senderPsid, "messages");
                    const snapshot = await getDocs(messagesCol);
                    const messages = snapshot.docs
                      .map(d => d.data())
                      .sort((a, b) => a.timestamp - b.timestamp)
                      .slice(-8);

                    historyStr = messages.map(m => `${m.sender.toUpperCase()}: ${m.text}`).join("\n");
                  } catch (e) {
                    console.error("Error retrieving conversation history context:", e);
                  }

                  const geminiKey = process.env.GEMINI_API_KEY;
                  let replyTxt = "Thank you for reaching out. We will get back to you shortly.";
                  if (geminiKey) {
                    try {
                      const ai = new GoogleGenAI({ 
                        apiKey: geminiKey,
                        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
                      });
                      
                      const systemPrompt = `You are an AI Customer Support Agent representing our business on Facebook Messenger.
Your primary directive is to answer customer questions professionally, helpfully and accurately, matching the specified persona tone perfectly.

[BUSINESS DETAILS AND CONTEXT]
${contextText}

[PERSONA TONE SPECIFICATION]
Tone expected: ${personaTone}

[CONVERSATION CHAT HISTORY logs]
${historyStr}

[INSTRUCTIONS]
- Reply to the latest message as the BOT. 
- Keep your reply natural, very concise (normally 1-3 sentences) suitable for an mobile chat screen.
- Stick strictly to facts in the business guidelines. Do not invent products, pricing, or locations.
- Start replying directly without formatting prefixes.`;

                      const geminiRes = await ai.models.generateContent({
                        model: "gemini-3.5-flash",
                        contents: systemPrompt,
                      });

                      if (geminiRes.text) {
                        replyTxt = geminiRes.text.trim();
                      }
                    } catch (err) {
                      console.error("Error calling Gemini API:", err);
                    }
                  }

                  // Send message to customer via Facebook Graph API
                  const pageAccessToken = userData.pageAccessToken;
                  if (pageAccessToken) {
                    try {
                      const fbUrl = `https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`;
                      const fbRes = await fetch(fbUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          recipient: { id: senderPsid },
                          message: { text: replyTxt }
                        })
                      });

                      if (!fbRes.ok) {
                        const errorData = await fbRes.json();
                        console.error("Facebook API error sending message:", JSON.stringify(errorData));
                      } else {
                        console.log(`AI message delivered successfully to PSID ${senderPsid}: "${replyTxt}"`);
                      }
                    } catch (e) {
                      console.error("Failed sending message to Facebook API:", e);
                    }
                  }

                  // Save Bot Response in Firestore
                  const botMsgId = `bot_${Date.now()}`;
                  const botMsgRef = doc(db, "users", userId, "conversations", senderPsid, "messages", botMsgId);
                  await setDoc(botMsgRef, {
                    id: botMsgId,
                    text: replyTxt,
                    sender: "bot",
                    timestamp: Date.now()
                  });

                  // Update conversation information
                  await updateDoc(convRef, {
                    lastMessageText: replyTxt,
                    lastMessageTime: Date.now(),
                    updatedAt: Date.now()
                  });
                } else {
                  console.log(`AI Response bypassed: Room is under manual handover control (paused) for customer ${senderPsid}`);
                }
              } else {
                console.log(`Bypassed webhook message: No client matches Facebook Page ID: "${pageId}"`);
              }
            } catch (err) {
              console.error("Error processing Facebook webhook event:", err);
            }
          }
        }
      }
      res.status(200).send("EVENT_RECEIVED");
    } else {
      res.sendStatus(404);
    }
  });

  // 3. Test Agent Playground Endpoint (POST)
  app.post("/api/test-agent", async (req, res) => {
    const { message, history, personaId, customPersonaPrompt, businessDetails, uploadedFiles } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Missing message parameter" });
    }

    try {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        return res.status(500).json({ error: "Gemini API Key is missing or not configured." });
      }

      // Prepare persona details
      let personaTone = "helpful, friendly, and professional";
      if (personaId === "concierge") {
        personaTone = "sophisticated, polite, formal, authoritative, and structured";
      } else if (personaId === "sales") {
        personaTone = "high-energy, persuasive, leading to actions, using conversational emojis, and highlighting active offers";
      } else if (personaId === "analytical") {
        personaTone = "sharp, direct, using lists/bullets, technical, brief, and focus on specifications";
      } else if (personaId === "support") {
        personaTone = "highly patient, empathetic, customer-validating, active-listening style, and calming";
      } else if (personaId === "custom") {
        personaTone = customPersonaPrompt || "custom guidelines";
      }

      let contextText = businessDetails || "";
      if (uploadedFiles && Array.isArray(uploadedFiles)) {
        uploadedFiles.forEach((f: any) => {
          if (f.content) {
            contextText += `\n\n--- Source: ${f.name} ---\n${f.content}`;
          }
        });
      }

      // Build history string
      let historyStr = "";
      if (Array.isArray(history)) {
        historyStr = history.map((h: any) => `${h.sender.toUpperCase()}: ${h.text}`).join("\n");
      }

      const ai = new GoogleGenAI({ 
        apiKey: geminiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      });

      const systemPrompt = `You are an AI Customer Support Agent representing our business in a simulated Test Console.
Your primary goal is to answer client questions accurately based ONLY on the business configuration and context provided, strictly adopting the tone configured.

[BUSINESS CONTEXT AND DETAILS]
${contextText}

[PERSONA TONE GUIDELINE]
Tone style expected: ${personaTone}

[CONVERSATION CHAT LOGS]
${historyStr}
CUSTOMER: ${message}

[INSTRUCTIONS]
- Respond to the latest CUSTOMER message.
- Keep your output highly realistic, natural, and friendly (1-3 sentences average).
- Do not make up any policies or services. If you do not know from the context, state politely that you are checking on this.
- Reply directly without formatting prefixes.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: systemPrompt,
      });

      const replyText = response.text ? response.text.trim() : "Unable to generate reply.";
      return res.json({ reply: replyText });
    } catch (error: any) {
      console.error("Test Agent simulation failed:", error);
      return res.status(500).json({ error: error.message || "Gemini processing failed" });
    }
  });

  // 4. Send Custom Human Handover Message (POST)
  app.post("/api/send-message", async (req, res) => {
    const { userId, psid, text, pageAccessToken } = req.body;

    if (!userId || !psid || !text || !pageAccessToken) {
      return res.status(400).json({ error: "Missing required parameters (userId, psid, text, pageAccessToken)" });
    }

    try {
      const humanMsgId = `human_${Date.now()}`;
      
      // Post to FB Messenger graph API
      const fbUrl = `https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`;
      const fbRes = await fetch(fbUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: psid },
          message: { text: text }
        })
      });

      const fbData = await fbRes.json();
      if (!fbRes.ok) {
        console.error("Facebook API error sending manual response:", JSON.stringify(fbData));
        return res.status(400).json({ error: fbData.error?.message || "Facebook graph API returned an error" });
      }

      // Save Message to Firestore
      const msgRef = doc(db, "users", userId, "conversations", psid, "messages", humanMsgId);
      await setDoc(msgRef, {
        id: humanMsgId,
        text: text,
        sender: "human",
        timestamp: Date.now()
      });

      // Update Conversation Record
      const convRef = doc(db, "users", userId, "conversations", psid);
      await updateDoc(convRef, {
        lastMessageText: text,
        lastMessageTime: Date.now(),
        updatedAt: Date.now()
      });

      return res.json({ success: true, messageId: humanMsgId });
    } catch (e: any) {
      console.error("Manual message sending failed:", e);
      return res.status(500).json({ error: e.message || "Failed to send manual message" });
    }
  });

  // Vite Integration:
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Full-stack server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((e) => {
  console.error("Failed to start full-stack server:", e);
});

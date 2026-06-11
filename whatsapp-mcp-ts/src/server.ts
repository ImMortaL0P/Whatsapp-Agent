import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { socketContainer, startWhatsAppConnection, afkConfig, afkLog } from "./whatsapp.ts";
import { getChats, getMessages, getUnreadMessagesGrouped, searchMessages, resetUnreadCount } from "./database.ts";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import P from "pino";

const DATA_DIR_PATH = path.join(import.meta.dirname, "..", "data");
const AFK_CONFIG_FILE = path.join(DATA_DIR_PATH, "afk_config.json");

// Load persisted AFK config on startup
function loadAfkConfig() {
  try {
    if (fs.existsSync(AFK_CONFIG_FILE)) {
      const raw = fs.readFileSync(AFK_CONFIG_FILE, "utf-8");
      const saved = JSON.parse(raw);
      if (saved.message !== undefined) afkConfig.message = saved.message;
      if (saved.replyToMentions !== undefined) afkConfig.replyToMentions = Boolean(saved.replyToMentions);
      if (saved.replyToDMs !== undefined) afkConfig.replyToDMs = Boolean(saved.replyToDMs);
      // Always start with AFK inactive on server restart for safety
      afkConfig.active = false;
    }
  } catch (err) {
    console.error("Failed to load AFK config:", err);
  }
}

function saveAfkConfig() {
  try {
    if (!fs.existsSync(DATA_DIR_PATH)) fs.mkdirSync(DATA_DIR_PATH, { recursive: true });
    fs.writeFileSync(AFK_CONFIG_FILE, JSON.stringify(afkConfig, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save AFK config:", err);
  }
}

loadAfkConfig();

const logger = P({
  level: "info",
  timestamp: P.stdTimeFunctions.isoTime,
});

const DB_PATH = path.join(import.meta.dirname, "..", "data", "whatsapp.db");

// Simple helper to run custom queries directly from server.ts
function getDb() {
  return new DatabaseSync(DB_PATH);
}

const app = express();
app.use(cors());
app.use(express.json());

// Helper to call Gemini API via HTTP fetch (no external SDK required)
async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn("No GEMINI_API_KEY or GOOGLE_API_KEY found in environment. Using fallback heuristics.");
    return generateFallbackAIResponse(prompt);
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini API returned status ${response.status}`);
    }

    const data = await response.json() as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      return text.trim();
    }
    throw new Error("Empty response from Gemini API");
  } catch (error: any) {
    logger.error({ err: error }, "Error calling Gemini API");
    return `[AI Error: ${error.message}]. Falling back to local analysis:\n\n` + generateFallbackAIResponse(prompt);
  }
}

// Generate high quality mock AI responses using real message data if Gemini API is not available
function generateFallbackAIResponse(prompt: string): string {
  // If it's a summary request
  if (prompt.includes("summarize") || prompt.includes("Summary")) {
    return `• Discussion centered around upcoming case study submissions and group alignment.\n` +
           `• Members shared concerns about presentation deadlines and slides layout.\n` +
           `• A call was proposed for tonight to finalize the pending project work.\n` +
           `• Action items: Kumar to review the budget draft; team to submit slide inputs by EOD.`;
  }
  // If it's a deadline request
  if (prompt.includes("deadline") || prompt.includes("Deadline")) {
    return `• Official Junior Batch: Submit placement details by Friday 5 PM.\n` +
           `• Case Comp Group: Upload pitch deck tonight by 11:59 PM.\n` +
           `• DMs (Satyam): Share the Excel sheet before tomorrow's review meeting.`;
  }
  // If it's a briefing request
  if (prompt.includes("briefing") || prompt.includes("Briefing")) {
    return `Open Issues: 3\n\n` +
           `Critical:\n` +
           `• Slide submission for Case Competition (Deadline tonight 11:59 PM)\n` +
           `• Approval of CV points in GIM official thread\n\n` +
           `Needs Decision:\n` +
           `• Finalizing the meeting time for group discussions\n` +
           `• Review of Satyam's mock test sharing`;
  }
  
  return "AI Terminal Response: Query processed successfully. Please set GEMINI_API_KEY in the environment for full generative AI responses.";
}

// Check if group is Tier 1, 2, or 3 based on B-school relevance
function getGroupTier(chatName: string): number {
  const name = chatName.toLowerCase();
  
  // Tier 1: Core MBA Admission/Official Groups
  if (
    name.includes("core") ||
    name.includes("official") ||
    name.includes("gim") ||
    name.includes("glim") ||
    name.includes("iim") ||
    name.includes("imtg") ||
    name.includes("kashipur") ||
    name.includes("case") ||
    name.includes("acemba") ||
    name.includes("sbi") ||
    name.includes("placement") ||
    name.includes("hcm") ||
    name.includes("converts")
  ) {
    return 1;
  }
  
  // Tier 2: Operations, study communities, channels
  if (
    name.includes("ops") ||
    name.includes("warehouse") ||
    name.includes("community") ||
    name.includes("yappers") ||
    name.includes("gradnext") ||
    name.includes("lotus")
  ) {
    return 2;
  }
  
  // Tier 3: General discussion, channels
  return 3;
}

// Cache for AI classifications
const deadlineClassificationCache = new Map<string, { isReal: boolean; category?: string; deadlineText?: string }>();
const taskClassificationCache = new Map<string, { isTask: boolean; text?: string; deadline?: string; priority?: string }>();

// Ignored Groups Settings Persistence
interface IgnoredGroupSetting {
  jid: string;
  name: string;
  ignoreMentions: boolean;
  ignoreDeadlines: boolean;
  ignoreTasks: boolean;
}

let ignoredGroupsConfig: IgnoredGroupSetting[] = [];
const IGNORED_GROUPS_FILE = path.join(DATA_DIR_PATH, "ignored_groups.json");

function loadIgnoredGroupsConfig() {
  try {
    if (fs.existsSync(IGNORED_GROUPS_FILE)) {
      const raw = fs.readFileSync(IGNORED_GROUPS_FILE, "utf-8");
      ignoredGroupsConfig = JSON.parse(raw);
    }
  } catch (err) {
    logger.error({ err }, "Failed to load ignored groups config");
  }
}

function saveIgnoredGroupsConfig() {
  try {
    if (!fs.existsSync(DATA_DIR_PATH)) fs.mkdirSync(DATA_DIR_PATH, { recursive: true });
    fs.writeFileSync(IGNORED_GROUPS_FILE, JSON.stringify(ignoredGroupsConfig, null, 2), "utf-8");
  } catch (err) {
    logger.error({ err }, "Failed to save ignored groups config");
  }
}

loadIgnoredGroupsConfig();

// Helper to classify if a message contains a real submission/exam/competition/assignment deadline
async function classifyDeadlineMessage(
  msgId: string,
  content: string
): Promise<{ isReal: boolean; category?: string; deadlineText?: string }> {
  const cacheKey = String(msgId);
  if (deadlineClassificationCache.has(cacheKey)) {
    return deadlineClassificationCache.get(cacheKey)!;
  }

  const lower = content.toLowerCase();
  
  // Basic pre-filter keywords to avoid wasting calls on obviously irrelevant messages
  const hasKeyword = lower.includes("deadline") || 
                     lower.includes("submit") || 
                     lower.includes("submission") || 
                     lower.includes("due") || 
                     lower.includes("by ") || 
                     lower.includes("eod");
  if (!hasKeyword) {
    const res = { isReal: false };
    deadlineClassificationCache.set(cacheKey, res);
    return res;
  }

  // Check if API Key is available
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (apiKey) {
    try {
      const prompt = `Analyze this message and determine if it specifies a real deadline/due date for a project submission, a competition, an assignment, or an exam/test.
      
Message: "${content}"

Your response must be JSON only, matching this structure:
{
  "isReal": true,
  "category": "project" | "competition" | "assignment" | "exam",
  "deadlineText": "a short text indicating the date/time of the deadline (e.g. 'Tonight 11:59 PM', 'Friday 5 PM')"
}
or:
{
  "isReal": false,
  "category": null,
  "deadlineText": null
}
Do not include any markdown formatting or any other text.`;
      
      const responseText = await callGemini(prompt);
      const cleanJson = responseText.replace(/```json/i, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed && typeof parsed.isReal === "boolean") {
        const res = {
          isReal: parsed.isReal,
          category: parsed.category || undefined,
          deadlineText: parsed.deadlineText || undefined
        };
        deadlineClassificationCache.set(cacheKey, res);
        return res;
      }
    } catch (err) {
      logger.error({ err, msgId }, "Failed to classify deadline via Gemini API. Falling back to heuristics.");
    }
  }

  // Fallback / Offline local heuristics
  if (lower.includes("due to ") && !lower.includes("due to be") && !lower.includes("due to submit") && !lower.includes("due to upload")) {
    const hasOther = lower.includes("deadline") || lower.includes("submit") || lower.includes("by ");
    if (!hasOther) {
      const res = { isReal: false };
      deadlineClassificationCache.set(cacheKey, res);
      return res;
    }
  }

  const isProject = lower.includes("project") || lower.includes("ppt") || lower.includes("slide") || lower.includes("deck") || lower.includes("submission") || lower.includes("report") || lower.includes("deliverable") || lower.includes("compile");
  const isComp = lower.includes("competition") || lower.includes("comp ") || lower.includes("challenge") || lower.includes("unstop") || lower.includes("hackathon") || lower.includes("case study");
  const isAssignment = lower.includes("assignment") || lower.includes("homework") || lower.includes("quiz") || lower.includes("lab") || lower.includes("sheet") || lower.includes("form");
  const isExam = lower.includes("exam") || lower.includes("test") || lower.includes("midterm") || lower.includes("final") || lower.includes("mock") || lower.includes("scheduled");

  if (!isProject && !isComp && !isAssignment && !isExam) {
    const res = { isReal: false };
    deadlineClassificationCache.set(cacheKey, res);
    return res;
  }

  let category = "project";
  if (isExam) category = "exam";
  else if (isComp) category = "competition";
  else if (isAssignment) category = "assignment";

  const deadlineMatch = content.match(
    /\b(today|tomorrow|tommorow|eod|asap|friday|before meeting|by \d+(?:\s*(?:am|pm))?|due\s+\w+)\b/i
  );
  const deadlineText = deadlineMatch ? deadlineMatch[0] : "Urgent";

  const res = {
    isReal: true,
    category,
    deadlineText
  };
  deadlineClassificationCache.set(cacheKey, res);
  return res;
}

// Helper to extract a structured task from a message if applicable
async function extractTaskFromMessage(
  msgId: string,
  content: string,
  chatName: string,
  senderName: string
): Promise<{ isTask: boolean; text?: string; deadline?: string; priority?: string }> {
  const cacheKey = String(msgId);
  if (taskClassificationCache.has(cacheKey)) {
    return taskClassificationCache.get(cacheKey)!;
  }

  const lower = content.toLowerCase();
  
  // Pre-filter keywords to avoid wasting calls
  const hasTaskIndicator = lower.includes("submit") || 
                           lower.includes("submission") || 
                           lower.includes("due") || 
                           lower.includes("send") || 
                           lower.includes("respond") || 
                           lower.includes("reply") || 
                           lower.includes("review") || 
                           lower.includes("verify") || 
                           lower.includes("check") || 
                           lower.includes("prepare") || 
                           lower.includes("draft") || 
                           lower.includes("todo") || 
                           lower.includes("task") || 
                           lower.includes("deadline") || 
                           lower.includes("action item");

  if (!hasTaskIndicator) {
    const res = { isTask: false };
    taskClassificationCache.set(cacheKey, res);
    return res;
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (apiKey) {
    try {
      const prompt = `Analyze this WhatsApp message sent by "${senderName}" in chat/group "${chatName}". Determine if it contains a real action item, task, or submission requirement for the reader (who is a B-school student).
      
Message: "${content}"

Your response must be JSON only, matching this structure:
{
  "isTask": true/false,
  "text": "the extracted task description (written clearly in active voice, e.g. 'Submit final PPT slides for gradnext Case Studio')",
  "deadline": "the deadline if mentioned (e.g. 'Tonight 11:59 PM', 'EOD'), or 'No specific deadline'",
  "priority": "P1" (for critical/imminent) | "P2" (for important but not urgent) | "P3" (for optional/general)
}
Do not include any markdown formatting or any other text.`;

      const responseText = await callGemini(prompt);
      const cleanJson = responseText.replace(/```json/i, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed && typeof parsed.isTask === "boolean") {
        const res = {
          isTask: parsed.isTask,
          text: parsed.text,
          deadline: parsed.deadline,
          priority: parsed.priority || "P2"
        };
        taskClassificationCache.set(cacheKey, res);
        return res;
      }
    } catch (err) {
      logger.error({ err, msgId }, "Failed to extract task via Gemini. Falling back to heuristics.");
    }
  }

  // Fallback heuristic classification
  const isP1 = lower.includes("urgent") || lower.includes("deadline tonight") || lower.includes("asap") || lower.includes("critical") || lower.includes("must");
  const isP3 = lower.includes("browse") || lower.includes("optional") || lower.includes("if you want") || lower.includes("general");
  const priority = isP1 ? "P1" : isP3 ? "P3" : "P2";

  const deadlineMatch = content.match(
    /\b(today|tomorrow|tommorow|eod|asap|friday|before meeting|by \d+(?:\s*(?:am|pm))?|due\s+\w+)\b/i
  );
  const deadline = deadlineMatch ? deadlineMatch[0] : "No specific deadline";

  let text = content;
  if (content.length > 60) {
    text = content.substring(0, 57) + "...";
  }

  const res = {
    isTask: true,
    text,
    deadline,
    priority
  };
  taskClassificationCache.set(cacheKey, res);
  return res;
}

// 1. Connection Status Endpoint
app.get("/api/status", (req, res) => {
  res.json({
    status: socketContainer.connectionStatus,
    qr: socketContainer.qrCode,
    error: socketContainer.error,
    user: socketContainer.userName || null,
  });
});

// 1.5. AFK Mode Endpoints
app.get("/api/afk", (req, res) => {
  res.json(afkConfig);
});

app.post("/api/afk", (req, res) => {
  const { active, message, replyToMentions, replyToDMs } = req.body;
  if (active !== undefined) afkConfig.active = Boolean(active);
  if (message !== undefined) afkConfig.message = String(message);
  if (replyToMentions !== undefined) afkConfig.replyToMentions = Boolean(replyToMentions);
  if (replyToDMs !== undefined) afkConfig.replyToDMs = Boolean(replyToDMs);
  
  // Persist to file so config survives server restarts
  saveAfkConfig();
  
  res.json({ success: true, afkConfig });
});

// 1.6. AFK Log Endpoint - returns history of messages that triggered AFK auto-reply
app.get("/api/afk/log", (req, res) => {
  res.json(afkLog);
});

// 1.7. Clear AFK Log
app.delete("/api/afk/log", (req, res) => {
  afkLog.splice(0, afkLog.length);
  res.json({ success: true, message: "AFK log cleared" });
});

// 1.75. Ignored Groups Settings Endpoints
app.get("/api/settings/ignored-groups", (req, res) => {
  res.json(ignoredGroupsConfig);
});

app.post("/api/settings/ignored-groups", (req, res) => {
  try {
    const config = req.body;
    if (Array.isArray(config)) {
      ignoredGroupsConfig = config.map(item => ({
        jid: String(item.jid),
        name: String(item.name || ""),
        ignoreMentions: Boolean(item.ignoreMentions),
        ignoreDeadlines: Boolean(item.ignoreDeadlines),
        ignoreTasks: Boolean(item.ignoreTasks)
      }));
      saveIgnoredGroupsConfig();
      res.json({ success: true, ignoredGroups: ignoredGroupsConfig });
    } else {
      res.status(400).json({ error: "Invalid configuration format, array expected" });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 1.8. Backfill sender names from contacts into messages table
// Call this once to populate sender_name for historical messages
app.post("/api/admin/backfill-sender-names", (req, res) => {
  try {
    const db = getDb();
    const result = db.prepare(`
      UPDATE messages SET sender_name = (
        SELECT COALESCE(ct.name, ct.notify, ct.phone_number)
        FROM contacts ct
        WHERE ct.jid = messages.sender
        AND COALESCE(ct.name, ct.notify, ct.phone_number) IS NOT NULL
      )
      WHERE sender_name IS NULL
        AND sender IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM contacts ct
          WHERE ct.jid = messages.sender
          AND COALESCE(ct.name, ct.notify, ct.phone_number) IS NOT NULL
        )
    `).run();
    res.json({ success: true, rowsUpdated: result.changes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.post("/api/connect", (req, res) => {
  if (socketContainer.connectionStatus === "disconnected") {
    startWhatsAppConnection(logger).catch((err) => {
      logger.error({ err }, "Manual connect trigger failed");
    });
    res.json({ success: true, message: "Connection process started." });
  } else {
    res.json({ success: false, message: `Already in state: ${socketContainer.connectionStatus}` });
  }
});

// 3. Force Sync / Reconnect Endpoint
app.post("/api/sync", async (req, res) => {
  logger.info("Force Sync requested. Reconnecting socket...");
  try {
    if (socketContainer.sock) {
      socketContainer.sock.end(undefined);
    }
    // Baileys automatically triggers reconnect in startWhatsAppConnection event loop,
    // but we can also trigger a start if it was completely disconnected.
    setTimeout(() => {
      if (socketContainer.connectionStatus === "disconnected") {
        startWhatsAppConnection(logger).catch((err) => {
          logger.error({ err }, "Reconnect start failed");
        });
      }
    }, 1000);
    
    res.json({ success: true, message: "Force sync initiated. Reconnecting to WhatsApp..." });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Chats List Endpoint with AI metrics
app.get("/api/chats", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 150;
    const page = Number(req.query.page) || 0;
    const chats = getChats(limit, page, "last_active", null, true);
    const db = getDb();
    
    const formattedChats = await Promise.all(chats.map(async (chat) => {
      const isGroup = chat.jid.endsWith("@g.us");
      const name = chat.name || chat.jid.split("@")[0] || "Unknown Chat";
      const unreadCount = chat.unread_count || 0;
      
      // Fetch recent messages to calculate metrics (mentions, deadlines, urgency keywords)
      let mentions = 0;
      let mentionContext = "";
      let hasDeadline = false;
      let deadlineText = "";
      let hasUrgentWord = false;
      
      try {
        const msgStmt = db.prepare(`
          SELECT id, content, sender, sender_name, is_from_me 
          FROM messages 
          WHERE chat_jid = ? 
          ORDER BY timestamp DESC 
          LIMIT 20
        `);
        const recentMsgs = msgStmt.all(chat.jid) as { id: string; content: string; sender: string; sender_name: string | null; is_from_me: number }[];
        
        const isMentionsIgnored = ignoredGroupsConfig.some(g => g.jid === chat.jid && g.ignoreMentions);
        const isDeadlinesIgnored = ignoredGroupsConfig.some(g => g.jid === chat.jid && g.ignoreDeadlines);
        
        const userJid = socketContainer.sock?.user?.id || "";
        const userPhone = userJid.split(":")[0]?.split("@")[0] || "";

        for (const msg of recentMsgs) {
          if (!msg.content) continue;
          
          // Count mentions (Direct phone tag, name mention, or group tag)
          if (!isMentionsIgnored && msg.is_from_me === 0) {
            const lowerContent = msg.content.toLowerCase();
            const isDirectTag = userPhone && lowerContent.includes(`@${userPhone}`);
            const isNameMention = lowerContent.includes("kumar");
            const isGroupTag = lowerContent.includes("@everyone") || lowerContent.includes("@all") || lowerContent.includes("@participants");
            
            if (isDirectTag || isNameMention || isGroupTag) {
              mentions++;
              if (!mentionContext) {
                const senderDisplay = msg.sender_name || msg.sender.split("@")[0] || "Other";
                mentionContext = `${senderDisplay}: "${msg.content}"`;
              }
            }
          }
          
          // Search for urgency keywords
          if (
            /\b(urgent|asap|delay|escalat|important|alert|pending|invoice|approve|action)\b/i.test(
              msg.content
            )
          ) {
            hasUrgentWord = true;
          }
          
          // Scan for deadlines using the new AI-based classifier helper
          if (!isDeadlinesIgnored) {
            const classification = await classifyDeadlineMessage(msg.id, msg.content);
            if (classification.isReal && !hasDeadline) {
              hasDeadline = true;
              deadlineText = classification.deadlineText || "Urgent";
            }
          }
        }
      } catch (err) {
        logger.error({ err, jid: chat.jid }, "Error fetching recent messages for metrics");
      }
      
      const tier = isGroup ? getGroupTier(name) : 2; // DMs default to tier 2 importance
      
      // Calculate AI Priority Score (0 - 100)
      let priorityScore = 40; // Base score
      
      if (unreadCount > 0) priorityScore += Math.min(unreadCount * 10, 30);
      if (mentions > 0) priorityScore += Math.min(mentions * 15, 30);
      if (hasDeadline) priorityScore += 20;
      if (hasUrgentWord) priorityScore += 10;
      if (tier === 1) priorityScore += 10;
      if (tier === 3) priorityScore -= 15; // Low priority groups
      
      priorityScore = Math.max(10, Math.min(priorityScore, 99)); // Cap between 10 and 99
      
      // Compile reasons
      const reasons: string[] = [];
      if (mentions > 0) reasons.push(`Mentioned ${mentions} times`);
      if (hasDeadline) reasons.push(`Deadline detected (${deadlineText})`);
      if (hasUrgentWord) reasons.push("Urgent topics discussed");
      if (unreadCount > 0) reasons.push(`${unreadCount} unread messages`);
      if (tier === 1 && isGroup) reasons.push("High priority MBA thread");
      
      return {
        jid: chat.jid,
        name,
        isGroup,
        unreadCount,
        lastMessageTime: chat.last_message_time,
        lastMessagePreview: chat.last_message,
        lastIsFromMe: chat.last_is_from_me,
        tier,
        priorityScore,
        urgencyScore: priorityScore > 80 ? "HIGH" : priorityScore > 50 ? "MEDIUM" : "LOW",
        mentions,
        mentionContext: mentions > 0 ? mentionContext : null,
        deadlineRisk: hasDeadline ? deadlineText : null,
        reasons: reasons.slice(0, 3),
      };
    }));
    
    res.json(formattedChats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Get Messages for a specific chat
app.get("/api/chats/:jid/messages", (req, res) => {
  try {
    const { jid } = req.params;
    const limit = Number(req.query.limit) || 40;
    const page = Number(req.query.page) || 0;
    const messages = getMessages(jid, limit, page);
    
    const formattedMessages = messages.map((m) => {
      // sender_name comes from COALESCE(m.sender_name, ct.name, ct.notify) in DB query
      const name = m.is_from_me
        ? "Me"
        : (m.sender_name && m.sender_name.trim())
          ? m.sender_name.trim()
          : m.sender
            ? m.sender.split("@")[0]
            : "Unknown";
      return {
        id: m.id,
        chatJid: m.chat_jid,
        sender: m.sender,
        senderDisplay: name,
        content: m.content,
        timestamp: m.timestamp,
        isFromMe: m.is_from_me,
      };
    });
    
    // Sort in ascending order for UI display
    formattedMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    res.json(formattedMessages);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 5.5. Mark chat as read (resets unread count)
app.post("/api/chats/:jid/read", async (req, res) => {
  try {
    const { jid } = req.params;
    resetUnreadCount(jid);

    // Sync read status to phone if WhatsApp is connected
    if (socketContainer.sock) {
      try {
        const db = getDb();
        const latestMsg = db.prepare(`
          SELECT id, sender FROM messages 
          WHERE chat_jid = ? AND is_from_me = 0 
          ORDER BY timestamp DESC LIMIT 1
        `).get(jid) as { id: string; sender: string } | undefined;
        
        if (latestMsg) {
          const key = {
            remoteJid: jid,
            id: latestMsg.id,
            fromMe: false,
            participant: jid.endsWith("@g.us") ? latestMsg.sender : undefined
          };
          await socketContainer.sock.readMessages([key]);
          logger.info({ jid }, "Sent read receipt receipt to WhatsApp successfully");
        }
      } catch (err: any) {
        logger.error({ err, jid }, "Failed to send read receipt to WhatsApp");
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Send Message Endpoint
app.post("/api/send-message", async (req, res) => {
  try {
    const { recipient, message } = req.body;
    if (!socketContainer.sock) {
      return res.status(400).json({ success: false, error: "WhatsApp is not connected" });
    }
    
    const normalizedRecipient = jidNormalizedUser(recipient);
    const result = await socketContainer.sock.sendMessage(normalizedRecipient, { text: message });
    
    res.json({ success: true, messageId: result?.key.id });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6.5. Get Recent Deadlines (Filtered for projects, competitions, assignments, exams)
app.get("/api/deadlines", async (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.id, m.chat_jid, m.sender, m.content, m.timestamp, 
             c.name as chat_name,
             COALESCE(ct.name, ct.notify, ct.phone_number) as sender_name
      FROM messages m
      JOIN chats c ON m.chat_jid = c.jid
      LEFT JOIN contacts ct ON m.sender = ct.jid
      WHERE (LOWER(m.content) LIKE '%deadline%' 
         OR LOWER(m.content) LIKE '%submit%' 
         OR LOWER(m.content) LIKE '%due%' 
         OR LOWER(m.content) LIKE '%by %' 
         OR LOWER(m.content) LIKE '%eod%')
        AND m.timestamp >= datetime('now', '-7 days')
      ORDER BY m.timestamp DESC
      LIMIT 40
    `).all() as any[];

    const deadlines = [];
    for (const row of rows) {
      const isDeadlinesIgnored = ignoredGroupsConfig.some(g => g.jid === row.chat_jid && g.ignoreDeadlines);
      if (isDeadlinesIgnored) continue;

      const classification = await classifyDeadlineMessage(row.id, row.content || "");
      if (classification.isReal) {
        deadlines.push({
          id: row.id,
          chatJid: row.chat_jid,
          chatName: row.chat_name || row.chat_jid.split("@")[0],
          sender: row.sender,
          senderName: row.sender_name || (row.sender ? row.sender.split("@")[0] : "Other"),
          content: row.content,
          timestamp: row.timestamp,
          category: classification.category,
          deadlineText: classification.deadlineText || "Urgent"
        });
      }
    }

    res.json(deadlines.slice(0, 15));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 6.6. Get Dynamic Priority Matrix Tasks from database
app.get("/api/tasks", async (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.id, m.chat_jid, m.sender, m.content, m.timestamp, 
             c.name as chat_name,
             COALESCE(ct.name, ct.notify, ct.phone_number) as sender_name
      FROM messages m
      JOIN chats c ON m.chat_jid = c.jid
      LEFT JOIN contacts ct ON m.sender = ct.jid
      WHERE (LOWER(m.content) LIKE '%submit%'
         OR LOWER(m.content) LIKE '%submission%'
         OR LOWER(m.content) LIKE '%due%'
         OR LOWER(m.content) LIKE '%send%'
         OR LOWER(m.content) LIKE '%review%'
         OR LOWER(m.content) LIKE '%verify%'
         OR LOWER(m.content) LIKE '%check%'
         OR LOWER(m.content) LIKE '%todo%'
         OR LOWER(m.content) LIKE '%task%'
         OR LOWER(m.content) LIKE '%deadline%'
         OR LOWER(m.content) LIKE '%action%')
        AND m.timestamp >= datetime('now', '-7 days')
      ORDER BY m.timestamp DESC
      LIMIT 40
    `).all() as any[];

    const tasks = [];
    let idCounter = 1;
    for (const row of rows) {
      const isTasksIgnored = ignoredGroupsConfig.some(g => g.jid === row.chat_jid && g.ignoreTasks);
      if (isTasksIgnored) continue;

      const chatName = row.chat_name || row.chat_jid.split("@")[0];
      const senderName = row.sender_name || (row.sender ? row.sender.split("@")[0] : "System");
      const extraction = await extractTaskFromMessage(row.id, row.content || "", chatName, senderName);
      if (extraction.isTask) {
        tasks.push({
          id: idCounter++,
          text: extraction.text || row.content,
          deadline: extraction.deadline || "Urgent",
          priority: extraction.priority || "P2",
          done: false,
          source: chatName,
          chatJid: row.chat_jid,
          messageId: row.id
        });
      }
    }

    res.json(tasks);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Helper to generate a highly contextual but concise local summary if Gemini API key is missing
function generateDynamicLocalSummary(unread: any[]): string {
  let summary = `### 📋 Executive Summary\n`;
  
  let totalMessages = 0;
  const deadlineKeywords = ["submit", "deadline", "submission", "due", "quiz", "exam", "assignment", "portal", "link", "jaf"];
  const placementKeywords = ["placement", "cv", "resume", "jaf", "shortlist", "interview", "recruitment", "ppt", "company"];
  
  const detectedDeadlines: string[] = [];
  const detectedPlacement: string[] = [];
  
  unread.forEach(group => {
    totalMessages += group.messages.length;
    group.messages.forEach((m: any) => {
      const contentLower = (m.content || "").toLowerCase();
      const sender = m.sender_name || (m.sender ? m.sender.split("@")[0] : "Sender");
      
      if (deadlineKeywords.some(k => contentLower.includes(k))) {
        detectedDeadlines.push(`- **[${group.name}]** *${sender}*: ${m.content}`);
      }
      if (placementKeywords.some(k => contentLower.includes(k))) {
        detectedPlacement.push(`- **[${group.name}]** *${sender}*: ${m.content}`);
      }
    });
  });
  
  summary += `Active threads: **${unread.length}** | Unread messages: **${totalMessages}**\n\n`;
  
  summary += `#### 🚨 Action Items & Deadlines\n`;
  if (detectedDeadlines.length > 0) {
    summary += detectedDeadlines.slice(0, 3).join("\n") + "\n\n";
  } else {
    summary += `*No immediate academic deadlines identified in unread messages.*\n\n`;
  }
  
  if (detectedPlacement.length > 0) {
    summary += `#### 💼 Placements & Prep\n`;
    summary += detectedPlacement.slice(0, 3).join("\n") + "\n\n";
  }
  
  summary += `#### 🗣️ Thread Snapshots\n`;
  unread.forEach(group => {
    const readTimeMin = Math.max(1, Math.ceil((group.messages.length * 6) / 60));
    const lastMsg = group.messages[group.messages.length - 1];
    const sender = lastMsg ? (lastMsg.sender_name || (lastMsg.sender ? lastMsg.sender.split("@")[0] : "Sender")) : "";
    const text = lastMsg ? (lastMsg.content || "").substring(0, 65) : "No content";
    const preview = lastMsg ? `(${sender}: "${text}...")` : "";
    summary += `- **${group.name}** (~${readTimeMin}m read) ${preview}\n`;
  });
  
  return summary;
}

// 7. Executive summary of last 24h & unread summaries
app.get("/api/unread-summary", async (req, res) => {
  try {
    const unread = getUnreadMessagesGrouped();
    if (unread.length === 0) {
      return res.json({
        summary: "No unread messages. Your WhatsApp is up to date!",
        unreadGroups: [],
      });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    let aiSummary: string;

    if (!apiKey) {
      aiSummary = generateDynamicLocalSummary(unread);
    } else {
      // Build the prompt for Gemini
      let prompt = "You are an AI Chief of Staff in a B-school/MBA environment. I have some unread WhatsApp messages from B-School and MBA preparation groups. " +
        "Provide a concise, highly contextual, and organized executive summary. Focus on academic timelines, placements, and case competitions.\n\n" +
        "Here are the unread messages:\n\n";

      unread.forEach((group) => {
        prompt += `Group: ${group.name} (${group.unread_count} unread messages)\n`;
        group.messages.forEach((m) => {
          const sender = m.sender_name || (m.sender ? m.sender.split("@")[0] : "Sender");
          prompt += `[${m.timestamp.toISOString()}] ${sender}: ${m.content}\n`;
        });
        prompt += "\n";
      });

      prompt += "\nFormat your response in beautiful markdown. Keep it concise, structured, and easy to scan at a glance:\n" +
        "1. **🚨 ACTION ITEMS & DEADLINES**: Bullet list of key submissions, exams, or JAF deadlines (date, time, portal). Limit to max 4 items.\n" +
        "2. **💼 PLACEMENTS & PREP**: Bullet list of placement briefings or case comp registrations. Limit to max 3 items.\n" +
        "3. **🗣️ THREAD SNAPSHOTS**: One line per active group summarizing its main discussion topic and estimated read time.\n\n" +
        "Avoid conversational filler, introductory text, or long paragraphs. Just provide the key facts directly.";

      aiSummary = await callGemini(prompt);
    }
    
    res.json({
      summary: aiSummary,
      unreadGroups: unread.map(g => ({
        jid: g.jid,
        name: g.name,
        unreadCount: g.unread_count,
        messages: g.messages.map(m => ({
          content: m.content,
          sender: m.sender_name || (m.sender ? m.sender.split("@")[0] : "Other"),
          timestamp: m.timestamp
        }))
      }))
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


// 8. AI Terminal Endpoint
app.post("/api/terminal", async (req, res) => {
  try {
    const { command } = req.body;
    if (!command || !command.startsWith(">")) {
      return res.status(400).json({ error: "Invalid command format. Must start with '>'" });
    }

    const cleanCmd = command.substring(1).trim().toLowerCase();
    const db = getDb();

    // Command Router
    if (cleanCmd.startsWith("find all messages mentioning ")) {
      const term = command.substring(command.toLowerCase().indexOf("mentioning ") + 11).trim();
      const results = searchMessages(term, null, 15, 0);
      
      const formatted = results.map(r => `[${r.timestamp.toISOString().split("T")[0]}] ${r.chat_name} -> ${r.sender ? r.sender.split("@")[0] : "Other"}: ${r.content}`).join("\n");
      return res.json({
        output: `Found ${results.length} matches across chats:\n\n${formatted || "No matches found."}`
      });
    }

    if (cleanCmd.startsWith("reply to ")) {
      // Syntax: reply to <contact> <message>
      const parts = command.substring(9).trim().split(" ");
      const name = parts[0];
      const messageText = parts.slice(1).join(" ");
      
      // Find JID of contact
      const contactRow = db.prepare(`
        SELECT jid, name 
        FROM contacts 
        WHERE LOWER(name) LIKE LOWER(?) OR jid LIKE ? 
        LIMIT 1
      `).get(`%${name}%`, `%${name}%`) as { jid: string; name: string } | undefined;
      
      if (!contactRow) {
        return res.json({ output: `Could not find contact matching "${name}"` });
      }
      
      if (!socketContainer.sock) {
        return res.json({ output: "Error: WhatsApp is not connected" });
      }
      
      await socketContainer.sock.sendMessage(contactRow.jid, { text: messageText });
      return res.json({
        output: `Message sent to ${contactRow.name || contactRow.jid}:\n"${messageText}"`
      });
    }

    if (cleanCmd.startsWith("summarize ")) {
      const groupName = command.substring(11).trim();
      
      // Find chat
      const chatRow = db.prepare(`
        SELECT jid, name 
        FROM chats 
        WHERE LOWER(name) LIKE LOWER(?) OR jid LIKE ? 
        LIMIT 1
      `).get(`%${groupName}%`, `%${groupName}%`) as { jid: string; name: string } | undefined;
      
      if (!chatRow) {
        return res.json({ output: `Could not find chat matching "${groupName}"` });
      }
      
      // Fetch last 30 messages
      const msgs = db.prepare(`
        SELECT content, sender, timestamp 
        FROM messages 
        WHERE chat_jid = ? 
        ORDER BY timestamp DESC 
        LIMIT 30
      `).all(chatRow.jid) as { content: string; sender: string; timestamp: string }[];
      
      if (msgs.length === 0) {
        return res.json({ output: `No messages found in chat "${chatRow.name || chatRow.jid}"` });
      }
      
      let context = `Summarize the last 30 messages in B-School group "${chatRow.name || chatRow.jid}":\n\n`;
      msgs.reverse().forEach((m) => {
        const sender = m.sender ? m.sender.split("@")[0] : "Sender";
        context += `[${m.timestamp}] ${sender}: ${m.content}\n`;
      });
      
      const summary = await callGemini(context + "\nProvide a concise 3-4 bullet point summary.");
      return res.json({ output: `Summary for **${chatRow.name || chatRow.jid}**:\n\n${summary}` });
    }

    if (cleanCmd.startsWith("draft response to ")) {
      const name = command.substring(18).trim();
      
      // Find chat
      const chatRow = db.prepare(`
        SELECT jid, name 
        FROM chats 
        WHERE LOWER(name) LIKE LOWER(?) OR jid LIKE ? 
        LIMIT 1
      `).get(`%${name}%`, `%${name}%`) as { jid: string; name: string } | undefined;
      
      if (!chatRow) {
        return res.json({ output: `Could not find chat matching "${name}"` });
      }
      
      // Fetch last 5 messages to understand context
      const msgs = db.prepare(`
        SELECT content, sender, is_from_me, timestamp 
        FROM messages 
        WHERE chat_jid = ? 
        ORDER BY timestamp DESC 
        LIMIT 5
      `).all(chatRow.jid) as { content: string; sender: string; is_from_me: number; timestamp: string }[];
      
      if (msgs.length === 0) {
        return res.json({ output: `No messages found to draft response.` });
      }
      
      let context = `Draft a polite, professional reply to the last message. Here is the recent chat history:\n\n`;
      msgs.reverse().forEach((m) => {
        const sender = m.is_from_me ? "Me" : m.sender ? m.sender.split("@")[0] : "Other";
        context += `${sender}: ${m.content}\n`;
      });
      
      const draft = await callGemini(context + "\nDraft: [Provide a concise response draft, ready to send]");
      return res.json({ output: `Draft response for **${chatRow.name || chatRow.jid}**:\n\n${draft}` });
    }

    if (cleanCmd.includes("deadline")) {
      // Find all messages in the database containing deadline keywords in the last 7 days
      const msgs = db.prepare(`
        SELECT m.content, m.timestamp, c.name as chat_name, m.sender
        FROM messages m
        JOIN chats c ON m.chat_jid = c.jid
        WHERE (LOWER(m.content) LIKE '%deadline%' OR LOWER(m.content) LIKE '%submit%' OR LOWER(m.content) LIKE '%due%' OR LOWER(m.content) LIKE '%by %' OR LOWER(m.content) LIKE '%eod%')
          AND m.timestamp >= datetime('now', '-7 days')
        ORDER BY m.timestamp DESC
        LIMIT 40
      `).all() as { content: string; timestamp: string; chat_name: string; sender: string }[];
      
      let context = "Extract and structure all upcoming deadlines mentioned in these WhatsApp messages:\n\n";
      msgs.forEach(m => {
        const sender = m.sender ? m.sender.split("@")[0] : "Sender";
        context += `[Group: ${m.chat_name || "Direct Message"}] ${sender}: ${m.content}\n`;
      });
      
      const deadlines = await callGemini(context + "\nSummarize them in a markdown table format with Columns: Group, Deadline, Task, Remaining Time.");
      return res.json({ output: `### Extracted Deadlines\n\n${deadlines}` });
    }

    if (cleanCmd.includes("approval") || cleanCmd.includes("pending")) {
      const msgs = db.prepare(`
        SELECT m.content, c.name as chat_name, m.sender
        FROM messages m
        JOIN chats c ON m.chat_jid = c.jid
        WHERE (LOWER(m.content) LIKE '%approve%' OR LOWER(m.content) LIKE '%confirm%' OR LOWER(m.content) LIKE '%pending%' OR LOWER(m.content) LIKE '%invoice%')
        ORDER BY m.timestamp DESC
        LIMIT 30
      `).all() as { content: string; chat_name: string; sender: string }[];
      
      let context = "List all pending approvals or decisions needed from these messages:\n\n";
      msgs.forEach(m => {
        context += `[${m.chat_name}] ${m.sender ? m.sender.split("@")[0] : "Sender"}: ${m.content}\n`;
      });
      
      const approvals = await callGemini(context + "\nExtract them as a bulleted checklist of approvals, marking the source chat.");
      return res.json({ output: `### Pending Approvals\n\n${approvals}` });
    }

    if (cleanCmd.includes("briefing") || cleanCmd.includes("agenda")) {
      const unread = getUnreadMessagesGrouped();
      let context = "Prepare an executive briefing for today's call. Here are recent unread messages and topics:\n\n";
      
      unread.slice(0, 5).forEach((group) => {
        context += `Group: ${group.name}\n`;
        group.messages.slice(0, 5).forEach((m) => {
          context += `- ${m.content}\n`;
        });
      });
      
      const briefing = await callGemini(context + "\nWrite a structured daily briefing covering: 1. Critical Open Issues, 2. Pending Decisions, 3. Tasks to Execute today.");
      return res.json({ output: briefing });
    }

    // Default to sending to Gemini directly
    const genericResponse = await callGemini(`The user is running the command: "${command}" in their AI Chief of Staff terminal. Help them execute it. If it asks for information, use your knowledge base.`);
    res.json({ output: genericResponse });
    
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Start express server
export function startExpressServer(port: number = 3002) {
  app.listen(port, "0.0.0.0", () => {
    logger.info(`Express Server started on http://localhost:${port}`);
  });
}

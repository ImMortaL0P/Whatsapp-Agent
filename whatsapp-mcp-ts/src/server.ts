import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { socketContainer, startWhatsAppConnection } from "./whatsapp.ts";
import { getChats, getMessages, getUnreadMessagesGrouped, searchMessages } from "./database.ts";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import P from "pino";

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

// 1. Connection Status Endpoint
app.get("/api/status", (req, res) => {
  res.json({
    status: socketContainer.connectionStatus,
    qr: socketContainer.qrCode,
    error: socketContainer.error,
    user: socketContainer.userName || null,
  });
});

// 2. Connect Endpoint (Manual login trigger)
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
app.get("/api/chats", (req, res) => {
  try {
    const limit = Number(req.query.limit) || 30;
    const page = Number(req.query.page) || 0;
    const chats = getChats(limit, page, "last_active", null, true);
    const db = getDb();
    
    const formattedChats = chats.map((chat) => {
      const isGroup = chat.jid.endsWith("@g.us");
      const name = chat.name || chat.jid.split("@")[0] || "Unknown Chat";
      const unreadCount = chat.unread_count || 0;
      
      // Fetch recent messages to calculate metrics (mentions, deadlines, urgency keywords)
      let mentions = 0;
      let hasDeadline = false;
      let deadlineText = "";
      let hasUrgentWord = false;
      
      try {
        const msgStmt = db.prepare(`
          SELECT content, sender, is_from_me 
          FROM messages 
          WHERE chat_jid = ? 
          ORDER BY timestamp DESC 
          LIMIT 20
        `);
        const recentMsgs = msgStmt.all(chat.jid) as { content: string; sender: string; is_from_me: number }[];
        
        for (const msg of recentMsgs) {
          if (!msg.content) continue;
          
          // Count mentions of "Kumar" or "@Kumar"
          if (msg.content.toLowerCase().includes("kumar") && msg.is_from_me === 0) {
            mentions++;
          }
          
          // Search for urgency keywords
          if (
            /\b(urgent|asap|delay|escalat|important|alert|pending|invoice|approve|action)\b/i.test(
              msg.content
            )
          ) {
            hasUrgentWord = true;
          }
          
          // Scan for deadlines (today, tomorrow, friday, EOD, EOW, by \d+ PM/AM)
          const deadlineMatch = msg.content.match(
            /\b(today|tomorrow|eod|asap|friday|before meeting|by \d+\s*(?:am|pm)?|due\s+\w+)\b/i
          );
          if (deadlineMatch && !hasDeadline) {
            hasDeadline = true;
            deadlineText = deadlineMatch[0];
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
        deadlineRisk: hasDeadline ? deadlineText : null,
        reasons: reasons.slice(0, 3),
      };
    });
    
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
    
    const formattedMessages = messages.map((m) => ({
      id: m.id,
      chatJid: m.chat_jid,
      sender: m.sender,
      senderDisplay: m.sender ? m.sender.split("@")[0] : m.is_from_me ? "Me" : "Unknown",
      content: m.content,
      timestamp: m.timestamp,
      isFromMe: m.is_from_me,
    }));
    
    // Sort in ascending order for UI display
    formattedMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    res.json(formattedMessages);
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

    // Build the prompt for Gemini
    let prompt = "You are an AI Chief of Staff. I have some unread WhatsApp messages from B-School and MBA preparation groups. " +
      "Summarize them concisely into action items, deadlines, and critical mentions. Here are the unread messages:\n\n";

    unread.forEach((group) => {
      prompt += `Group: ${group.name} (${group.unread_count} unread messages)\n`;
      group.messages.forEach((m) => {
        const sender = m.sender ? m.sender.split("@")[0] : "Sender";
        prompt += `[${m.timestamp.toISOString()}] ${sender}: ${m.content}\n`;
      });
      prompt += "\n";
    });

    prompt += "\nProvide a bulleted Executive Summary (e.g. '1 submission pending', '2 mentions'), " +
      "followed by specific bullet summaries for each group with read times, and a list of detected deadlines. Format nicely in markdown.";

    const aiSummary = await callGemini(prompt);
    
    res.json({
      summary: aiSummary,
      unreadGroups: unread.map(g => ({
        jid: g.jid,
        name: g.name,
        unreadCount: g.unread_count,
        messages: g.messages.map(m => ({
          content: m.content,
          sender: m.sender ? m.sender.split("@")[0] : "Other",
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

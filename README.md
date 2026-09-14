# WhatsApp Command Center (AI Chief of Staff)

A premium Operations Command Center application that sits on top of WhatsApp (via a local Baileys connection and SQLite database) and acts as an AI Chief of Staff. It translates messy B-School and MBA preparation groups (GIM, GLIM, IIM Kashipur, IMTG, etc.) into summaries, tasks, deadlines, and actionable briefing documents.

Inspired by Notion + Linear + Bloomberg Terminal styling, featuring a default dark mode with tactical crimson red accents, a command terminal, and AI-driven panels.

## 🚀 Getting Started

We have configured a concurrent development runner in the root directory. To install all dependencies and start the app:

### 1. Install Dependencies
Run this command from the root folder:
```bash
npm run install-all
```

### 2. Start Both Servers (Backend & Frontend)
Run this command from the root folder:
```bash
npm run dev
```

This starts:
- The **Vite React Frontend** (defaulting to http://localhost:3000 or http://localhost:3001 if port 3000 is occupied).
- The **Express API Backend** on http://localhost:3002.

---

## 🛠 Features Implemented

1. **Smart Chat Navigator (Left Panel)**:
   - Synchronized with your real WhatsApp database.
   - Categorizes chats into **Priority B-School Threads (Tier 1)** ( etc.), **Direct Messages (DMs)** (etc.), and **General Groups (Tier 2/3)**.
   - Computes live **AI Priority Scores** (10-99) and flags **Deadline Risks** / **Unread Counts** / **Mentions** for each chat.

2. **AI Intelligence Feed (Center Panel)**:
   - **Executive Summary**: Bullets summarizing the last 24 hours (B-School updates, mock schedules, case deck submissions).
   - **Mention Radar**: Real-time tracking of direct mentions of your name (`Kumar`).
   - **Unread Group Summaries**: High-level summaries of unread messages.
   - **Priority Matrix (AI Task Engine)**: Auto-extracted checklist tasks divided into P1 Critical, P2 Important, and P3 Optional.
   - **AI Deadline Detection**: Imminent date/time limits found in messages with remaining time countdowns.

3. **Gemini AI Terminal (Right Panel)**:
   - Interactive command terminal supporting real-time database queries and Gemini AI assistance:
     - `> help` - list all terminal commands.
     - `> summarize <group_name>` - summarizes recent messages in a group.
     - `> extract all deadlines` - parses and compiles all deadlines in a clean table format.
     - `> draft response to <contact>` - drafts a professional response based on chat context.
     - `> find all messages mentioning <query>` - searches terms across all WhatsApp chats.
     - `> reply to <contact> <message>` - sends a real-time WhatsApp message to the contact.
     - `> list approvals pending` - lists all confirmation requests.
     - `> prepare briefing for today's call` - builds a daily executive briefing of open B-school items.

4. **Response Analytics & Heatmap (Bottom Panel)**:
   - **Activity Heatmap**: Real-time group activity percentages.
   - **Response Analytics**: Tracks response times, pending counts, and critical escalations.
   - **B-School Relationship Map**: Graph visual of connections between Me, B-School Converts, and DM contacts.

5. **One-Time Authentication**:
   - Connection credentials are saved in the `auth_info/` directory, maintaining your session.
   - If disconnected, a beautiful QR Code scanner panel appears automatically. Scan it once using your phone's WhatsApp Linked Devices to link permanently.

---

## ⚙️ Generative AI (Gemini) Integration

The dashboard automatically checks for `GEMINI_API_KEY` or `GOOGLE_API_KEY` in your environment.
- If present, it makes direct fetch calls to the Gemini API to produce fully generative summaries, custom briefings, and response drafts.
- If not present, it gracefully falls back to a regex-based NLP heuristic analyzer that extracts items from your real WhatsApp messages, ensuring full offline functionality.

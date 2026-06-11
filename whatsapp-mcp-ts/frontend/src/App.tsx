import React, { useState, useEffect, useRef } from "react";
import {
  Send,
  Terminal as TerminalIcon,
  Search,
  RefreshCw,
  AlertCircle,
  CheckSquare,
  Clock,
  User,
  Users,
  ArrowLeft,
  Activity,
  Crosshair,
  Loader,
  TrendingUp,
  Sliders,
  Shield,
  Zap,
  MessageSquare,
  Trash2,
  LayoutDashboard,
  Settings
} from "lucide-react";

const API_BASE = typeof window !== "undefined" && window.location.hostname && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1"
  ? `http://${window.location.hostname}:3002`
  : "http://localhost:3002";

interface Chat {
  jid: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  lastMessageTime: string | null;
  lastMessagePreview: string | null;
  lastIsFromMe: boolean | null;
  tier: number;
  priorityScore: number;
  urgencyScore: "HIGH" | "MEDIUM" | "LOW";
  mentions: number;
  mentionContext?: string | null;
  deadlineRisk: string | null;
  reasons: string[];
}

interface Message {
  id: string;
  chatJid: string;
  sender: string | null;
  senderDisplay: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
}

interface DeadlineDetails {
  id: string;
  chatJid: string;
  chatName: string;
  senderName: string;
  content: string;
  timestamp: string;
  deadlineText: string;
}

interface TerminalLine {
  type: "command" | "output" | "error" | "info";
  text: string;
}

interface AfkLogEntry {
  id: string;
  chatJid: string;
  chatName: string;
  senderDisplay: string;
  incomingContent: string;
  afkReplyContent: string;
  timestamp: string;
  type: "dm" | "mention";
}

export default function App() {
  // Global States
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatJid, setActiveChatJid] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [connection, setConnection] = useState<{
    status: "disconnected" | "connecting" | "connected";
    qr: string | null;
    error: string | null;
    user: string | null;
  }>({
    status: "disconnected",
    qr: null,
    error: null,
    user: null
  });

  // UI Local States
  const [messageText, setMessageText] = useState("");
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalHistory, setTerminalHistory] = useState<TerminalLine[]>([
    { type: "info", text: "AI Command Terminal initialized." },
    { type: "info", text: "Type '> help' or click one of the suggested commands below to execute." }
  ]);
  const [syncLoading, setSyncLoading] = useState(false);
  const [aiSummary, setAiSummary] = useState<string>("");
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [chatFilter, setChatFilter] = useState<"all" | "personal" | "groups">("all");
  const [matrixTasks, setMatrixTasks] = useState<any[]>([]);

  const [lastSyncedTime, setLastSyncedTime] = useState<string>("Never");
  const [deadlinesList, setDeadlinesList] = useState<DeadlineDetails[]>([]);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  // AFK Mode States
  const [afkState, setAfkState] = useState({
    active: false,
    message: "",
    replyToMentions: true,
    replyToDMs: true
  });
  const [showAfkSettings, setShowAfkSettings] = useState(false);
  const [afkLog, setAfkLog] = useState<AfkLogEntry[]>([]);
  const [ignoredGroupsSettings, setIgnoredGroupsSettings] = useState<any[]>([]);

  // Persistent To-Do & Dismiss Lists
  const [todoTasks, setTodoTasks] = useState<any[]>(() => {
    const saved = localStorage.getItem("todo_tasks");
    return saved ? JSON.parse(saved) : [];
  });

  const [dismissedChatJids, setDismissedChatJids] = useState<string[]>(() => {
    const saved = localStorage.getItem("dismissed_chat_jids");
    return saved ? JSON.parse(saved) : [];
  });

  const [dismissedMessageIds, setDismissedMessageIds] = useState<string[]>(() => {
    const saved = localStorage.getItem("dismissed_message_ids");
    return saved ? JSON.parse(saved) : [];
  });

  const [dismissedTaskIds, setDismissedTaskIds] = useState<string[]>(() => {
    const saved = localStorage.getItem("dismissed_task_ids");
    return saved ? JSON.parse(saved) : [];
  });

  const [dismissedMentionsMap, setDismissedMentionsMap] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem("dismissed_mentions_map");
    return saved ? JSON.parse(saved) : {};
  });

  // Sync to localStorage
  useEffect(() => {
    localStorage.setItem("todo_tasks", JSON.stringify(todoTasks));
  }, [todoTasks]);

  useEffect(() => {
    localStorage.setItem("dismissed_chat_jids", JSON.stringify(dismissedChatJids));
  }, [dismissedChatJids]);

  useEffect(() => {
    localStorage.setItem("dismissed_message_ids", JSON.stringify(dismissedMessageIds));
  }, [dismissedMessageIds]);

  useEffect(() => {
    localStorage.setItem("dismissed_task_ids", JSON.stringify(dismissedTaskIds));
  }, [dismissedTaskIds]);

  useEffect(() => {
    localStorage.setItem("dismissed_mentions_map", JSON.stringify(dismissedMentionsMap));
  }, [dismissedMentionsMap]);

  // Tab state: 'dashboard' | 'afk-log' | 'todo'
  const [activeTab, setActiveTab] = useState<"dashboard" | "afk-log" | "todo">("dashboard");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const fetchDeadlines = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/deadlines`);
      if (res.ok) {
        const data = await res.json();
        setDeadlinesList(data);
      }
    } catch (err) {
      console.error("Failed to fetch deadlines list", err);
    }
  };

  const fetchTasks = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/tasks`);
      if (res.ok) {
        const data = await res.json();
        // Load latest dismissed IDs to prevent stale closures
        const savedDismissed = localStorage.getItem("dismissed_task_ids");
        const latestDismissed: string[] = savedDismissed ? JSON.parse(savedDismissed) : [];

        setMatrixTasks(prev => {
          const activeTasks = data.filter((t: any) => !latestDismissed.includes(t.messageId));
          return activeTasks.map((newTask: any) => {
            const existing = prev.find(t => t.messageId === newTask.messageId || t.text === newTask.text);
            return existing ? { ...newTask, done: existing.done } : newTask;
          });
        });
      }
    } catch (err) {
      console.error("Failed to fetch tasks list", err);
    }
  };

  const handleNavigateToDeadline = (chatJid: string, messageId: string) => {
    setActiveChatJid(chatJid);
    setHighlightedMessageId(messageId);
    setTimeout(() => {
      setHighlightedMessageId(null);
    }, 4000);
  };

  const fetchIgnoredGroupsSettings = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings/ignored-groups`);
      if (res.ok) {
        const data = await res.json();
        setIgnoredGroupsSettings(data);
      }
    } catch (err) {
      console.error("Failed to fetch ignored groups settings", err);
    }
  };

  const handleSaveIgnoredGroupsSettings = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings/ignored-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ignoredGroupsSettings)
      });
      if (res.ok) {
        fetchChats();
        fetchDeadlines();
        fetchTasks();
        alert("Exclusion settings saved successfully.");
      } else {
        alert("Failed to save settings.");
      }
    } catch (err) {
      console.error("Failed to save settings", err);
      alert("Error saving settings.");
    }
  };

  const handleDismissChatDeadline = (jid: string) => {
    setDismissedChatJids(prev => [...prev, jid]);
  };

  const handleAddChatDeadlineTodo = (chat: Chat) => {
    const taskText = `Review deadline: ${chat.deadlineRisk} - ${chat.lastMessagePreview}`;
    if (!todoTasks.some(t => t.id === chat.jid)) {
      setTodoTasks(prev => [
        ...prev,
        {
          id: chat.jid,
          text: taskText,
          source: chat.name,
          chatJid: chat.jid,
          messageId: null,
          done: false
        }
      ]);
    }
    handleDismissChatDeadline(chat.jid);
  };

  const handleDismissMessageDeadline = (id: string) => {
    setDismissedMessageIds(prev => [...prev, id]);
  };

  const handleAddMessageDeadlineTodo = (deadline: any) => {
    const taskText = `[${deadline.deadlineText}] ${deadline.senderName}: ${deadline.content}`;
    if (!todoTasks.some(t => t.id === deadline.id)) {
      setTodoTasks(prev => [
        ...prev,
        {
          id: deadline.id,
          text: taskText,
          source: deadline.chatName,
          chatJid: deadline.chatJid,
          messageId: deadline.id,
          done: false
        }
      ]);
    }
    handleDismissMessageDeadline(deadline.id);
  };

  const fetchAfk = async () => {
    // Don't overwrite local state while the user is editing the AFK settings panel
    if (showAfkSettings) return;
    try {
      const res = await fetch(`${API_BASE}/api/afk`);
      if (res.ok) {
        const data = await res.json();
        setAfkState(data);
      }
    } catch (err) {
      console.error("Failed to fetch AFK state", err);
    }
  };

  const fetchAfkLog = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/afk/log`);
      if (res.ok) {
        const data = await res.json();
        setAfkLog(data);
      }
    } catch (err) {
      console.error("Failed to fetch AFK log", err);
    }
  };

  const handleClearAfkLog = async () => {
    try {
      await fetch(`${API_BASE}/api/afk/log`, { method: "DELETE" });
      setAfkLog([]);
    } catch (err) {
      console.error("Failed to clear AFK log", err);
    }
  };

  const handleUpdateAfk = async (updated: typeof afkState) => {
    // Optimistically apply changes immediately so UI feels instant
    setAfkState(updated);
    try {
      const res = await fetch(`${API_BASE}/api/afk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated)
      });
      if (res.ok) {
        const data = await res.json();
        setAfkState(data.afkConfig);
      }
    } catch (err) {
      console.error("Failed to update AFK state", err);
    }
  };

  const handleToggleAfk = (active: boolean) => {
    const updated = { ...afkState, active };
    handleUpdateAfk(updated);
  };

  // Poll connection status, chats and deadlines list
  useEffect(() => {
    fetchStatus();
    fetchChats();
    fetchDeadlines();
    fetchTasks();
    fetchIgnoredGroupsSettings();
    fetchAfk();
    fetchAfkLog();

    const statusInterval = setInterval(fetchStatus, 3000);
    const chatsInterval = setInterval(fetchChats, 7000);
    const deadlinesInterval = setInterval(fetchDeadlines, 10000);
    const tasksInterval = setInterval(fetchTasks, 10000);
    const afkLogInterval = setInterval(fetchAfkLog, 5000);

    return () => {
      clearInterval(statusInterval);
      clearInterval(chatsInterval);
      clearInterval(deadlinesInterval);
      clearInterval(tasksInterval);
      clearInterval(afkLogInterval);
    };
  }, []);

  // Poll messages when active chat changes; also mark the chat as read
  useEffect(() => {
    if (!activeChatJid) return;
    fetchMessages(activeChatJid);

    // Mark the chat as read to reset its unread badge
    fetch(`${API_BASE}/api/chats/${encodeURIComponent(activeChatJid)}/read`, { method: "POST" })
      .then(() => fetchChats()) // refresh chats to update badge counts
      .catch(() => {});

    const msgsInterval = setInterval(() => {
      fetchMessages(activeChatJid);

      // Reset unread count optimistically if the active chat has unread messages in the sidebar list
      setChats(prev => {
        const chatObj = prev.find(c => c.jid === activeChatJid);
        if (chatObj && chatObj.unreadCount > 0) {
          fetch(`${API_BASE}/api/chats/${encodeURIComponent(activeChatJid)}/read`, { method: "POST" })
            .catch(() => {});
          return prev.map(c => c.jid === activeChatJid ? { ...c, unreadCount: 0 } : c);
        }
        return prev;
      });
    }, 2000);

    return () => clearInterval(msgsInterval);
  }, [activeChatJid]);

  // Scroll to bottom on new messages (unless we need to scroll to a highlighted message)
  useEffect(() => {
    if (highlightedMessageId) {
      const element = document.getElementById(`msg-${highlightedMessageId}`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, highlightedMessageId]);

  // Scroll to bottom on new terminal lines
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [terminalHistory]);

  // API Call: Fetch connection status
  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/status`);
      if (res.ok) {
        const data = await res.json();
        setConnection(data);
      }
    } catch (err) {
      console.error("Failed to fetch connection status", err);
    }
  };

  // API Call: Fetch chats list
  const fetchChats = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/chats?limit=150`);
      if (res.ok) {
        const data = (await res.json()) as Chat[];
        setChats(data);
        setLastSyncedTime(new Date().toLocaleTimeString());
      }
    } catch (err) {
      console.error("Failed to fetch chats", err);
    }
  };

  // API Call: Fetch messages for a chat
  const fetchMessages = async (jid: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/chats/${jid}/messages`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
      }
    } catch (err) {
      console.error("Failed to fetch messages", err);
    }
  };

  // API Call: Send WhatsApp message
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!messageText.trim() || !activeChatJid) return;

    try {
      const res = await fetch(`${API_BASE}/api/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: activeChatJid,
          message: messageText
        })
      });

      if (res.ok) {
        setMessageText("");
        fetchMessages(activeChatJid);
      }
    } catch (err) {
      console.error("Failed to send message", err);
    }
  };

  // API Call: Trigger Force Sync Reconnect
  const handleForceSync = async () => {
    setSyncLoading(true);
    setTerminalHistory(prev => [
      ...prev,
      { type: "info", text: "Initiating force sync... disconnecting and reconnecting socket." }
    ]);
    try {
      const res = await fetch(`${API_BASE}/api/sync`, { method: "POST" });
      if (res.ok) {
        setTimeout(() => {
          fetchStatus();
          fetchChats();
          fetchDeadlines();
          setSyncLoading(false);
          setLastSyncedTime(new Date().toLocaleTimeString());
          setTerminalHistory(prev => [
            ...prev,
            { type: "info", text: "WhatsApp connection restarted successfully. Sync complete." }
          ]);
        }, 3000);
      }
    } catch (err) {
      console.error("Sync failed", err);
      setSyncLoading(false);
    }
  };

  // API Call: Generate Executive Summary
  const handleGenerateSummary = async () => {
    setAiSummaryLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/unread-summary`);
      if (res.ok) {
        const data = await res.json();
        setAiSummary(data.summary);
      }
    } catch (err) {
      setAiSummary("Failed to generate AI unread summary. Please check backend logs.");
    } finally {
      setAiSummaryLoading(false);
    }
  };

  // Manual connect trigger if disconnected
  const handleConnect = async () => {
    try {
      await fetch(`${API_BASE}/api/connect`, { method: "POST" });
      fetchStatus();
    } catch (err) {
      console.error("Manual connect trigger failed", err);
    }
  };

  // API Call: Execute Terminal Command
  const handleExecuteCommand = async (commandString: string) => {
    const cmd = commandString.trim();
    if (!cmd) return;

    setTerminalHistory(prev => [...prev, { type: "command", text: cmd }]);
    setTerminalInput("");

    if (cmd.toLowerCase() === "> clear") {
      setTerminalHistory([]);
      return;
    }

    if (cmd.toLowerCase() === "> help") {
      setTerminalHistory(prev => [
        ...prev,
        {
          type: "info",
          text: "Available Commands:\n" +
            "  > summarize <chat_name> - summarize recent group discussion\n" +
            "  > extract all deadlines  - fetch all upcoming project deadlines\n" +
            "  > draft response to <name> - drafts a reply using AI context\n" +
            "  > find all messages mentioning <query> - search terms across B-school threads\n" +
            "  > reply to <name> <msg>   - sends a quick reply to contact\n" +
            "  > list approvals pending - lists all messages requesting approvals\n" +
            "  > prepare briefing for today's call - daily brief of critical MBA tasks\n" +
            "  > clear                  - clear terminal screen"
        }
      ]);
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/terminal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd })
      });

      if (res.ok) {
        const data = await res.json();
        setTerminalHistory(prev => [...prev, { type: "output", text: data.output }]);
      } else {
        setTerminalHistory(prev => [
          ...prev,
          { type: "error", text: "Error executing command. Verify server status." }
        ]);
      }
    } catch (err: any) {
      setTerminalHistory(prev => [
        ...prev,
        { type: "error", text: `Command execution failed: ${err.message}` }
      ]);
    }
  };

  // Toggle Matrix Task check state
  const toggleTask = (id: number) => {
    setMatrixTasks(prev =>
      prev.map(t => (t.id === id ? { ...t, done: !t.done } : t))
    );
  };

  // Clear all tasks in a single priority section (P1/P2/P3)
  const handleClearPriorityTasks = (priority: string) => {
    const idsToDismiss = matrixTasks
      .filter(t => t.priority === priority && t.messageId)
      .map(t => t.messageId);
    setDismissedTaskIds(prev => [...prev, ...idsToDismiss]);
    setMatrixTasks(prev => prev.filter(t => t.priority !== priority));
  };

  // Remove a single priority matrix task
  const handleRemoveMatrixTask = (task: any) => {
    if (task.messageId) {
      setDismissedTaskIds(prev => [...prev, task.messageId]);
    }
    setMatrixTasks(prev => prev.filter(t => t.messageId !== task.messageId && t.text !== task.text));
  };

  const activeChat = chats.find(c => c.jid === activeChatJid);

  // Filters for Chat Sidebar lists
  const filteredChats = chats.filter(c =>
    c.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Sort chats by lastMessageTime descending (most recent activity first)
  const sortedChats = [...filteredChats].sort((a, b) => {
    const timeA = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
    const timeB = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
    if (timeA === 0 && timeB > 0) return 1;
    if (timeB === 0 && timeA > 0) return -1;
    return timeB - timeA;
  });

  const tier1Chats = sortedChats.filter(c => c.tier === 1 && c.isGroup);
  const directMessages = sortedChats.filter(c => !c.isGroup);
  const generalChats = sortedChats.filter(c => c.tier > 1 && c.isGroup);

  // Dynamic Deadline risk reminders from chats list
  const deadlineRiskChats = chats.filter(c => c.deadlineRisk && !dismissedChatJids.includes(c.jid));

  // Compile mentions summary across all chats
  const mentionsList = chats
    .filter(c => {
      const dismissedCount = dismissedMentionsMap[c.jid] || 0;
      return c.mentions > dismissedCount;
    })
    .map(c => ({
      chatName: c.name,
      count: c.mentions - (dismissedMentionsMap[c.jid] || 0),
      jid: c.jid,
      context: c.mentionContext
    }));

  return (
    <div className="app-container">
      {/* 1. TOP HEADER */}
      <header className="app-header">
        <div className="brand-section">
          <div className="brand-logo">
            <Crosshair size={16} color="white" />
          </div>
          <div className="brand-title">WhatsApp Command Center</div>
          <div className="brand-badge">AI Chief of Staff</div>
        </div>

        {/* TAB NAVIGATION */}
        <div style={{ display: "flex", gap: "4px", background: "var(--bg-primary)", borderRadius: "var(--radius-md)", padding: "3px" }}>
          <button
            className={`btn ${activeTab === "dashboard" ? "btn-primary" : ""}`}
            style={activeTab === "dashboard"
              ? { background: "var(--color-critical)", border: "none", boxShadow: "var(--red-glow)", fontSize: "11px", padding: "5px 10px" }
              : { fontSize: "11px", padding: "5px 10px", border: "none", background: "transparent", color: "var(--text-muted)" }
            }
            onClick={() => setActiveTab("dashboard")}
          >
            <LayoutDashboard size={12} />
            Dashboard
          </button>
          <button
            className={`btn ${activeTab === "afk-log" ? "btn-primary" : ""}`}
            style={activeTab === "afk-log"
              ? { background: "var(--color-critical)", border: "none", boxShadow: "var(--red-glow)", fontSize: "11px", padding: "5px 10px" }
              : { fontSize: "11px", padding: "5px 10px", border: "none", background: "transparent", color: "var(--text-muted)" }
            }
            onClick={() => setActiveTab("afk-log")}
          >
            <MessageSquare size={12} />
            AFK Log
            {afkLog.length > 0 && (
              <span style={{ background: "var(--color-critical)", color: "white", borderRadius: "10px", fontSize: "9px", padding: "1px 5px", marginLeft: "4px", fontWeight: 700 }}>
                {afkLog.length}
              </span>
            )}
          </button>
          <button
            className={`btn ${activeTab === "todo" ? "btn-primary" : ""}`}
            style={activeTab === "todo"
              ? { background: "var(--color-critical)", border: "none", boxShadow: "var(--red-glow)", fontSize: "11px", padding: "5px 10px" }
              : { fontSize: "11px", padding: "5px 10px", border: "none", background: "transparent", color: "var(--text-muted)" }
            }
            onClick={() => setActiveTab("todo")}
          >
            <CheckSquare size={12} />
            To-Do List
            {todoTasks.filter(t => !t.done).length > 0 && (
              <span style={{ background: "var(--color-critical)", color: "white", borderRadius: "10px", fontSize: "9px", padding: "1px 5px", marginLeft: "4px", fontWeight: 700 }}>
                {todoTasks.filter(t => !t.done).length}
              </span>
            )}
          </button>
        </div>

        <div className="header-actions">
          {/* WhatsApp status details */}
          <div className="status-pill">
            <span className={`status-dot ${connection.status}`}></span>
            <span style={{ textTransform: "capitalize" }}>
              {connection.status === "connected"
                ? `Logged in: ${connection.user || "Kumar"}`
                : connection.status === "connecting"
                ? "Connecting to WA..."
                : "Disconnected"}
            </span>
          </div>

          {connection.status === "disconnected" && (
            <button className="btn btn-primary" onClick={handleConnect}>
              Connect WhatsApp
            </button>
          )}

          {lastSyncedTime && (
            <span className="header-sync-time" style={{ fontSize: "11px", color: "var(--text-muted)", marginRight: "8px" }}>
              Last sync: {lastSyncedTime}
            </span>
          )}
          <button
            className="btn btn-header"
            onClick={handleForceSync}
            disabled={syncLoading}
          >
            <RefreshCw size={13} className={syncLoading ? "animate-spin" : ""} style={{ animation: syncLoading ? "spin 1s linear infinite" : "" }} />
            <span className="btn-text">{syncLoading ? "Syncing..." : "Force Sync"}</span>
          </button>

          {/* AFK Toggle & Settings Button */}
          <div style={{ position: "relative" }}>
            <div style={{ display: "flex", gap: "4px" }}>
              <button
                className={`btn btn-header ${afkState.active ? "btn-primary" : ""}`}
                style={afkState.active ? { background: "var(--color-critical)", border: "none", boxShadow: "var(--red-glow)" } : {}}
                onClick={() => handleToggleAfk(!afkState.active)}
              >
                <Shield size={13} />
                <span className="btn-text">{afkState.active ? "AFK ACTIVE" : "AFK OFF"}</span>
              </button>
              <button
                className="btn btn-header"
                style={{ padding: "6px 8px" }}
                onClick={() => setShowAfkSettings(!showAfkSettings)}
              >
                <Sliders size={13} />
              </button>
            </div>

            {showAfkSettings && (
              <div 
                style={{ 
                  position: "absolute", 
                  top: "40px", 
                  right: "0", 
                  width: "280px", 
                  background: "var(--bg-card)", 
                  border: "1px solid var(--border-color)", 
                  borderRadius: "var(--radius-lg)", 
                  padding: "16px", 
                  boxShadow: "0 10px 25px rgba(0,0,0,0.5)", 
                  zIndex: 100 
                }}
              >
                <h4 style={{ fontSize: "12px", marginBottom: "10px", color: "var(--text-primary)" }}>
                  Configure AFK Auto-Responder
                </h4>
                
                <div style={{ marginBottom: "10px" }}>
                  <label style={{ fontSize: "10px", color: "var(--text-muted)", display: "block", marginBottom: "4px" }}>
                    Auto-Reply Message:
                  </label>
                  <textarea
                    style={{ 
                      width: "100%", 
                      height: "60px", 
                      background: "var(--bg-primary)", 
                      border: "1px solid var(--border-color)", 
                      borderRadius: "var(--radius-sm)", 
                      color: "var(--text-primary)", 
                      padding: "6px", 
                      fontSize: "11px", 
                      fontFamily: "var(--font-sans)",
                      resize: "none"
                    }}
                    value={afkState.message}
                    onChange={(e) => setAfkState({ ...afkState, message: e.target.value })}
                  />
                  <div style={{ fontSize: "9px", color: "var(--text-muted)", marginTop: "2px" }}>
                    Signature will be automatically appended.
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "12px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", cursor: "pointer", color: "var(--text-secondary)" }}>
                    <input
                      type="checkbox"
                      checked={afkState.replyToDMs}
                      onChange={(e) => setAfkState({ ...afkState, replyToDMs: e.target.checked })}
                    />
                    Reply to Direct Messages (DMs)
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", cursor: "pointer", color: "var(--text-secondary)" }}>
                    <input
                      type="checkbox"
                      checked={afkState.replyToMentions}
                      onChange={(e) => setAfkState({ ...afkState, replyToMentions: e.target.checked })}
                    />
                    Reply to Group Mentions (@Kumar)
                  </label>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                  <button 
                    className="btn" 
                    style={{ padding: "4px 10px", fontSize: "10px" }}
                    onClick={() => setShowAfkSettings(false)}
                  >
                    Cancel
                  </button>
                  <button 
                    className="btn btn-primary" 
                    style={{ padding: "4px 10px", fontSize: "10px" }}
                    onClick={() => {
                      handleUpdateAfk(afkState);
                      setShowAfkSettings(false);
                    }}
                  >
                    Save Config
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* CONDITIONAL RENDER: DASHBOARD vs AFK LOG TAB */}
      {activeTab === "dashboard" && (
        <>
          {/* 2. THREE-PANEL CORE LAYOUT */}
      <div className="main-content">
        {/* PANEL A: SMART CHAT NAVIGATOR (LEFT) */}
        <aside className="panel">
          <div className="panel-header">
            <div className="panel-title">Smart Chat Navigator</div>
            <div style={{ position: "relative", width: "130px" }}>
              <input
                type="text"
                placeholder="Search..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                style={{
                  width: "100%",
                  background: "var(--bg-primary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "12px",
                  padding: "4px 8px 4px 24px",
                  fontSize: "11px",
                  color: "var(--text-primary)",
                  outline: "none"
                }}
              />
              <Search
                size={10}
                style={{
                  position: "absolute",
                  left: "8px",
                  top: "7px",
                  color: "var(--text-muted)"
                }}
              />
            </div>
          </div>

          {/* Segmented Filter Tabs */}
          <div style={{ display: "flex", gap: "4px", padding: "8px 12px", background: "rgba(18, 22, 26, 0.4)", borderBottom: "1px solid var(--border-color)" }}>
            <button
              className={`btn ${chatFilter === "all" ? "btn-primary" : ""}`}
              style={{ flex: 1, padding: "5px 8px", fontSize: "11px", borderRadius: "6px", justifyContent: "center" }}
              onClick={() => setChatFilter("all")}
            >
              All
            </button>
            <button
              className={`btn ${chatFilter === "personal" ? "btn-primary" : ""}`}
              style={{ flex: 1, padding: "5px 8px", fontSize: "11px", borderRadius: "6px", justifyContent: "center" }}
              onClick={() => setChatFilter("personal")}
            >
              👤 Personal
            </button>
            <button
              className={`btn ${chatFilter === "groups" ? "btn-primary" : ""}`}
              style={{ flex: 1, padding: "5px 8px", fontSize: "11px", borderRadius: "6px", justifyContent: "center" }}
              onClick={() => setChatFilter("groups")}
            >
              👥 Groups
            </button>
          </div>

          <div className="panel-body" style={{ padding: "12px 8px" }}>
            {/* DIRECT MESSAGES - INDIVIDUAL CONTACTS */}
            {(chatFilter === "all" || chatFilter === "personal") && (
              <div className="chat-list-section">
                <div className="section-label">
                  <span>🔵 Direct Messages (DMs)</span>
                  <span>{directMessages.length}</span>
                </div>
                {directMessages.map(c => (
                  <div
                    key={c.jid}
                    className={`chat-item ${activeChatJid === c.jid ? "active" : ""}`}
                    onClick={() => setActiveChatJid(c.jid)}
                  >
                    <div className="chat-item-header">
                      <div className="chat-name-container">
                        <User size={11} color="var(--color-gemini)" />
                        <span>{c.name}</span>
                      </div>
                      {c.unreadCount > 0 && (
                        <span className="unread-badge">{c.unreadCount}</span>
                      )}
                    </div>
                    <div className="chat-meta">
                      <span className={`priority-tag ${c.urgencyScore === "HIGH" ? "high" : c.urgencyScore === "MEDIUM" ? "medium" : "low"}`}>Priority: {c.priorityScore}</span>
                      {c.mentions > 0 && (
                        <span style={{ color: "var(--color-critical)", fontWeight: 600 }}>
                          @{c.mentions}
                        </span>
                      )}
                      {c.deadlineRisk && (
                        <span style={{ color: "var(--color-important)", fontSize: "10px" }}>
                          ⚠️ {c.deadlineRisk}
                        </span>
                      )}
                    </div>
                    {c.lastMessagePreview && (
                      <div className="chat-preview-text">
                        {c.lastIsFromMe ? "Me: " : ""}{c.lastMessagePreview}
                      </div>
                    )}

                    {/* AI Reason Bullets */}
                    {c.reasons.length > 0 && (
                      <div className="chat-reasons">
                        {c.reasons.map((r, i) => (
                          <div key={i} className="reason-bullet">
                            {r}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* TIER 1 - HIGH IMPORTANCE B-SCHOOL CHATS */}
            {(chatFilter === "all" || chatFilter === "groups") && (
              <div className="chat-list-section">
                <div className="section-label">
                  <span>🔴 Priority B-School threads (Tier 1)</span>
                  <span>{tier1Chats.length}</span>
                </div>
                {tier1Chats.map(c => (
                  <div
                    key={c.jid}
                    className={`chat-item ${activeChatJid === c.jid ? "active" : ""}`}
                    onClick={() => setActiveChatJid(c.jid)}
                  >
                    <div className="chat-item-header">
                      <div className="chat-name-container">
                        <Zap size={11} color="var(--color-important)" />
                        <span>{c.name}</span>
                      </div>
                      {c.unreadCount > 0 && (
                        <span className="unread-badge">{c.unreadCount}</span>
                      )}
                    </div>

                    <div className="chat-meta">
                      <span className="priority-tag high">Priority: {c.priorityScore}</span>
                      {c.mentions > 0 && (
                        <span style={{ color: "var(--color-critical)", fontWeight: 600 }}>
                          @{c.mentions}
                        </span>
                      )}
                      {c.deadlineRisk && (
                        <span style={{ color: "var(--color-important)", fontSize: "10px" }}>
                          ⚠️ {c.deadlineRisk}
                        </span>
                      )}
                    </div>
                    {c.lastMessagePreview && (
                      <div className="chat-preview-text">
                        {c.lastIsFromMe ? "Me: " : ""}{c.lastMessagePreview}
                      </div>
                    )}

                    {/* AI Reason Bullets */}
                    {c.reasons.length > 0 && (
                      <div className="chat-reasons">
                        {c.reasons.map((r, i) => (
                          <div key={i} className="reason-bullet">
                            {r}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* GENERAL GROUPS */}
            {(chatFilter === "all" || chatFilter === "groups") && (
              <div className="chat-list-section">
                <div className="section-label">
                  <span>⚪ General Groups (Tier 2/3)</span>
                  <span>{generalChats.length}</span>
                </div>
                {generalChats.map(c => (
                  <div
                    key={c.jid}
                    className={`chat-item ${activeChatJid === c.jid ? "active" : ""}`}
                    onClick={() => setActiveChatJid(c.jid)}
                  >
                    <div className="chat-item-header">
                      <div className="chat-name-container">
                        <Users size={11} color="var(--text-muted)" />
                        <span>{c.name}</span>
                      </div>
                      {c.unreadCount > 0 && (
                        <span className="unread-badge">{c.unreadCount}</span>
                      )}
                    </div>
                    <div className="chat-meta">
                      <span className="priority-tag low">Priority: {c.priorityScore}</span>
                      {c.mentions > 0 && (
                        <span style={{ color: "var(--color-critical)", fontWeight: 600 }}>
                          @{c.mentions}
                        </span>
                      )}
                      {c.deadlineRisk && (
                        <span style={{ color: "var(--color-important)", fontSize: "10px" }}>
                          ⚠️ {c.deadlineRisk}
                        </span>
                      )}
                    </div>
                    {c.lastMessagePreview && (
                      <div className="chat-preview-text">
                        {c.lastIsFromMe ? "Me: " : ""}{c.lastMessagePreview}
                      </div>
                    )}

                    {/* AI Reason Bullets */}
                    {c.reasons.length > 0 && (
                      <div className="chat-reasons">
                        {c.reasons.map((r, i) => (
                          <div key={i} className="reason-bullet">
                            {r}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* PANEL B: MAIN VIEW / AI INTELLIGENCE FEED (CENTER) */}
        <main className="panel" style={{ borderRight: "1px solid var(--border-color)" }}>
          {activeChatJid ? (
            /* ACTIVE CHAT WINDOW MODE */
            <div className="chat-window">
              <div className="panel-header">
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <button className="btn" style={{ padding: "4px 8px" }} onClick={() => setActiveChatJid(null)}>
                    <ArrowLeft size={14} />
                  </button>
                  <div>
                    <h4 style={{ fontSize: "14px" }}>{activeChat?.name}</h4>
                    <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
                      Priority score: {activeChat?.priorityScore}/100 • Urgency: {activeChat?.urgencyScore}
                    </span>
                  </div>
                </div>
                {activeChat?.deadlineRisk && (
                  <div className="priority-tag high" style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "4px" }}>
                    <AlertCircle size={12} /> Deadline: {activeChat.deadlineRisk}
                  </div>
                )}
              </div>

              <div className="chat-messages-container">
                {messages.length === 0 ? (
                  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%", color: "var(--text-muted)", fontSize: "13px" }}>
                    No messages synchronized yet in this chat.
                  </div>
                ) : (
                  messages.map(m => (
                    <div id={`msg-${m.id}`} key={m.id} className={`msg-wrapper ${m.isFromMe ? "me" : "other"}`}>
                      {!m.isFromMe && (
                        <span className="msg-sender-name">{m.senderDisplay}</span>
                      )}
                      <div 
                        className="msg-bubble"
                        style={
                          m.id === highlightedMessageId
                            ? {
                                border: "1px solid var(--color-gemini)",
                                boxShadow: "0 0 10px rgba(239, 68, 68, 0.4)",
                                background: "rgba(220, 38, 38, 0.15)",
                                transition: "all 0.3s ease",
                                animation: "pulse 0.8s infinite alternate"
                              }
                            : {}
                        }
                      >
                        <div>{m.content}</div>
                        <div className="msg-timestamp">
                          {new Date(m.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit"
                          })}
                        </div>
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {connection.status === "connected" ? (
                <form onSubmit={handleSendMessage} className="chat-input-area">
                  <input
                    type="text"
                    className="chat-input-text"
                    placeholder={`Reply to ${activeChat?.name}...`}
                    value={messageText}
                    onChange={e => setMessageText(e.target.value)}
                  />
                  <button type="submit" className="btn btn-primary" style={{ height: "38px" }}>
                    <Send size={14} />
                  </button>
                </form>
              ) : (
                <div style={{ background: "var(--bg-primary)", padding: "12px", borderTop: "1px solid var(--border-color)", textAlign: "center", color: "var(--text-muted)", fontSize: "12px" }}>
                  Connect WhatsApp via QR code at top to enable typing replies.
                </div>
              )}
            </div>
          ) : (
            /* EXECUTIVE dashboard CHIEF OF STAFF FEED MODE */
            <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
              <div className="panel-header">
                <div className="panel-title">
                  <Crosshair size={14} color="var(--color-gemini)" />
                  Executive Intelligence Feed
                </div>
                <button
                  className="btn btn-primary"
                  onClick={handleGenerateSummary}
                  disabled={aiSummaryLoading}
                >
                  {aiSummaryLoading ? (
                    <>
                      <Loader size={13} className="animate-spin" />
                      Analyzing Feed...
                    </>
                  ) : (
                    <>
                      <Crosshair size={13} />
                      Generate AI Summary
                    </>
                  )}
                </button>
              </div>

              {connection.status === "disconnected" && connection.qr && (
                /* QR Code Scan Invitation Banner if not logged in */
                <div style={{ margin: "16px", padding: "16px", background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "var(--radius-lg)" }}>
                  <h4 style={{ color: "var(--color-critical)", fontSize: "13px", display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
                    <Shield size={14} /> Login Required for Real-time Monitoring
                  </h4>
                  <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "12px" }}>
                    WhatsApp connection is currently logged out. To fetch your active chats and enable real-time tracking, scan the QR code using your WhatsApp phone client.
                  </p>
                  <div style={{ display: "flex", gap: "20px", alignItems: "center" }}>
                    <div style={{ background: "white", padding: "6px", borderRadius: "8px", width: "120px", height: "120px" }}>
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=108x108&data=${encodeURIComponent(connection.qr)}`}
                        alt="QR Code"
                        style={{ width: "108px", height: "108px" }}
                      />
                    </div>
                    <div>
                      <p style={{ fontSize: "11px", color: "var(--text-muted)", lineHeight: "1.5" }}>
                        1. Open WhatsApp on your phone.<br />
                        2. Tap Menu or Settings &gt; Linked Devices.<br />
                        3. Tap Link a Device and point your phone screen at this QR code.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="panel-body feed-grid">
                {/* 1. EXECUTIVE SUMMARY SECTION */}
                <div className="card">
                  <div className="card-title">
                    <Crosshair size={14} color="var(--color-gemini)" />
                    Last 24 Hours Executive Summary
                  </div>
                  {aiSummary ? (
                    <div
                      className="summary-bullets"
                      style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.6" }}
                      dangerouslySetInnerHTML={{
                        __html: aiSummary
                          .replace(/\n/g, "<br/>")
                          .replace(/\*(.*?)\*/g, "<strong>$1</strong>")
                          .replace(/•/g, "•")
                      }}
                    />
                  ) : (
                    <div className="summary-bullets">
                      <div className="summary-bullet-item">
                        <CheckSquare size={13} color="var(--color-whatsapp)" />
                        <span>Real-time B-school threads loaded. Click <strong>'Generate AI Summary'</strong> to consolidate recent case drafts, placement alerts, and mock test schedules into a briefing.</span>
                      </div>
                      <div className="summary-bullet-item">
                        <Users size={13} color="var(--color-gemini)" />
                        <span>Priority matrices automatically scan {chats.length} active chats and group chats to extract tasks.</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* 2. MENTIONS RADAR */}
                <div className="card">
                  <div className="card-title" style={{ justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <AlertCircle size={14} color="var(--color-critical)" />
                      Mention Radar (Tracked Mentions)
                    </div>
                    <span className="unread-badge" style={{ background: "rgba(239,68,68,0.2)", color: "#EF4444" }}>
                      {mentionsList.reduce((acc, curr) => acc + curr.count, 0)} total
                    </span>
                  </div>
                  {mentionsList.length === 0 ? (
                    <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      No direct mentions of your profile name "Kumar" found in recent messages.
                    </p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 }}>
                      {mentionsList.map(m => (
                        <div
                          key={m.jid}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "4px",
                            padding: "8px 10px",
                            background: "var(--bg-primary)",
                            border: "1px solid var(--border-color)",
                            borderRadius: "var(--radius-md)",
                            cursor: "pointer",
                            minWidth: 0
                          }}
                          onClick={() => setActiveChatJid(m.jid)}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: "12px" }}>{m.chatName}</span>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                              <span style={{ color: "var(--color-critical)", fontWeight: 600, fontSize: "11px" }}>
                                {m.count} mention{m.count > 1 ? "s" : ""}
                              </span>
                              <button
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  color: "var(--text-muted)",
                                  cursor: "pointer",
                                  fontSize: "14px",
                                  padding: "2px 4px",
                                  lineHeight: 1,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  borderRadius: "4px",
                                  transition: "color 0.2s"
                                }}
                                title="Clear mentions"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const chatObj = chats.find(c => c.jid === m.jid);
                                  if (chatObj) {
                                    setDismissedMentionsMap(prev => ({
                                      ...prev,
                                      [m.jid]: chatObj.mentions
                                    }));
                                  }
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.color = "var(--color-critical)"}
                                onMouseLeave={(e) => e.currentTarget.style.color = "var(--text-muted)"}
                              >
                                &times;
                              </button>
                            </div>
                          </div>
                          {m.context && (
                            <div style={{ fontSize: "10.5px", color: "var(--text-secondary)", fontStyle: "italic", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: 0.85, marginTop: "2px" }}>
                              {m.context}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 3. PRIORITY TASK ENGINE & MATRIX */}
                <div className="card">
                  <div className="card-title">
                    <CheckSquare size={14} color="var(--color-whatsapp)" />
                    Smart Priority Matrix (AI Task Engine)
                  </div>
                  <div className="matrix-grid">
                    {/* P1 Quadrant */}
                    <div className="matrix-quadrant">
                      <div className="quadrant-title p1" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>🔴 P1 - Critical</span>
                        {matrixTasks.filter(t => t.priority === "P1").length > 0 && (
                          <button
                            className="btn"
                            style={{ fontSize: "9px", padding: "1px 5px", background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)", color: "var(--color-critical)" }}
                            onClick={() => handleClearPriorityTasks("P1")}
                          >
                            Clear All
                          </button>
                        )}
                      </div>
                      {matrixTasks.filter(t => t.priority === "P1").length === 0 ? (
                        <p style={{ fontSize: "11px", color: "var(--text-muted)", fontStyle: "italic", marginTop: "4px" }}>No critical tasks</p>
                      ) : (
                        matrixTasks.filter(t => t.priority === "P1").map(t => (
                          <div key={t.id} className="task-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                            <div style={{ display: "flex", gap: "8px", flex: 1, minWidth: 0 }}>
                              <input
                                type="checkbox"
                                className="task-checkbox"
                                checked={t.done}
                                onChange={() => toggleTask(t.id)}
                                style={{ marginTop: "2px" }}
                              />
                              <span style={{ textDecoration: t.done ? "line-through" : "none", opacity: t.done ? 0.5 : 1, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                                <strong>{t.text}</strong>
                                <div style={{ fontSize: "9px", color: "var(--text-muted)", marginTop: "2px", display: "flex", flexDirection: "column", gap: "2px" }}>
                                  <div>Source: {t.source} • Due: {t.deadline}</div>
                                  {t.chatJid && t.messageId && (
                                    <button
                                      className="btn"
                                      style={{ fontSize: "9px", padding: "1px 4px", background: "rgba(220, 38, 38, 0.12)", borderColor: "rgba(220, 38, 38, 0.25)", color: "var(--color-gemini)", cursor: "pointer", width: "max-content", height: "18px", marginTop: "2px" }}
                                      onClick={() => handleNavigateToDeadline(t.chatJid, t.messageId)}
                                    >
                                      Locate &rarr;
                                    </button>
                                  )}
                                </div>
                              </span>
                            </div>
                            <button
                              className="btn"
                              style={{ fontSize: "11px", padding: "0 4px", color: "var(--text-muted)", background: "transparent", border: "none", cursor: "pointer", lineHeight: 1 }}
                              onClick={() => handleRemoveMatrixTask(t)}
                              title="Delete task"
                            >
                              &times;
                            </button>
                          </div>
                        ))
                      )}
                    </div>

                    {/* P2 Quadrant */}
                    <div className="matrix-quadrant">
                      <div className="quadrant-title p2" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>🟠 P2 - Important</span>
                        {matrixTasks.filter(t => t.priority === "P2").length > 0 && (
                          <button
                            className="btn"
                            style={{ fontSize: "9px", padding: "1px 5px", background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)", color: "var(--color-critical)" }}
                            onClick={() => handleClearPriorityTasks("P2")}
                          >
                            Clear All
                          </button>
                        )}
                      </div>
                      {matrixTasks.filter(t => t.priority === "P2").length === 0 ? (
                        <p style={{ fontSize: "11px", color: "var(--text-muted)", fontStyle: "italic", marginTop: "4px" }}>No important tasks</p>
                      ) : (
                        matrixTasks.filter(t => t.priority === "P2").map(t => (
                          <div key={t.id} className="task-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                            <div style={{ display: "flex", gap: "8px", flex: 1, minWidth: 0 }}>
                              <input
                                type="checkbox"
                                className="task-checkbox"
                                checked={t.done}
                                onChange={() => toggleTask(t.id)}
                                style={{ marginTop: "2px" }}
                              />
                              <span style={{ textDecoration: t.done ? "line-through" : "none", opacity: t.done ? 0.5 : 1, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                                <strong>{t.text}</strong>
                                <div style={{ fontSize: "9px", color: "var(--text-muted)", marginTop: "2px", display: "flex", flexDirection: "column", gap: "2px" }}>
                                  <div>Source: {t.source} • Due: {t.deadline}</div>
                                  {t.chatJid && t.messageId && (
                                    <button
                                      className="btn"
                                      style={{ fontSize: "9px", padding: "1px 4px", background: "rgba(220, 38, 38, 0.12)", borderColor: "rgba(220, 38, 38, 0.25)", color: "var(--color-gemini)", cursor: "pointer", width: "max-content", height: "18px", marginTop: "2px" }}
                                      onClick={() => handleNavigateToDeadline(t.chatJid, t.messageId)}
                                    >
                                      Locate &rarr;
                                    </button>
                                  )}
                                </div>
                              </span>
                            </div>
                            <button
                              className="btn"
                              style={{ fontSize: "11px", padding: "0 4px", color: "var(--text-muted)", background: "transparent", border: "none", cursor: "pointer", lineHeight: 1 }}
                              onClick={() => handleRemoveMatrixTask(t)}
                              title="Delete task"
                            >
                              &times;
                            </button>
                          </div>
                        ))
                      )}
                    </div>

                    {/* P3 Quadrant */}
                    <div className="matrix-quadrant">
                      <div className="quadrant-title p3" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>🔵 P3 - Optional</span>
                        {matrixTasks.filter(t => t.priority === "P3").length > 0 && (
                          <button
                            className="btn"
                            style={{ fontSize: "9px", padding: "1px 5px", background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)", color: "var(--color-critical)" }}
                            onClick={() => handleClearPriorityTasks("P3")}
                          >
                            Clear All
                          </button>
                        )}
                      </div>
                      {matrixTasks.filter(t => t.priority === "P3").length === 0 ? (
                        <p style={{ fontSize: "11px", color: "var(--text-muted)", fontStyle: "italic", marginTop: "4px" }}>No optional tasks</p>
                      ) : (
                        matrixTasks.filter(t => t.priority === "P3").map(t => (
                          <div key={t.id} className="task-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                            <div style={{ display: "flex", gap: "8px", flex: 1, minWidth: 0 }}>
                              <input
                                type="checkbox"
                                className="task-checkbox"
                                checked={t.done}
                                onChange={() => toggleTask(t.id)}
                                style={{ marginTop: "2px" }}
                              />
                              <span style={{ textDecoration: t.done ? "line-through" : "none", opacity: t.done ? 0.5 : 1, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                                <strong>{t.text}</strong>
                                <div style={{ fontSize: "9px", color: "var(--text-muted)", marginTop: "2px", display: "flex", flexDirection: "column", gap: "2px" }}>
                                  <div>Source: {t.source} • Due: {t.deadline}</div>
                                  {t.chatJid && t.messageId && (
                                    <button
                                      className="btn"
                                      style={{ fontSize: "9px", padding: "1px 4px", background: "rgba(220, 38, 38, 0.12)", borderColor: "rgba(220, 38, 38, 0.25)", color: "var(--color-gemini)", cursor: "pointer", width: "max-content", height: "18px", marginTop: "2px" }}
                                      onClick={() => handleNavigateToDeadline(t.chatJid, t.messageId)}
                                    >
                                      Locate &rarr;
                                    </button>
                                  )}
                                </div>
                              </span>
                            </div>
                            <button
                              className="btn"
                              style={{ fontSize: "11px", padding: "0 4px", color: "var(--text-muted)", background: "transparent", border: "none", cursor: "pointer", lineHeight: 1 }}
                              onClick={() => handleRemoveMatrixTask(t)}
                              title="Delete task"
                            >
                              &times;
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {/* 4. AI DEADLINE RISK ENGINE */}
                <div className="card">
                  <div className="card-title">
                    <Clock size={14} color="var(--color-important)" />
                    AI Active Deadline Risks
                  </div>
                  {deadlineRiskChats.length === 0 ? (
                    <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      No imminent deadline dates detected in your conversations.
                    </p>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                      {deadlineRiskChats.map(c => (
                        <div
                          key={c.jid}
                          style={{
                            border: "1px solid var(--border-color)",
                            background: "var(--bg-primary)",
                            padding: "10px",
                            borderRadius: "var(--radius-md)",
                            cursor: "pointer",
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "space-between"
                          }}
                          onClick={() => setActiveChatJid(c.jid)}
                        >
                          <div>
                            <div style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "4px" }}>
                              {c.name}
                            </div>
                            <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-critical)" }}>
                              ⚠️ {c.deadlineRisk}
                            </div>
                            <div style={{ fontSize: "10px", color: "var(--text-secondary)", marginTop: "4px", marginBottom: "8px" }}>
                              Context: "{c.lastMessagePreview?.substring(0, 45)}..."
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: "6px", borderTop: "1px solid var(--border-color)", paddingTop: "6px", marginTop: "auto" }}>
                            <button
                              className="btn"
                              style={{ flex: 1, fontSize: "9px", padding: "2px 4px", justifyContent: "center", background: "rgba(16, 185, 129, 0.1)", borderColor: "rgba(16, 185, 129, 0.2)", color: "var(--color-whatsapp)" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDismissChatDeadline(c.jid);
                              }}
                            >
                              Dismiss
                            </button>
                            <button
                              className="btn btn-primary"
                              style={{ flex: 1, fontSize: "9px", padding: "2px 4px", justifyContent: "center" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAddChatDeadlineTodo(c);
                              }}
                            >
                              + To-Do
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>

        {/* PANEL C: GEMINI TERMINAL (RIGHT) */}
        <aside className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <TerminalIcon size={14} color="var(--color-gemini)" />
              AI Command Terminal
            </div>
            <button className="btn" style={{ padding: "4px 8px" }} onClick={() => handleExecuteCommand("> clear")}>
              Clear
            </button>
          </div>

          <div className="panel-body terminal-container">
            <div className="terminal-history">
              {terminalHistory.map((line, idx) => (
                <div key={idx} className="terminal-line">
                  {line.type === "command" && (
                    <span className="terminal-command-input">{line.text}</span>
                  )}
                  {line.type === "output" && (
                    <div
                      className="terminal-output"
                      dangerouslySetInnerHTML={{
                        __html: line.text
                          .replace(/\n/g, "<br/>")
                          .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                      }}
                    />
                  )}
                  {line.type === "info" && (
                    <span style={{ color: "var(--text-muted)" }}>{line.text}</span>
                  )}
                  {line.type === "error" && (
                    <span style={{ color: "var(--color-critical)" }}>{line.text}</span>
                  )}
                </div>
              ))}
              <div ref={terminalEndRef} />
            </div>

            {/* Suggestions Toolbar */}
            <div style={{ marginBottom: "12px" }}>
              <div style={{ fontSize: "10px", color: "var(--text-muted)", marginBottom: "6px", fontWeight: 600, textTransform: "uppercase" }}>
                Suggested Commands:
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                <button
                  className="btn"
                  style={{ fontSize: "10px", padding: "3px 6px" }}
                  onClick={() => handleExecuteCommand("> prepare briefing for today's call")}
                >
                  Daily Briefing
                </button>
                <button
                  className="btn"
                  style={{ fontSize: "10px", padding: "3px 6px" }}
                  onClick={() => handleExecuteCommand("> extract all deadlines")}
                >
                  Deadlines List
                </button>
                <button
                  className="btn"
                  style={{ fontSize: "10px", padding: "3px 6px" }}
                  onClick={() => handleExecuteCommand("> list approvals pending")}
                >
                  List Approvals
                </button>
                <button
                  className="btn"
                  style={{ fontSize: "10px", padding: "3px 6px" }}
                  onClick={() => handleExecuteCommand("> find all messages mentioning shipment")}
                >
                  Search mentions
                </button>
              </div>
            </div>

            <div className="terminal-prompt-line">
              <span className="terminal-caret">&gt;</span>
              <input
                type="text"
                className="terminal-input"
                placeholder="Enter command (e.g. summarize...)"
                value={terminalInput}
                onChange={e => setTerminalInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    const val = terminalInput.startsWith(">") ? terminalInput : `> ${terminalInput}`;
                    handleExecuteCommand(val);
                  }
                }}
              />
            </div>
          </div>
        </aside>
      </div>

      {/* 3. TIMELINE / ANALYTICS / KNOWLEDGE GRAPH PANEL (BOTTOM) */}
      <footer className="bottom-panel">
        {/* WIDGET 1: HEATMAP */}
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
          <div className="bottom-widget-title">
            <Activity size={12} style={{ marginRight: "4px", verticalAlign: "middle" }} />
            Most Active Groups (Heatmap)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {chats.slice(0, 3).map((c, i) => (
              <div key={c.jid}>
                <div className="heatmap-bar">
                  <span>{c.name}</span>
                  <span style={{ color: "var(--text-muted)" }}>{90 - i * 15}% activity</span>
                </div>
                <div className="bar-outer">
                  <div className="bar-inner" style={{ width: `${90 - i * 15}%` }}></div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* WIDGET 2: DEADLINES DETAILS */}
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", minWidth: 0 }}>
          <div className="bottom-widget-title">
            <Clock size={12} style={{ marginRight: "4px", verticalAlign: "middle" }} />
            Imminent Deadlines Tracker
          </div>
          <div 
            style={{ 
              background: "var(--bg-primary)", 
              border: "1px solid var(--border-color)", 
              borderRadius: "var(--radius-md)", 
              flex: 1,
              minHeight: 0,
              overflowY: "auto", 
              padding: "8px" 
            }}
          >
            {deadlinesList.filter(d => !dismissedMessageIds.includes(d.id)).length === 0 ? (
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%", color: "var(--text-muted)", fontSize: "11px" }}>
                No active deadlines found in recent chats.
              </div>
            ) : (
              deadlinesList.filter(d => !dismissedMessageIds.includes(d.id)).map((d) => (
                <div 
                  key={d.id} 
                  style={{ 
                    display: "flex", 
                    justifyContent: "space-between", 
                    alignItems: "center", 
                    borderBottom: "1px solid var(--border-color)", 
                    padding: "6px 0", 
                    fontSize: "11px" 
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, paddingRight: "10px" }}>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center", marginBottom: "2px" }}>
                      <span style={{ color: "var(--color-critical)", fontWeight: "bold" }}>[{d.deadlineText}]</span>
                      <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>{d.chatName}</span>
                    </div>
                    <div style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {d.senderName}: {d.content}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "4px" }}>
                    <button 
                      className="btn" 
                      style={{ fontSize: "9px", padding: "2px 6px" }}
                      onClick={() => handleNavigateToDeadline(d.chatJid, d.id)}
                      title="Locate message in chat"
                    >
                      Locate
                    </button>
                    <button 
                      className="btn" 
                      style={{ fontSize: "9px", padding: "2px 6px", background: "rgba(16, 185, 129, 0.1)", borderColor: "rgba(16, 185, 129, 0.2)", color: "var(--color-whatsapp)" }}
                      onClick={() => handleDismissMessageDeadline(d.id)}
                      title="Verify and Dismiss"
                    >
                      Dismiss
                    </button>
                    <button 
                      className="btn btn-primary" 
                      style={{ fontSize: "9px", padding: "2px 6px" }}
                      onClick={() => handleAddMessageDeadlineTodo(d)}
                      title="Add to To-Do List"
                    >
                      + To-Do
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* WIDGET 3: EXCLUSIONS CONTROL PANEL */}
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", minWidth: 0 }}>
          <div className="bottom-widget-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>
              <Settings size={12} style={{ marginRight: "4px", verticalAlign: "middle" }} />
              Tracking Exclusions Control
            </span>
            <button 
              className="btn btn-primary" 
              style={{ fontSize: "9px", padding: "1px 6px" }}
              onClick={handleSaveIgnoredGroupsSettings}
            >
              Save Exclusions
            </button>
          </div>
          <div 
            style={{ 
              background: "var(--bg-primary)", 
              border: "1px solid var(--border-color)", 
              borderRadius: "var(--radius-md)", 
              flex: 1,
              minHeight: 0,
              overflowY: "auto", 
              padding: "6px" 
            }}
          >
            {chats.filter(c => c.isGroup).length === 0 ? (
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%", color: "var(--text-muted)", fontSize: "11px" }}>
                No groups found.
              </div>
            ) : (
              chats.filter(c => c.isGroup).map(c => {
                const setting = ignoredGroupsSettings.find(g => g.jid === c.jid) || {
                  jid: c.jid,
                  name: c.name,
                  ignoreMentions: false,
                  ignoreDeadlines: false,
                  ignoreTasks: false
                };

                const handleToggleSetting = (field: "ignoreMentions" | "ignoreDeadlines" | "ignoreTasks") => {
                  setIgnoredGroupsSettings(prev => {
                    const existingIdx = prev.findIndex(g => g.jid === c.jid);
                    if (existingIdx > -1) {
                      const updated = [...prev];
                      updated[existingIdx] = {
                        ...updated[existingIdx],
                        [field]: !updated[existingIdx][field]
                      };
                      return updated;
                    } else {
                      return [...prev, {
                        jid: c.jid,
                        name: c.name,
                        ignoreMentions: field === "ignoreMentions",
                        ignoreDeadlines: field === "ignoreDeadlines",
                        ignoreTasks: field === "ignoreTasks"
                      }];
                    }
                  });
                };

                return (
                  <div key={c.jid} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-color)", padding: "4px 0", fontSize: "11px" }}>
                    <div style={{ flex: 1, minWidth: 0, paddingRight: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.name}>
                      {c.name}
                    </div>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: "2px", fontSize: "9px", color: "var(--text-muted)", cursor: "pointer" }} title="Ignore Mentions">
                        <input
                          type="checkbox"
                          checked={setting.ignoreMentions}
                          onChange={() => handleToggleSetting("ignoreMentions")}
                          style={{ cursor: "pointer", transform: "scale(0.85)" }}
                        />
                        M
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: "2px", fontSize: "9px", color: "var(--text-muted)", cursor: "pointer" }} title="Ignore Deadlines">
                        <input
                          type="checkbox"
                          checked={setting.ignoreDeadlines}
                          onChange={() => handleToggleSetting("ignoreDeadlines")}
                          style={{ cursor: "pointer", transform: "scale(0.85)" }}
                        />
                        D
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: "2px", fontSize: "9px", color: "var(--text-muted)", cursor: "pointer" }} title="Ignore Tasks">
                        <input
                          type="checkbox"
                          checked={setting.ignoreTasks}
                          onChange={() => handleToggleSetting("ignoreTasks")}
                          style={{ cursor: "pointer", transform: "scale(0.85)" }}
                        />
                        T
                      </label>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </footer>
        </>
      )}

      {activeTab === "afk-log" && (
        /* ============================================================ */
        /* AFK LOG TAB                                                  */
        /* ============================================================ */
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "16px", gap: "12px" }}>
          {/* Header Row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", borderRadius: "8px", background: "rgba(220,38,38,0.15)", border: "1px solid rgba(220,38,38,0.3)" }}>
                <MessageSquare size={16} color="var(--color-critical)" />
              </div>
              <div>
                <h2 style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>AFK Auto-Reply Log</h2>
                <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: 0 }}>
                  Messages that triggered an AFK auto-response while you were away
                </p>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)", padding: "6px 12px", fontSize: "12px" }}>
                <Shield size={12} color={afkState.active ? "var(--color-critical)" : "var(--text-muted)"} />
                <span style={{ color: afkState.active ? "var(--color-critical)" : "var(--text-muted)" }}>
                  AFK Mode: {afkState.active ? "ACTIVE" : "OFF"}
                </span>
              </div>
              <button
                className="btn"
                style={{ fontSize: "11px" }}
                onClick={fetchAfkLog}
              >
                <RefreshCw size={12} />
                Refresh
              </button>
              {afkLog.length > 0 && (
                <button
                  className="btn"
                  style={{ fontSize: "11px", color: "var(--color-critical)", borderColor: "rgba(220,38,38,0.3)" }}
                  onClick={handleClearAfkLog}
                >
                  <Trash2 size={12} />
                  Clear Log
                </button>
              )}
            </div>
          </div>

          {/* Stats bar */}
          {afkLog.length > 0 && (
            <div style={{ display: "flex", gap: "12px" }}>
              {[
                { label: "Total Triggers", value: afkLog.length, color: "var(--color-critical)" },
                { label: "DM Replies", value: afkLog.filter(e => e.type === "dm").length, color: "var(--color-gemini)" },
                { label: "Group Mentions", value: afkLog.filter(e => e.type === "mention").length, color: "var(--color-important)" },
                { label: "Unique Chats", value: new Set(afkLog.map(e => e.chatJid)).size, color: "var(--color-whatsapp)" },
              ].map(stat => (
                <div key={stat.label} style={{ flex: 1, background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)", padding: "10px 14px" }}>
                  <div style={{ fontSize: "20px", fontWeight: 700, color: stat.color }}>{stat.value}</div>
                  <div style={{ fontSize: "10px", color: "var(--text-muted)", textTransform: "uppercase", marginTop: "2px" }}>{stat.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Log entries */}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "10px" }}>
            {afkLog.length === 0 ? (
              <div style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-muted)",
                gap: "12px",
                padding: "60px 0"
              }}>
                <div style={{ width: "60px", height: "60px", borderRadius: "50%", background: "var(--bg-card)", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--border-color)" }}>
                  <MessageSquare size={28} color="var(--border-color)" />
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "6px", color: "var(--text-secondary)" }}>No AFK triggers yet</div>
                  <div style={{ fontSize: "12px", lineHeight: 1.6 }}>
                    When AFK mode is active, any message that receives an auto-reply<br/>
                    will appear here with full context.
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  style={{ background: "var(--color-critical)", border: "none", boxShadow: "var(--red-glow)", marginTop: "8px" }}
                  onClick={() => handleToggleAfk(true)}
                >
                  <Shield size={13} /> Activate AFK Mode
                </button>
              </div>
            ) : (
              afkLog.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "var(--radius-lg)",
                    padding: "14px 16px",
                    transition: "border-color 0.2s",
                    position: "relative",
                    overflow: "hidden",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(220,38,38,0.4)")}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--border-color)")}
                >
                  {/* Left accent bar */}
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "3px", background: entry.type === "dm" ? "var(--color-gemini)" : "var(--color-important)" }} />

                  {/* Header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: entry.type === "dm" ? "rgba(239,68,68,0.15)" : "rgba(245,158,11,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {entry.type === "dm" ? <User size={14} color="var(--color-gemini)" /> : <Users size={14} color="var(--color-important)" />}
                      </div>
                      <div>
                        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>{entry.chatName}</div>
                        <div style={{ fontSize: "10px", color: "var(--text-muted)" }}>
                          From: {entry.senderDisplay} &nbsp;•&nbsp;
                          <span style={{ color: entry.type === "dm" ? "var(--color-gemini)" : "var(--color-important)", textTransform: "uppercase", fontWeight: 600, fontSize: "9px" }}>
                            {entry.type === "dm" ? "Direct Message" : "Group Mention"}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
                        <Clock size={10} style={{ display: "inline", marginRight: "3px", verticalAlign: "middle" }} />
                        {new Date(entry.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <button
                        className="btn"
                        style={{ fontSize: "10px", padding: "2px 8px" }}
                        onClick={() => { setActiveChatJid(entry.chatJid); setActiveTab("dashboard"); }}
                      >
                        Open Chat →
                      </button>
                    </div>
                  </div>

                  {/* Message content */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                    {/* Incoming */}
                    <div style={{ background: "var(--bg-primary)", borderRadius: "var(--radius-md)", padding: "10px" }}>
                      <div style={{ fontSize: "9px", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 600, marginBottom: "6px", display: "flex", alignItems: "center", gap: "4px" }}>
                        <AlertCircle size={9} /> Incoming Message
                      </div>
                      <div style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                        {entry.incomingContent}
                      </div>
                    </div>
                    {/* AFK Reply */}
                    <div style={{ background: "rgba(220,38,38,0.05)", border: "1px solid rgba(220,38,38,0.15)", borderRadius: "var(--radius-md)", padding: "10px" }}>
                      <div style={{ fontSize: "9px", color: "var(--color-critical)", textTransform: "uppercase", fontWeight: 600, marginBottom: "6px", display: "flex", alignItems: "center", gap: "4px" }}>
                        <Shield size={9} /> AFK Auto-Reply Sent
                      </div>
                      <div style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5, whiteSpace: "pre-line" }}>
                        {entry.afkReplyContent}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === "todo" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "20px", gap: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-color)", paddingBottom: "12px" }}>
            <div>
              <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-display)" }}>📝 Verified Deadlines To-Do List</h2>
              <p style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                Keep track of verified deadlines and assignments. Items checked off here represent completed operations tasks.
              </p>
            </div>
            {todoTasks.length > 0 && (
              <button
                className="btn"
                style={{ fontSize: "11px", padding: "4px 10px", background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)", color: "var(--color-critical)" }}
                onClick={() => {
                  if (confirm("Clear all items from To-Do List?")) {
                    const idsToUndismiss = todoTasks.map(t => t.id);
                    setTodoTasks([]);
                    setDismissedChatJids(prev => prev.filter(jid => !idsToUndismiss.includes(jid)));
                    setDismissedMessageIds(prev => prev.filter(id => !idsToUndismiss.includes(id)));
                  }
                }}
              >
                Clear All Tasks
              </button>
            )}
          </div>

          <div style={{ flex: 1, overflowY: "auto", background: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-lg)", padding: "16px" }}>
            {todoTasks.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", height: "100%", gap: "12px", color: "var(--text-muted)" }}>
                <CheckSquare size={32} style={{ opacity: 0.3 }} />
                <div style={{ fontSize: "13px", fontWeight: 500 }}>Your To-Do List is empty.</div>
                <div style={{ fontSize: "11px" }}>Go to the Dashboard and click "+ To-Do" on active deadlines or imminent tracker items to verify and track them here.</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {todoTasks.map(task => (
                  <div
                    key={task.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: task.done ? "rgba(38, 46, 53, 0.2)" : "var(--bg-primary)",
                      border: "1px solid var(--border-color)",
                      padding: "12px",
                      borderRadius: "var(--radius-md)",
                      transition: "all 0.2s ease",
                      opacity: task.done ? 0.6 : 1
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1, minWidth: 0 }}>
                      <input
                        type="checkbox"
                        checked={task.done}
                        onChange={() => {
                          setTodoTasks(prev =>
                            prev.map(t => (t.id === task.id ? { ...t, done: !t.done } : t))
                          );
                        }}
                        style={{ cursor: "pointer", transform: "scale(1.2)" }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: "13px",
                          fontWeight: 500,
                          color: task.done ? "var(--text-muted)" : "var(--text-primary)",
                          textDecoration: task.done ? "line-through" : "none",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap"
                        }}>
                          {task.text}
                        </div>
                        <div style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "4px" }}>
                          Source: {task.source}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "16px" }}>
                      {task.chatJid && (
                        <button
                          className="btn"
                          style={{ fontSize: "10px", padding: "4px 8px" }}
                          onClick={() => {
                            setActiveTab("dashboard");
                            handleNavigateToDeadline(task.chatJid, task.messageId);
                          }}
                        >
                          Locate Message
                        </button>
                      )}
                      <button
                        className="btn"
                        style={{ fontSize: "10px", padding: "4px 8px", color: "var(--color-critical)", background: "rgba(239, 68, 68, 0.05)", borderColor: "rgba(239, 68, 68, 0.15)" }}
                        onClick={() => {
                          setTodoTasks(prev => prev.filter(t => t.id !== task.id));
                          setDismissedChatJids(prev => prev.filter(jid => jid !== task.id));
                          setDismissedMessageIds(prev => prev.filter(id => id !== task.id));
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

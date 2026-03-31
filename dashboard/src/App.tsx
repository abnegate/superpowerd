import { useState, useEffect, useRef, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import Overview from "./pages/Overview";
import UsagePage from "./pages/Usage";
import HistoryPage from "./pages/History";
import SessionsPage from "./pages/Sessions";
import LogsPage from "./pages/Logs";

interface MonitorInfo {
  running: boolean;
  pid: string | null;
}

interface Status {
  accounts: string[];
  current: number;
  email: string;
  timestamp: string | null;
  monitor: MonitorInfo;
}

interface AuthInfo {
  authenticated: boolean;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
}

interface DailyEntry {
  date: string;
  messages: number;
  tokens: number;
  tools: number;
}

interface Usage {
  activeSessions: number;
  today: { messages: number; tokens: number; tools: number; rateLimits: number };
  totals: { messages: number; tokens: number; sessions: number; cost: number };
  tokenExpiry: string | null;
  dailyActivity: DailyEntry[];
}

const PAGE_MAP: Record<string, string> = {
  "": "overview",
  overview: "overview",
  usage: "usage",
  history: "history",
  sessions: "sessions",
  logs: "logs",
};

function getPageFromHash(): string {
  const hash = window.location.hash.replace("#/", "").replace("#", "");
  return PAGE_MAP[hash] ?? "overview";
}

export default function App() {
  const [page, setPage] = useState(getPageFromHash);
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [claudeUsage, setClaudeUsage] = useState<any>(null);
  const [sessions, setSessions] = useState<any>(null);
  const [history, setHistory] = useState<any>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [rotating, setRotating] = useState(false);

  const navigate = useCallback((target: string) => {
    setPage(target);
    window.location.hash = target === "overview" ? "/" : "/" + target;
  }, []);

  useEffect(() => {
    const handler = () => setPage(getPageFromHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const [s, a, u, sess, hist] = await Promise.all([
        fetch("/api/status"),
        fetch("/api/auth"),
        fetch("/api/usage"),
        fetch("/api/sessions"),
        fetch("/api/history"),
      ]);
      setStatus(await s.json());
      setAuth(await a.json());
      setUsage(await u.json());
      setSessions(await sess.json());
      const historyData = await hist.json();
      if (!historyData.error) setHistory(historyData);
    } catch {}
    try {
      const response = await fetch("/api/claude-usage");
      const data = await response.json();
      if (!data.error) setClaudeUsage(data);
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  useEffect(() => {
    const source = new EventSource("/api/logs");
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setLogs((previous) => [...previous.slice(-500), data.line]);
    };
    return () => source.close();
  }, []);

  async function handleRotate(email?: string) {
    setRotating(true);
    try {
      await fetch("/api/rotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setTimeout(fetchAll, 3000);
    } finally {
      setTimeout(() => setRotating(false), 5000);
    }
  }

  async function handleMonitor(action: "start" | "stop") {
    await fetch("/api/monitor/" + action, { method: "POST" });
    setTimeout(fetchAll, 1000);
  }

  if (!status) {
    return (
      <div className="app-shell">
        <div className="loading">
          <div className="loading-text">
            super<span>powerd</span>
          </div>
          <div className="loading-sub">connecting...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        page={page}
        onNavigate={navigate}
        monitorRunning={status.monitor.running}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />
      <main className={`main-content ${collapsed ? "expanded" : ""}`}>
        {page === "overview" && (
          <Overview
            status={status}
            auth={auth}
            usage={usage}
            claudeUsage={claudeUsage}
            sessions={sessions}
            onRotate={handleRotate}
            onMonitor={handleMonitor}
            rotating={rotating}
          />
        )}
        {page === "usage" && (
          <UsagePage claudeUsage={claudeUsage} logs={logs} />
        )}
        {page === "history" && <HistoryPage history={history} />}
        {page === "sessions" && (
          <SessionsPage sessions={sessions} history={history} />
        )}
        {page === "logs" && <LogsPage logs={logs} />}
      </main>
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import Overview from "./pages/Overview";
import History from "./pages/History";

export default function App() {
  const [page, setPage] = useState(() => {
    const hash = window.location.hash.replace("#/", "").replace("#", "");
    return hash === "history" ? "history" : "overview";
  });
  const [status, setStatus] = useState<any>(null);
  const [auth, setAuth] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
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
    const handler = () => {
      const hash = window.location.hash.replace("#/", "").replace("#", "");
      setPage(hash === "history" ? "history" : "overview");
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const [s, a, u, sess, hist] = await Promise.all([
        fetch("/api/status"), fetch("/api/auth"), fetch("/api/usage"),
        fetch("/api/sessions"), fetch("/api/history"),
      ]);
      setStatus(await s.json());
      setAuth(await a.json());
      setUsage(await u.json());
      setSessions(await sess.json());
      const h = await hist.json();
      if (!h.error) setHistory(h);
    } catch {}
    try {
      const r = await fetch("/api/claude-usage");
      const d = await r.json();
      if (!d.error) setClaudeUsage(d);
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
      setLogs((prev) => [...prev.slice(-500), data.line]);
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
    return <div className="app-shell"><div className="empty" style={{ margin: "auto" }}>connecting...</div></div>;
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} onNavigate={navigate} monitorRunning={status.monitor.running} />
      <main className="main-content">
        {page === "overview" && (
          <Overview
            status={status} auth={auth} usage={usage} claudeUsage={claudeUsage}
            sessions={sessions} logs={logs} onRotate={handleRotate}
            onMonitor={handleMonitor} rotating={rotating}
          />
        )}
        {page === "history" && <History history={history} />}
      </main>
    </div>
  );
}

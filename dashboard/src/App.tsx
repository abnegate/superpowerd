import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";

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

function formatLogLine(line: string): ReactNode {
  const match = line.match(/^\[([^\]]+)\]\s*(.*)/);
  if (!match) return <span>{line}</span>;

  const [, timestamp, rest] = match;
  let className = "";
  if (rest.includes("!!!") || rest.includes("Signal")) className = "signal";
  else if (rest.includes("[rotate]")) className = "rotate";
  else if (rest.includes("Now using") || rest.includes("Switched")) className = "success";

  return (
    <>
      <span className="timestamp">[{timestamp}]</span>{" "}
      <span className={className}>{rest}</span>
    </>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [rotating, setRotating] = useState(false);
  const logsEnd = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [statusResponse, authResponse] = await Promise.all([
        fetch("/api/status"),
        fetch("/api/auth"),
      ]);
      setStatus(await statusResponse.json());
      setAuth(await authResponse.json());
    } catch {
      // server not reachable
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    const source = new EventSource("/api/logs");
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setLogs((previous) => [...previous.slice(-500), data.line]);
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    logsEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  async function handleRotate(email?: string) {
    setRotating(true);
    try {
      await fetch("/api/rotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setTimeout(fetchStatus, 3000);
    } finally {
      setTimeout(() => setRotating(false), 5000);
    }
  }

  async function handleMonitor(action: "start" | "stop") {
    await fetch("/api/monitor/" + action, { method: "POST" });
    setTimeout(fetchStatus, 1000);
  }

  if (!status) {
    return (
      <div className="app">
        <div className="empty">Connecting to server...</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>
          super<span>powerd</span>
        </h1>
        <div className={`badge ${status.monitor.running ? "running" : "stopped"}`}>
          <div className={`dot ${status.monitor.running ? "pulse" : ""}`} />
          Monitor {status.monitor.running ? "active" : "idle"}
        </div>
      </header>

      <div className="grid">
        <div className="card">
          <h2>Accounts</h2>
          <div className="accounts">
            {status.accounts.map((email, i) => (
              <div key={email} className={`account ${i === status.current ? "active" : ""}`}>
                <span className="email">{email}</span>
                {i === status.current ? (
                  <span className="label">ACTIVE</span>
                ) : (
                  <button onClick={() => handleRotate(email)} disabled={rotating}>
                    Switch
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2>CLI Auth</h2>
          {auth?.authenticated ? (
            <div className="auth-info">
              <div className="auth-row">
                <span className="key">Email</span>
                <span className="value">{auth.email}</span>
              </div>
              <div className="auth-row">
                <span className="key">Plan</span>
                <span className="value">{auth.subscriptionType}</span>
              </div>
              <div className="auth-row">
                <span className="key">Org</span>
                <span className="value">{auth.orgName}</span>
              </div>
            </div>
          ) : (
            <div className="empty">Not authenticated</div>
          )}

          <div style={{ marginTop: 20 }}>
            <h2>Controls</h2>
            <div className="controls">
              <button className="primary" onClick={() => handleRotate()} disabled={rotating}>
                {rotating ? "Rotating..." : "Rotate Next"}
              </button>
              {status.monitor.running ? (
                <button className="danger" onClick={() => handleMonitor("stop")}>
                  Stop Monitor
                </button>
              ) : (
                <button onClick={() => handleMonitor("start")}>Start Monitor</button>
              )}
            </div>
          </div>
        </div>

        <div className="card full">
          <h2>Log Stream</h2>
          <div className="logs">
            {logs.length === 0 ? (
              <div className="empty">
                No log entries yet. Start the monitor to begin watching for rate limits.
              </div>
            ) : (
              logs.map((line, i) => (
                <div key={i} className="log-line">
                  {formatLogLine(line)}
                </div>
              ))
            )}
            <div ref={logsEnd} />
          </div>
        </div>
      </div>
    </div>
  );
}

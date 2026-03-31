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

interface Usage {
  activeSessions: number;
  today: { messages: number; tokens: number; tools: number; rateLimits: number };
  totals: { messages: number; tokens: number; sessions: number };
  tokenExpiry: string | null;
  dailyActivity: Array<{ date: string; messages: number; tokens: number }>;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toString();
}

function formatLogLine(line: string): ReactNode {
  const match = line.match(/^\[([^\]]+)\]\s*(.*)/);
  if (!match) return <span>{line}</span>;

  const [, timestamp, rest] = match;
  let className = "";
  if (rest.includes("!!!") || rest.includes("Signal")) className = "signal";
  else if (rest.includes("[rotate]")) className = "rotate";
  else if (rest.includes("Now using") || rest.includes("Switched") || rest.includes("===")) className = "success";

  return (
    <>
      <span className="timestamp">{timestamp}</span>{" "}
      <span className={className}>{rest}</span>
    </>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="metric">
      <div className="metric-value">
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

function Sparkline({ data, height = 32 }: { data: number[]; height?: number }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const width = 100;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (v / max) * (height - 4);
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="sparkline" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="var(--green)" strokeWidth="1.5" />
    </svg>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [rotating, setRotating] = useState(false);
  const logsEnd = useRef<HTMLDivElement>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusResponse, authResponse, usageResponse] = await Promise.all([
        fetch("/api/status"),
        fetch("/api/auth"),
        fetch("/api/usage"),
      ]);
      setStatus(await statusResponse.json());
      setAuth(await authResponse.json());
      setUsage(await usageResponse.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
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
      <div className="app">
        <div className="empty">connecting...</div>
      </div>
    );
  }

  const tokenExpiryMinutes = usage?.tokenExpiry
    ? Math.max(0, Math.floor((new Date(usage.tokenExpiry).getTime() - Date.now()) / 60000))
    : null;

  return (
    <div className="app">
      <header>
        <h1>super<span>powerd</span></h1>
        <div className={`badge ${status.monitor.running ? "running" : "stopped"}`}>
          <div className="dot" />
          {status.monitor.running ? "monitoring" : "idle"}
        </div>
      </header>

      <div className="grid">
        <div className="card full metrics-row">
          <Metric
            label="active sessions"
            value={String(usage?.activeSessions ?? 0)}
          />
          <Metric
            label="today messages"
            value={formatNumber(usage?.today.messages ?? 0)}
          />
          <Metric
            label="today tokens"
            value={formatNumber(usage?.today.tokens ?? 0)}
          />
          <Metric
            label="today tools"
            value={formatNumber(usage?.today.tools ?? 0)}
          />
          <Metric
            label="rate limits today"
            value={String(usage?.today.rateLimits ?? 0)}
          />
          {tokenExpiryMinutes !== null && (
            <Metric
              label="token expires"
              value={String(tokenExpiryMinutes)}
              unit="min"
            />
          )}
        </div>

        <div className="card">
          <h2>// accounts</h2>
          <div className="accounts">
            {status.accounts.map((email, i) => (
              <div key={email} className={`account ${i === status.current ? "active" : ""}`}>
                <span className="email">{email}</span>
                {i === status.current ? (
                  <span className="label">active</span>
                ) : (
                  <button onClick={() => handleRotate(email)} disabled={rotating}>
                    switch
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="controls">
            <button className="primary" onClick={() => handleRotate()} disabled={rotating}>
              {rotating ? "rotating..." : "rotate next"}
            </button>
          </div>
        </div>

        <div className="card">
          <h2>// auth</h2>
          {auth?.authenticated ? (
            <div className="auth-info">
              <div className="auth-row">
                <span className="key">email</span>
                <span className="value">{auth.email}</span>
              </div>
              <div className="auth-row">
                <span className="key">plan</span>
                <span className="value">{auth.subscriptionType}</span>
              </div>
              <div className="auth-row">
                <span className="key">org</span>
                <span className="value">{auth.orgName}</span>
              </div>
              <div className="auth-row">
                <span className="key">sessions</span>
                <span className="value">{formatNumber(usage?.totals.sessions ?? 0)} total</span>
              </div>
              <div className="auth-row">
                <span className="key">messages</span>
                <span className="value">{formatNumber(usage?.totals.messages ?? 0)} total</span>
              </div>
              <div className="auth-row">
                <span className="key">tokens</span>
                <span className="value">{formatNumber(usage?.totals.tokens ?? 0)} total</span>
              </div>
            </div>
          ) : (
            <div className="empty">not authenticated</div>
          )}
          <div className="controls">
            {status.monitor.running ? (
              <button className="danger" onClick={() => handleMonitor("stop")}>
                stop monitor
              </button>
            ) : (
              <button onClick={() => handleMonitor("start")}>start monitor</button>
            )}
          </div>
        </div>

        {usage && usage.dailyActivity.length > 1 && (
          <div className="card full">
            <h2>// 14-day activity</h2>
            <div className="sparkline-row">
              <div className="sparkline-block">
                <div className="sparkline-label">messages</div>
                <Sparkline data={usage.dailyActivity.map((d) => d.messages)} height={40} />
              </div>
              <div className="sparkline-block">
                <div className="sparkline-label">tokens</div>
                <Sparkline data={usage.dailyActivity.map((d) => d.tokens)} height={40} />
              </div>
            </div>
          </div>
        )}

        <div className="card full">
          <h2>// log stream</h2>
          <div className="logs">
            {logs.length === 0 ? (
              <div className="empty">waiting for log entries...</div>
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

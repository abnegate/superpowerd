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
  else if (rest.includes("Now using") || rest.includes("===")) className = "success";
  return (
    <>
      <span className="timestamp">{timestamp}</span>{" "}
      <span className={className}>{rest}</span>
    </>
  );
}

function Sparkline({ data, height = 48 }: { data: number[]; height?: number }) {
  if (data.length < 2) return <div className="sparkline-empty">no data</div>;
  const max = Math.max(...data, 1);
  const width = 200;
  const step = width / (data.length - 1);

  const points = data.map((v, i) => `${i * step},${height - (v / max) * (height - 6)}`).join(" ");
  const fillPoints = `0,${height} ${points} ${(data.length - 1) * step},${height}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="sparkline" preserveAspectRatio="none">
      <polygon points={fillPoints} fill="url(#sparkFill)" />
      <polyline points={points} fill="none" stroke="var(--green)" strokeWidth="1.5" />
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--green)" stopOpacity="0.15" />
          <stop offset="100%" stopColor="var(--green)" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function UsageBar({ label, percent, reset }: { label: string; percent: number; reset: string | null }) {
  const minutes = reset ? Math.max(0, Math.floor((new Date(reset).getTime() - Date.now()) / 60000)) : null;
  const hours = minutes !== null ? Math.floor(minutes / 60) : null;
  const remaining = hours !== null && hours > 0 ? hours + "h " + (minutes! % 60) + "m" : minutes !== null ? minutes + "m" : "";
  const color = percent >= 90 ? "var(--red)" : percent >= 70 ? "var(--bright-orange)" : "var(--green)";

  return (
    <div className="usage-bar-row">
      <div className="usage-bar-header">
        <span className="key">{label}</span>
        <span className="usage-bar-stats">
          <span style={{ color }}>{percent}%</span>
          {remaining && <span className="dim"> resets {remaining}</span>}
        </span>
      </div>
      <div className="usage-bar-track">
        <div className="usage-bar-fill" style={{ width: percent + "%", background: color }} />
      </div>
    </div>
  );
}

type ChartRange = 1 | 7 | 14 | 30;

function ActivityChart({ activity }: { activity: DailyEntry[] }) {
  const [range, setRange] = useState<ChartRange>(14);
  const data = activity.slice(-range);
  const ranges: ChartRange[] = [1, 7, 14, 30];

  const latestMessages = data.length > 0 ? data[data.length - 1].messages : 0;
  const latestTokens = data.length > 0 ? data[data.length - 1].tokens : 0;
  const totalMessages = data.reduce((sum, d) => sum + d.messages, 0);
  const totalTokens = data.reduce((sum, d) => sum + d.tokens, 0);

  return (
    <>
      <div className="chart-header">
        <h2>// activity</h2>
        <div className="chart-tabs">
          {ranges.map((r) => (
            <button
              key={r}
              className={`chart-tab ${range === r ? "active" : ""}`}
              onClick={() => setRange(r)}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>
      <div className="chart-grid">
        <div className="chart-block">
          <div className="chart-block-header">
            <span className="chart-block-label">messages</span>
            <span className="chart-block-value">{formatNumber(totalMessages)} total</span>
          </div>
          <Sparkline data={data.map((d) => d.messages)} />
          <div className="chart-block-footer">
            <span>latest: {formatNumber(latestMessages)}</span>
            <span>avg: {formatNumber(data.length > 0 ? Math.round(totalMessages / data.length) : 0)}/day</span>
          </div>
        </div>
        <div className="chart-block">
          <div className="chart-block-header">
            <span className="chart-block-label">tokens</span>
            <span className="chart-block-value">{formatNumber(totalTokens)} total</span>
          </div>
          <Sparkline data={data.map((d) => d.tokens)} />
          <div className="chart-block-footer">
            <span>latest: {formatNumber(latestTokens)}</span>
            <span>avg: {formatNumber(data.length > 0 ? Math.round(totalTokens / data.length) : 0)}/day</span>
          </div>
        </div>
      </div>
    </>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [claudeUsage, setClaudeUsage] = useState<Record<string, unknown> | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [rotating, setRotating] = useState(false);
  const logsEnd = useRef<HTMLDivElement>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [s, a, u] = await Promise.all([
        fetch("/api/status"),
        fetch("/api/auth"),
        fetch("/api/usage"),
      ]);
      setStatus(await s.json());
      setAuth(await a.json());
      setUsage(await u.json());
    } catch {}
    // Fetch Claude usage separately (may be rate limited)
    try {
      const cu = await fetch("/api/claude-usage");
      const data = await cu.json();
      if (!data.error) setClaudeUsage(data);
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
      setLogs((prev) => [...prev.slice(-500), data.line]);
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

  const tokenMinutes = usage?.tokenExpiry
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
        <div className="card full">
          <div className="metrics">
            <div className="metric">
              <div className="metric-value">{usage?.activeSessions ?? 0}</div>
              <div className="metric-label">sessions</div>
            </div>
            <div className="metric">
              <div className="metric-value">{formatNumber(usage?.today.messages ?? 0)}</div>
              <div className="metric-label">messages</div>
            </div>
            <div className="metric">
              <div className="metric-value">{formatNumber(usage?.today.tokens ?? 0)}</div>
              <div className="metric-label">tokens</div>
            </div>
            <div className="metric">
              <div className="metric-value">{formatNumber(usage?.today.tools ?? 0)}</div>
              <div className="metric-label">tool calls</div>
            </div>
            <div className="metric">
              <div className={`metric-value ${(usage?.today.rateLimits ?? 0) > 0 ? "warn" : ""}`}>
                {usage?.today.rateLimits ?? 0}
              </div>
              <div className="metric-label">429s</div>
            </div>
            {tokenMinutes !== null && (
              <div className="metric">
                <div className={`metric-value ${tokenMinutes < 30 ? "warn" : ""}`}>
                  {tokenMinutes}<span className="metric-unit">m</span>
                </div>
                <div className="metric-label">token ttl</div>
              </div>
            )}
          </div>
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
                  <button onClick={() => handleRotate(email)} disabled={rotating}>switch</button>
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
              {claudeUsage && (claudeUsage as any).five_hour && (
                <>
                  <div className="auth-row section-break">
                    <span className="key">current usage</span>
                    <span className="value dim" />
                  </div>
                  <UsageBar
                    label="5-hour"
                    percent={(claudeUsage as any).five_hour.utilization}
                    reset={(claudeUsage as any).five_hour.resets_at}
                  />
                  <UsageBar
                    label="7-day"
                    percent={(claudeUsage as any).seven_day.utilization}
                    reset={(claudeUsage as any).seven_day.resets_at}
                  />
                </>
              )}
              <div className="auth-row section-break">
                <span className="key">all accounts</span>
                <span className="value dim" />
              </div>
              <div className="auth-row">
                <span className="key">sessions</span>
                <span className="value">{formatNumber(usage?.totals.sessions ?? 0)}</span>
              </div>
              <div className="auth-row">
                <span className="key">messages</span>
                <span className="value">{formatNumber(usage?.totals.messages ?? 0)}</span>
              </div>
              <div className="auth-row">
                <span className="key">tokens</span>
                <span className="value">{formatNumber(usage?.totals.tokens ?? 0)}</span>
              </div>
              <div className="auth-row">
                <span className="key">api value</span>
                <span className="value cost">
                  ${(usage?.totals.cost ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </div>
            </div>
          ) : (
            <div className="empty">not authenticated</div>
          )}
          <div className="controls">
            {status.monitor.running ? (
              <button className="danger" onClick={() => handleMonitor("stop")}>stop monitor</button>
            ) : (
              <button onClick={() => handleMonitor("start")}>start monitor</button>
            )}
          </div>
        </div>

        {usage && usage.dailyActivity.length > 1 && (
          <div className="card full">
            <ActivityChart activity={usage.dailyActivity} />
          </div>
        )}

        <div className="card full">
          <h2>// log stream</h2>
          <div className="logs">
            {logs.length === 0 ? (
              <div className="empty">waiting for log entries...</div>
            ) : (
              logs.map((line, i) => (
                <div key={i} className="log-line">{formatLogLine(line)}</div>
              ))
            )}
            <div ref={logsEnd} />
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import UsageBar from "./components/UsageBar";
import { formatNumber, formatCurrency, formatLogLine, Sparkline, BarChart, AreaChart, MiniMetric } from "./components/Charts";

interface Status {
  accounts: string[];
  current: number;
  email: string;
  monitor: { running: boolean };
}

type ChartRange = 7 | 14 | 30;
type CostRange = 14 | 30 | 90 | 0;
type LogFilter = "all" | "rotations" | "limits" | "errors";

export default function App() {
  const [status, setStatus] = useState<any>(null);
  const [auth, setAuth] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const [claudeUsage, setClaudeUsage] = useState<any>(null);
  const [sessions, setSessions] = useState<any>(null);
  const [history, setHistory] = useState<any>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [rotating, setRotating] = useState(false);
  const [range, setRange] = useState<ChartRange>(14);
  const [costRange, setCostRange] = useState<CostRange>(30);
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const logsEnd = useRef<HTMLDivElement>(null);

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

  const activity = usage?.dailyActivity ?? [];
  const activityData = activity.slice(-range);
  const dailyCosts = history?.dailyCosts ?? [];
  const filteredCosts = costRange === 0 ? dailyCosts : dailyCosts.slice(-costRange);
  const repos = history?.repos ?? [];

  const cumulativeCosts = useMemo(() => {
    let running = 0;
    return dailyCosts.map((d: any) => {
      running += d.cost;
      return { date: d.date, total: running };
    });
  }, [dailyCosts]);
  const cumulativeFiltered = costRange === 0 ? cumulativeCosts : cumulativeCosts.slice(-costRange);

  const filteredLogs = useMemo(() => {
    switch (logFilter) {
      case "rotations":
        return logs.filter((l) => l.includes("[rotate]") || l.includes("Now using") || l.includes("rotating"));
      case "limits":
        return logs.filter((l) => l.includes("!!!") || l.includes("429") || l.includes("Signal") || l.includes("rate limit"));
      case "errors":
        return logs.filter((l) => l.includes("ERROR") || l.includes("error") || l.includes("failed"));
      default:
        return logs;
    }
  }, [logs, logFilter]);

  const tokenMinutes = usage?.tokenExpiry
    ? Math.max(0, Math.floor((new Date(usage.tokenExpiry).getTime() - Date.now()) / 60000))
    : null;

  if (!status) {
    return <div className="app"><div className="empty">connecting...</div></div>;
  }

  return (
    <div className="app">
      <header>
        <h1>super<span>powerd</span></h1>
        <div className={`badge ${status.monitor.running ? "running" : "stopped"}`}>
          <div className="dot" />
          {status.monitor.running ? "monitoring" : "idle"}
        </div>
      </header>

      {/* Metrics bar */}
      <div className="card full">
        <div className="metrics">
          <MiniMetric value={String(usage?.activeSessions ?? 0)} label="sessions" />
          <MiniMetric value={formatNumber(usage?.today.messages ?? 0)} label="messages" />
          <MiniMetric value={formatNumber(usage?.today.tokens ?? 0)} label="tokens" />
          <MiniMetric value={formatNumber(usage?.today.tools ?? 0)} label="tool calls" />
          <MiniMetric value={String(usage?.today.rateLimits ?? 0)} label="429s" warn={(usage?.today.rateLimits ?? 0) > 0} />
          {tokenMinutes !== null && (
            <MiniMetric value={String(tokenMinutes)} label="token ttl" unit="m" warn={tokenMinutes < 30} />
          )}
        </div>
      </div>

      <div className="grid">
        {/* Accounts */}
        <div className="card">
          <h2>// accounts</h2>
          <div className="accounts">
            {status.accounts.map((email: string, i: number) => (
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
            {status.monitor.running ? (
              <button className="danger" onClick={() => handleMonitor("stop")}>stop monitor</button>
            ) : (
              <button onClick={() => handleMonitor("start")}>start monitor</button>
            )}
          </div>
        </div>

        {/* Auth + lifetime */}
        <div className="card">
          <h2>// auth</h2>
          {auth?.authenticated ? (
            <div className="auth-info">
              <div className="auth-row"><span className="key">email</span><span className="value">{auth.email}</span></div>
              <div className="auth-row"><span className="key">plan</span><span className="value">{auth.subscriptionType}</span></div>
              <div className="auth-row"><span className="key">org</span><span className="value">{auth.orgName}</span></div>
              <div className="auth-row section-break"><span className="key">lifetime</span><span className="value dim" /></div>
              <div className="auth-row"><span className="key">sessions</span><span className="value">{formatNumber(usage?.totals.sessions ?? 0)}</span></div>
              <div className="auth-row"><span className="key">messages</span><span className="value">{formatNumber(usage?.totals.messages ?? 0)}</span></div>
              <div className="auth-row"><span className="key">api value</span><span className="value cost">${(usage?.totals.cost ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
            </div>
          ) : (
            <div className="empty">not authenticated</div>
          )}
        </div>
      </div>

      {/* Pool utilization */}
      {claudeUsage?.accounts && (
        <div className="card full">
          <h2>// pool utilization</h2>
          {claudeUsage.pooled?.fiveHour !== null && (
            <div className="usage-pool">
              <div className="usage-pool-header">
                <span>pool ({claudeUsage.pooled.accountCount} accounts)</span>
                {claudeUsage.estimatedSwapMinutes !== null && (
                  <span className="dim">swap in ~{claudeUsage.estimatedSwapMinutes}m</span>
                )}
              </div>
              <UsageBar label="5-hour" percent={claudeUsage.pooled.fiveHour} reset={null} />
              <UsageBar label="7-day" percent={claudeUsage.pooled.sevenDay} reset={null} />
            </div>
          )}
          <div className="usage-accounts">
            {Object.entries(claudeUsage.accounts).map(([email, data]: [string, any]) =>
              data?.five_hour && !data.error ? (
                <div key={email} className="usage-account">
                  <div className="usage-account-header">
                    <span>{email.split("@")[0]}</span>
                    <span className="dim">{data.live ? "live" : data.staleMinutes !== undefined ? data.staleMinutes + "m ago" : ""}</span>
                  </div>
                  <UsageBar label="5-hour" percent={data.five_hour.utilization} reset={data.live ? data.five_hour.resets_at : null} />
                  <UsageBar label="7-day" percent={data.seven_day.utilization} reset={data.live ? data.seven_day.resets_at : null} />
                </div>
              ) : data?.error ? (
                <div key={email} className="usage-account">
                  <div className="usage-account-header">
                    <span>{email.split("@")[0]}</span>
                    <span className="dim">{data.error}</span>
                  </div>
                </div>
              ) : null
            )}
          </div>
        </div>
      )}

      {/* Active sessions */}
      {sessions?.sessions?.length > 0 && (
        <div className="card full">
          <h2>// active sessions ({sessions.sessions.length}, ${sessions.totalCost} api value)</h2>
          <table className="sessions-table">
            <thead><tr><th>repo</th><th>messages</th><th>output</th><th>cache</th><th>cost</th></tr></thead>
            <tbody>
              {sessions.sessions.map((s: any) => (
                <tr key={s.session}>
                  <td className="session-repo">{s.repo}</td>
                  <td>{formatNumber(s.messages)}</td>
                  <td>{formatNumber(s.output)}</td>
                  <td>{formatNumber(s.cacheRead)}</td>
                  <td className="session-cost">${s.cost.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Activity sparklines */}
      {activity.length > 1 && (
        <div className="card full">
          <div className="chart-header">
            <h2>// activity</h2>
            <div className="chart-tabs">
              {([7, 14, 30] as ChartRange[]).map((r) => (
                <button key={r} className={`chart-tab ${range === r ? "active" : ""}`} onClick={() => setRange(r)}>{r}d</button>
              ))}
            </div>
          </div>
          <div className="chart-grid">
            <div className="chart-block">
              <div className="chart-block-header">
                <span className="chart-block-label">messages</span>
                <span className="chart-block-value">{formatNumber(activityData.reduce((s: number, d: any) => s + d.messages, 0))} total</span>
              </div>
              <Sparkline data={activityData.map((d: any) => d.messages)} labels={activityData.map((d: any) => d.date)} valueFormatter={(n) => formatNumber(n)} height={100} />
            </div>
            <div className="chart-block">
              <div className="chart-block-header">
                <span className="chart-block-label">tokens</span>
                <span className="chart-block-value">{formatNumber(activityData.reduce((s: number, d: any) => s + d.tokens, 0))} total</span>
              </div>
              <Sparkline data={activityData.map((d: any) => d.tokens)} labels={activityData.map((d: any) => d.date)} valueFormatter={(n) => formatNumber(n)} height={100} />
            </div>
          </div>
        </div>
      )}

      {/* Daily cost + cumulative */}
      {history && dailyCosts.length > 1 && (
        <div className="card full">
          <div className="chart-header">
            <h2>// daily cost ({history.totalSessions} sessions, ${formatNumber(history.totalCost)} total)</h2>
            <div className="chart-tabs">
              {([14, 30, 90, 0] as CostRange[]).map((r) => (
                <button key={r} className={`chart-tab ${costRange === r ? "active" : ""}`} onClick={() => setCostRange(r)}>{r === 0 ? "all" : r + "d"}</button>
              ))}
            </div>
          </div>
          <BarChart
            data={filteredCosts.map((d: any) => d.cost)}
            labels={filteredCosts.map((d: any) => d.date)}
            height={180}
            valueFormatter={(n) => "$" + n.toFixed(0)}
          />
          <div className="chart-block-footer" style={{ marginTop: 8 }}>
            <span>avg: ${filteredCosts.length > 0 ? (filteredCosts.reduce((s: number, d: any) => s + d.cost, 0) / filteredCosts.length).toFixed(0) : 0}/day</span>
            <span>total: ${filteredCosts.reduce((s: number, d: any) => s + d.cost, 0).toFixed(0)}</span>
          </div>
        </div>
      )}

      {cumulativeFiltered.length > 1 && (
        <div className="card full">
          <h2>// cumulative cost</h2>
          <AreaChart
            data={cumulativeFiltered.map((d: any) => d.total)}
            labels={cumulativeFiltered.map((d: any) => d.date)}
            height={160}
            color="var(--bright-green)"
            valueFormatter={(n) => "$" + formatNumber(n)}
          />
        </div>
      )}

      {/* Per-repo breakdown */}
      {repos.length > 0 && (
        <div className="card full">
          <h2>// per-repo breakdown</h2>
          <BarChart
            data={repos.slice(0, 12).map((r: any) => r.cost)}
            labels={repos.slice(0, 12).map((r: any) => r.repo)}
            horizontal
            height={repos.slice(0, 12).length * 32}
            valueFormatter={(n) => "$" + formatNumber(n)}
          />
        </div>
      )}

      {/* Log stream */}
      <div className="card full">
        <div className="chart-header">
          <h2>// log stream</h2>
          <div className="chart-tabs">
            {(["all", "rotations", "limits", "errors"] as LogFilter[]).map((f) => (
              <button key={f} className={`chart-tab ${logFilter === f ? "active" : ""}`} onClick={() => setLogFilter(f)}>{f}</button>
            ))}
          </div>
        </div>
        <div className="logs">
          {filteredLogs.length === 0 ? (
            <div className="empty">waiting for log entries...</div>
          ) : (
            filteredLogs.map((line, i) => (
              <div key={i} className="log-line">{formatLogLine(line)}</div>
            ))
          )}
          <div ref={logsEnd} />
        </div>
      </div>
    </div>
  );
}

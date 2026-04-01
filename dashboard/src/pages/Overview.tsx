import { useState, useRef, useEffect, useMemo } from "react";
import UsageBar from "../components/UsageBar";
import { formatNumber, formatLogLine, Sparkline, MiniMetric } from "../components/Charts";

type ChartRange = 7 | 14 | 30;
type LogFilter = "all" | "rotations" | "limits" | "errors";

export default function Overview({ status, auth, usage, claudeUsage, sessions, logs, onRotate, onMonitor, rotating }: any) {
  const [range, setRange] = useState<ChartRange>(14);
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const logsEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const activity = usage?.dailyActivity ?? [];
  const data = activity.slice(-range);

  const filteredLogs = useMemo(() => {
    switch (logFilter) {
      case "rotations": return logs.filter((l: string) => l.includes("[rotate]") || l.includes("Now using") || l.includes("rotating"));
      case "limits": return logs.filter((l: string) => l.includes("!!!") || l.includes("429") || l.includes("Signal") || l.includes("rate limit"));
      case "errors": return logs.filter((l: string) => l.includes("ERROR") || l.includes("error") || l.includes("failed"));
      default: return logs;
    }
  }, [logs, logFilter]);

  const tokenMinutes = usage?.tokenExpiry
    ? Math.max(0, Math.floor((new Date(usage.tokenExpiry).getTime() - Date.now()) / 60000))
    : null;

  return (
    <div className="page">
      {/* Metrics */}
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
                  <button onClick={() => onRotate(email)} disabled={rotating}>switch</button>
                )}
              </div>
            ))}
          </div>
          <div className="controls">
            <button className="primary" onClick={() => onRotate()} disabled={rotating}>
              {rotating ? "rotating..." : "rotate next"}
            </button>
            {status.monitor.running ? (
              <button className="danger" onClick={() => onMonitor("stop")}>stop monitor</button>
            ) : (
              <button onClick={() => onMonitor("start")}>start monitor</button>
            )}
          </div>
        </div>

        {/* Auth */}
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
            {Object.entries(claudeUsage.accounts).map(([email, d]: [string, any]) =>
              d?.five_hour && !d.error ? (
                <div key={email} className="usage-account">
                  <div className="usage-account-header">
                    <span>{email.split("@")[0]}</span>
                    <span className="dim">{d.live ? "live" : d.staleMinutes !== undefined ? d.staleMinutes + "m ago" : ""}</span>
                  </div>
                  <UsageBar label="5-hour" percent={d.five_hour.utilization} reset={d.live ? d.five_hour.resets_at : null} />
                  <UsageBar label="7-day" percent={d.seven_day.utilization} reset={d.live ? d.seven_day.resets_at : null} />
                </div>
              ) : d?.error ? (
                <div key={email} className="usage-account">
                  <div className="usage-account-header"><span>{email.split("@")[0]}</span><span className="dim">{d.error}</span></div>
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
                <span className="chart-block-value">{formatNumber(data.reduce((s: number, d: any) => s + d.messages, 0))} total</span>
              </div>
              <Sparkline data={data.map((d: any) => d.messages)} labels={data.map((d: any) => d.date)} valueFormatter={(n: number) => formatNumber(n)} height={100} />
            </div>
            <div className="chart-block">
              <div className="chart-block-header">
                <span className="chart-block-label">tokens</span>
                <span className="chart-block-value">{formatNumber(data.reduce((s: number, d: any) => s + d.tokens, 0))} total</span>
              </div>
              <Sparkline data={data.map((d: any) => d.tokens)} labels={data.map((d: any) => d.date)} valueFormatter={(n: number) => formatNumber(n)} height={100} />
            </div>
          </div>
        </div>
      )}

      {/* Logs */}
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
            filteredLogs.map((line: string, i: number) => (
              <div key={i} className="log-line">{formatLogLine(line)}</div>
            ))
          )}
          <div ref={logsEnd} />
        </div>
      </div>
    </div>
  );
}

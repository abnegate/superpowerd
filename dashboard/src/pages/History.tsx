import { useState, useMemo } from "react";
import { formatNumber, formatCurrency, BarChart, AreaChart, Sparkline, MiniMetric } from "../components/Charts";

type CostRange = 14 | 30 | 90 | 0;

function HourHeatmap({ data }: { data: Record<string, number> }) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const max = Math.max(...hours.map((h) => data[String(h)] || 0), 1);

  return (
    <div>
      <div style={{ display: "flex", gap: 2 }}>
        {hours.map((h) => {
          const count = data[String(h)] || 0;
          const intensity = count / max;
          const bg = count === 0 ? "var(--border)"
            : intensity < 0.2 ? "rgba(65, 168, 62, 0.2)"
            : intensity < 0.4 ? "rgba(65, 168, 62, 0.4)"
            : intensity < 0.6 ? "rgba(65, 168, 62, 0.6)"
            : intensity < 0.8 ? "rgba(115, 218, 112, 0.8)"
            : "var(--bright-green)";
          return (
            <div
              key={h}
              title={`${h}:00 — ${count} prompts`}
              style={{ flex: 1, height: 32, background: bg }}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
          <span key={h} style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)" }}>
            {h === 0 ? "12a" : h < 12 ? h + "a" : h === 12 ? "12p" : (h - 12) + "p"}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function History({ history, usage, extended }: { history: any; usage: any; extended: any }) {
  const [costRange, setCostRange] = useState<CostRange>(30);
  const [promptRange, setPromptRange] = useState<CostRange>(30);

  const dailyCosts = history?.dailyCosts ?? [];
  const repos = history?.repos ?? [];
  const filteredCosts = costRange === 0 ? dailyCosts : dailyCosts.slice(-costRange);

  const dailyPrompts = extended?.dailyPrompts ?? [];
  const filteredPrompts = promptRange === 0 ? dailyPrompts : dailyPrompts.slice(-promptRange);

  const cumulativeCosts = useMemo(() => {
    let running = 0;
    return dailyCosts.map((d: any) => { running += d.cost; return { date: d.date, total: running }; });
  }, [dailyCosts]);
  const cumulativeFiltered = costRange === 0 ? cumulativeCosts : cumulativeCosts.slice(-costRange);

  if (!history) {
    return <div className="page"><div className="card full"><div className="empty">loading history...</div></div></div>;
  }

  return (
    <div className="page">
      {/* Header stats */}
      <div className="card full">
        <div className="metrics">
          <MiniMetric value={formatNumber(extended?.total ?? 0)} label="total prompts" />
          <MiniMetric value={String(extended?.daysActive ?? 0)} label="days active" />
          <MiniMetric value={formatNumber(history?.totalSessions ?? 0)} label="sessions indexed" />
          <div className="metric">
            <div className="metric-value cost">${formatNumber(history?.totalCost ?? 0)}</div>
            <div className="metric-label">avg/day</div>
          </div>
        </div>
      </div>

      {/* Daily cost bar chart */}
      {filteredCosts.length > 1 && (
        <div className="card full">
          <div className="chart-header">
            <h2>// daily cost</h2>
            <div className="chart-tabs">
              {([14, 30, 90, 0] as CostRange[]).map((r) => (
                <button key={r} className={`chart-tab ${costRange === r ? "active" : ""}`} onClick={() => setCostRange(r)}>
                  {r === 0 ? "all" : r + "d"}
                </button>
              ))}
            </div>
          </div>
          <BarChart
            data={filteredCosts.map((d: any) => d.cost)}
            labels={filteredCosts.map((d: any) => d.date)}
            height={220}
            valueFormatter={(n: number) => "$" + n.toFixed(0)}
          />
          <div className="chart-block-footer" style={{ marginTop: 8 }}>
            <span>avg: ${filteredCosts.length > 0 ? (filteredCosts.reduce((s: number, d: any) => s + d.cost, 0) / filteredCosts.length).toFixed(0) : 0}/day</span>
            <span>total: ${filteredCosts.reduce((s: number, d: any) => s + d.cost, 0).toFixed(0)}</span>
          </div>
        </div>
      )}

      {/* Cumulative cost */}
      {cumulativeFiltered.length > 1 && (
        <div className="card full">
          <h2>// cumulative cost</h2>
          <AreaChart
            data={cumulativeFiltered.map((d: any) => d.total)}
            labels={cumulativeFiltered.map((d: any) => d.date)}
            height={180}
            color="var(--bright-green)"
            valueFormatter={(n: number) => "$" + formatNumber(n)}
          />
        </div>
      )}

      {/* Prompt history (from history.jsonl — goes back months) */}
      {filteredPrompts.length > 1 && (
        <div className="card full">
          <div className="chart-header">
            <h2>// daily prompts {extended?.firstDate && <span className="dim" style={{ fontWeight: 400, fontSize: 10 }}>(since {extended.firstDate})</span>}</h2>
            <div className="chart-tabs">
              {([30, 90, 0] as CostRange[]).map((r) => (
                <button key={r} className={`chart-tab ${promptRange === r ? "active" : ""}`} onClick={() => setPromptRange(r)}>
                  {r === 0 ? "all" : r + "d"}
                </button>
              ))}
            </div>
          </div>
          <BarChart
            data={filteredPrompts.map((d: any) => d.count)}
            labels={filteredPrompts.map((d: any) => d.date)}
            height={180}
            color="var(--green)"
            valueFormatter={(n: number) => n + " prompts"}
          />
          <div className="chart-block-footer" style={{ marginTop: 8 }}>
            <span>avg: {filteredPrompts.length > 0 ? Math.round(filteredPrompts.reduce((s: number, d: any) => s + d.count, 0) / filteredPrompts.length) : 0}/day</span>
            <span>total: {formatNumber(filteredPrompts.reduce((s: number, d: any) => s + d.count, 0))}</span>
          </div>
        </div>
      )}

      {/* Monthly breakdown */}
      {extended?.monthlyPrompts?.length > 1 && (
        <div className="card full">
          <h2>// monthly prompts</h2>
          <BarChart
            data={extended.monthlyPrompts.map((d: any) => d.count)}
            labels={extended.monthlyPrompts.map((d: any) => d.month)}
            height={160}
            color="var(--green)"
            valueFormatter={(n: number) => formatNumber(n) + " prompts"}
          />
        </div>
      )}

      {/* Model breakdown + hour heatmap */}
      <div className="grid">
        {usage?.models?.length > 0 && (
          <div className="card">
            <h2>// cost by model</h2>
            <table className="sessions-table">
              <thead><tr><th>model</th><th>output</th><th>cache</th><th>cost</th></tr></thead>
              <tbody>
                {usage.models.map((m: any) => (
                  <tr key={m.model}>
                    <td className="session-repo">{m.model}</td>
                    <td>{formatNumber(m.output)}</td>
                    <td>{formatNumber(m.cacheRead)}</td>
                    <td className="session-cost">{formatCurrency(m.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="card">
          <h2>// peak hours</h2>
          {(extended?.hourly && Object.keys(extended.hourly).length > 0) ? (
            <HourHeatmap data={extended.hourly} />
          ) : usage?.hourCounts && Object.keys(usage.hourCounts).length > 0 ? (
            <HourHeatmap data={usage.hourCounts} />
          ) : (
            <div className="empty">no hour data</div>
          )}
          {usage?.longestSession && (
            <>
              <div style={{ marginTop: 20 }}>
                <h2>// records</h2>
              </div>
              <div className="auth-info">
                <div className="auth-row">
                  <span className="key">longest session</span>
                  <span className="value">{formatNumber(usage.longestSession.messageCount)} msgs</span>
                </div>
                <div className="auth-row">
                  <span className="key">duration</span>
                  <span className="value">{Math.round((usage.longestSession.duration || 0) / 3600000)}h</span>
                </div>
                {usage.speculationSaved > 0 && (
                  <div className="auth-row">
                    <span className="key">speculation saved</span>
                    <span className="value">{Math.round(usage.speculationSaved / 1000)}s</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Per-repo breakdown */}
      {repos.length > 0 && (
        <div className="card full">
          <h2>// cost by repo</h2>
          <BarChart
            data={repos.slice(0, 12).map((r: any) => r.cost)}
            labels={repos.slice(0, 12).map((r: any) => r.repo)}
            horizontal
            height={repos.slice(0, 12).length * 32}
            valueFormatter={(n: number) => "$" + formatNumber(n)}
          />
        </div>
      )}

      {/* Repo table */}
      {repos.length > 0 && (
        <div className="card full">
          <h2>// all repos</h2>
          <table className="sessions-table">
            <thead><tr><th>repo</th><th>sessions</th><th>messages</th><th>cost</th><th>$/session</th></tr></thead>
            <tbody>
              {repos.map((r: any) => (
                <tr key={r.repo}>
                  <td className="session-repo">{r.repo}</td>
                  <td>{formatNumber(r.sessions)}</td>
                  <td>{formatNumber(r.messages)}</td>
                  <td className="session-cost">{formatCurrency(r.cost)}</td>
                  <td className="dim">{r.sessions > 0 ? formatCurrency(r.cost / r.sessions) : "--"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

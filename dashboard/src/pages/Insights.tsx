import { formatNumber, MiniMetric, BarChart } from "../components/Charts";

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="auth-row">
      <span className="key">{label}</span>
      <span className="value">{value}{detail && <span className="dim" style={{ marginLeft: 6 }}>{detail}</span>}</span>
    </div>
  );
}

export default function Insights({ extended, usage, tools, history }: any) {
  if (!extended) return <div className="page"><div className="card full"><div className="empty">loading...</div></div></div>;

  const totalPrompts = extended.total || 0;
  const daysActive = extended.daysActive || 0;
  const promptsPerDay = daysActive > 0 ? Math.round(totalPrompts / daysActive) : 0;

  // Time of day breakdown
  const hourly = extended.hourly || {};
  const lateNight = [0,1,2,3,4,5].reduce((s, h) => s + (hourly[h] || 0), 0);
  const morning = [6,7,8,9,10,11].reduce((s, h) => s + (hourly[h] || 0), 0);
  const afternoon = [12,13,14,15,16,17].reduce((s, h) => s + (hourly[h] || 0), 0);
  const evening = [18,19,20,21,22,23].reduce((s, h) => s + (hourly[h] || 0), 0);
  const totalHourly = lateNight + morning + afternoon + evening || 1;
  const lateNightPct = Math.round((lateNight / totalHourly) * 100);
  const morningPct = Math.round((morning / totalHourly) * 100);
  const afternoonPct = Math.round((afternoon / totalHourly) * 100);
  const eveningPct = Math.round((evening / totalHourly) * 100);

  // Peak hour
  let peakHour = 0;
  let peakCount = 0;
  for (const [h, c] of Object.entries(hourly)) {
    if ((c as number) > peakCount) { peakHour = Number(h); peakCount = c as number; }
  }
  const peakLabel = peakHour === 0 ? "12am" : peakHour < 12 ? peakHour + "am" : peakHour === 12 ? "12pm" : (peakHour - 12) + "pm";

  // Chronotype
  const chronotype = lateNightPct > 25 ? "Night Owl" : morningPct > 30 ? "Early Bird" : eveningPct > 40 ? "Evening Coder" : "Afternoon Focused";

  // Day of week from heatmap data
  const dowCounts = [0,0,0,0,0,0,0];
  const dowLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const entry of extended.heatmapData || []) {
    const dow = new Date(entry.date).getDay();
    dowCounts[dow] += entry.count;
  }
  const peakDow = dowLabels[dowCounts.indexOf(Math.max(...dowCounts))];
  const weekdayTotal = dowCounts.slice(1, 6).reduce((a, b) => a + b, 0);
  const weekendTotal = dowCounts[0] + dowCounts[6];
  const weekendPct = Math.round((weekendTotal / (weekdayTotal + weekendTotal || 1)) * 100);

  // Prompt style
  const repos = extended.topRepos || [];
  const topRepo = repos[0]?.repo || "unknown";
  const repoCount = repos.length;

  // Cost insights
  const totalCost = history?.totalCost || usage?.totals?.cost || 0;
  const costPerPrompt = totalPrompts > 0 ? totalCost / totalPrompts : 0;
  const costPerDay = daysActive > 0 ? totalCost / daysActive : 0;
  const dailyCosts = history?.dailyCosts || [];
  const maxDay = dailyCosts.reduce((max: any, d: any) => d.cost > (max?.cost || 0) ? d : max, null);

  // Tool insights
  const toolList = tools?.tools || [];
  const totalTools = toolList.reduce((s: number, t: any) => s + t.count, 0);
  const topTool = toolList[0]?.tool || "unknown";
  const toolsPerPrompt = totalPrompts > 0 ? (totalTools / totalPrompts).toFixed(1) : "0";

  // Cache efficiency
  const models = usage?.models || [];
  const totalCacheRead = models.reduce((s: number, m: any) => s + (m.cacheRead || 0), 0);
  const totalInput = models.reduce((s: number, m: any) => s + (m.input || 0), 0);
  const cacheRatio = totalInput > 0 ? Math.round(totalCacheRead / totalInput) : 0;

  // Time distribution bar
  const timeSlots = [
    { label: "12a-6a", value: lateNightPct, count: lateNight },
    { label: "6a-12p", value: morningPct, count: morning },
    { label: "12p-6p", value: afternoonPct, count: afternoon },
    { label: "6p-12a", value: eveningPct, count: evening },
  ];

  return (
    <div className="page">
      <div className="card full">
        <div className="metrics">
          <MiniMetric value={chronotype} label="chronotype" />
          <MiniMetric value={String(promptsPerDay)} label="prompts/day" />
          <MiniMetric value={toolsPerPrompt} label="tools/prompt" />
          <MiniMetric value={"$" + costPerPrompt.toFixed(2)} label="cost/prompt" />
          <MiniMetric value={String(extended.streaks?.current || 0)} label="streak" unit="d" />
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>// work pattern</h2>
          <div className="auth-info">
            <Stat label="peak hour" value={peakLabel} detail={peakCount + " prompts"} />
            <Stat label="peak day" value={peakDow} detail={formatNumber(Math.max(...dowCounts)) + " prompts"} />
            <Stat label="weekend work" value={weekendPct + "%"} detail={formatNumber(weekendTotal) + " prompts"} />
            <Stat label="late nights" value={lateNightPct + "%"} detail="12am-6am" />
            <Stat label="longest streak" value={String(extended.streaks?.longest || 0) + " days"} />
          </div>
        </div>

        <div className="card">
          <h2>// cost profile</h2>
          <div className="auth-info">
            <Stat label="total api value" value={"$" + formatNumber(totalCost)} />
            <Stat label="per day" value={"$" + costPerDay.toFixed(0)} detail="active days" />
            <Stat label="per prompt" value={"$" + costPerPrompt.toFixed(2)} />
            <Stat label="biggest day" value={maxDay ? "$" + maxDay.cost.toFixed(0) : "--"} detail={maxDay?.date || ""} />
            <Stat label="cache ratio" value={cacheRatio + ":1"} detail="reads vs input" />
          </div>
        </div>
      </div>

      {/* Time distribution */}
      <div className="card full">
        <h2>// time distribution</h2>
        <div style={{ display: "flex", gap: 0, height: 32, marginBottom: 8 }}>
          {timeSlots.map((slot) => (
            <div
              key={slot.label}
              style={{
                flex: slot.value,
                background: slot.value === Math.max(...timeSlots.map(s => s.value))
                  ? "var(--bright-green)" : "var(--green)",
                opacity: Math.max(0.3, slot.value / 100),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontFamily: "var(--mono)",
                color: slot.value > 15 ? "var(--bg)" : "transparent",
                fontWeight: 700,
              }}
            >
              {slot.value}%
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 0 }}>
          {timeSlots.map((slot) => (
            <div key={slot.label} style={{ flex: slot.value || 1, textAlign: "center", fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)" }}>
              {slot.label}
            </div>
          ))}
        </div>
      </div>

      {/* Day of week */}
      <div className="card full">
        <h2>// day of week</h2>
        <BarChart
          data={dowCounts}
          labels={dowLabels}
          height={120}
          valueFormatter={(n: number) => formatNumber(n) + " prompts"}
        />
      </div>

      {/* Coding DNA */}
      <div className="grid">
        <div className="card">
          <h2>// coding dna</h2>
          <div className="auth-info">
            <Stat label="repos worked on" value={String(repoCount)} />
            <Stat label="top repo" value={topRepo} detail={formatNumber(repos[0]?.count || 0) + " prompts"} />
            <Stat label="favorite tool" value={topTool} detail={formatNumber(toolList[0]?.count || 0) + " calls"} />
            <Stat label="total tool calls" value={formatNumber(totalTools)} />
            <Stat label="one-liners" value={Math.round((4004 / totalPrompts) * 100) + "%"} detail="<50 chars" />
          </div>
        </div>

        <div className="card">
          <h2>// scale</h2>
          <div className="auth-info">
            <Stat label="first session" value={extended.firstDate || "--"} />
            <Stat label="total prompts" value={formatNumber(totalPrompts)} />
            <Stat label="active days" value={String(daysActive)} detail={"of " + (extended.heatmapData ? Math.round((new Date(extended.lastDate).getTime() - new Date(extended.firstDate).getTime()) / 86400000) : 0) + " calendar days"} />
            <Stat label="sessions" value={formatNumber(usage?.totals?.sessions || history?.totalSessions || 0)} />
            <Stat label="messages" value={formatNumber(usage?.totals?.messages || 0)} />
          </div>
        </div>
      </div>
    </div>
  );
}

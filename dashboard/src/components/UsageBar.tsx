export default function UsageBar({
  label,
  percent,
  reset,
}: {
  label: string;
  percent: number;
  reset: string | null;
}) {
  const minutes = reset
    ? Math.max(0, Math.floor((new Date(reset).getTime() - Date.now()) / 60000))
    : null;
  const hours = minutes !== null ? Math.floor(minutes / 60) : null;
  const remaining =
    hours !== null && hours > 0
      ? hours + "h " + (minutes! % 60) + "m"
      : minutes !== null
        ? minutes + "m"
        : "";
  const color =
    percent >= 90
      ? "var(--red)"
      : percent >= 70
        ? "var(--bright-orange)"
        : "var(--green)";

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
        <div
          className="usage-bar-fill"
          style={{ width: percent + "%", background: color }}
        />
      </div>
    </div>
  );
}

const icons = {
  overview: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="6" height="6" /><rect x="9" y="1" width="6" height="6" />
      <rect x="1" y="9" width="6" height="6" /><rect x="9" y="9" width="6" height="6" />
    </svg>
  ),
  history: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="1,12 4,6 7,9 10,3 14,7" /><line x1="1" y1="14" x2="14" y2="14" />
    </svg>
  ),
};

export default function Sidebar({ page, onNavigate, monitorRunning }: {
  page: string;
  onNavigate: (page: string) => void;
  monitorRunning: boolean;
}) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">super<span>powerd</span></div>
      </div>
      <nav className="sidebar-nav">
        {(["overview", "history"] as const).map((item) => (
          <button
            key={item}
            className={`sidebar-item ${page === item ? "active" : ""}`}
            onClick={() => onNavigate(item)}
          >
            {icons[item]}
            <span>{item}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className={`sidebar-status ${monitorRunning ? "running" : "stopped"}`}>
          <div className="dot" />
          <span>{monitorRunning ? "monitoring" : "idle"}</span>
        </div>
      </div>
    </div>
  );
}

import { useState, useRef, useCallback, type ReactNode } from "react";

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toString();
}

export function formatCurrency(n: number): string {
  if (n >= 1000) return "$" + formatNumber(n);
  return "$" + n.toFixed(2);
}

function toLocalTime(utc: string): string {
  try {
    const date = new Date(utc.includes("T") ? utc : utc + "Z");
    if (isNaN(date.getTime())) return utc;
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return utc;
  }
}

export function formatLogLine(line: string): ReactNode {
  const match = line.match(/^\[([^\]]+)\]\s*(.*)/);
  if (!match) return <span>{line}</span>;
  const [, timestamp, rest] = match;
  let className = "";
  if (rest.includes("!!!") || rest.includes("Signal")) className = "signal";
  else if (rest.includes("[rotate]")) className = "rotate";
  else if (rest.includes("Now using") || rest.includes("===")) className = "success";
  return (
    <>
      <span className="timestamp">{toLocalTime(timestamp)}</span>{" "}
      <span className={className}>{rest}</span>
    </>
  );
}

interface TooltipState {
  x: number;
  y: number;
  label: string;
  value: string;
  visible: boolean;
}

function Tooltip({ state }: { state: TooltipState }) {
  if (!state.visible) return null;
  return (
    <div
      className="chart-tooltip"
      style={{ left: state.x, top: state.y }}
    >
      <div className="chart-tooltip-label">{state.label}</div>
      <div className="chart-tooltip-value">{state.value}</div>
    </div>
  );
}

export function Sparkline({
  data,
  height = 80,
  color = "var(--green)",
  labels,
  valueFormatter = String,
}: {
  data: number[];
  height?: number;
  color?: string;
  labels?: string[];
  valueFormatter?: (n: number) => string;
}) {
  const [tooltip, setTooltip] = useState<TooltipState>({ x: 0, y: 0, label: "", value: "", visible: false });
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length < 2) return <div className="sparkline-empty">no data</div>;
  const max = Math.max(...data, 1);
  const width = 1000;
  const padding = 3;
  const step = (width - padding * 2) / (data.length - 1);

  const points = data.map((v, i) => ({
    x: padding + i * step,
    y: height - padding - (v / max) * (height - padding * 2 - 4),
    value: v,
  }));
  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");
  const fill = `${padding},${height} ${polyline} ${points[points.length - 1].x},${height}`;

  const gradientId = `sparkFill-${Math.random().toString(36).slice(2, 8)}`;

  const handleMouse = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const mouseX = ((event.clientX - rect.left) / rect.width) * width;
      let closest = 0;
      let closestDist = Infinity;
      for (let i = 0; i < points.length; i++) {
        const dist = Math.abs(points[i].x - mouseX);
        if (dist < closestDist) {
          closestDist = dist;
          closest = i;
        }
      }
      const p = points[closest];
      const screenX = (p.x / width) * rect.width;
      const screenY = (p.y / height) * rect.height;
      setTooltip({
        x: screenX,
        y: screenY - 8,
        label: labels?.[closest] ?? `#${closest + 1}`,
        value: valueFormatter(p.value),
        visible: true,
      });
    },
    [points, labels, valueFormatter, width, height]
  );

  return (
    <div className="sparkline-container" style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="sparkline"
        preserveAspectRatio="none"
        onMouseMove={handleMouse}
        onMouseLeave={() => setTooltip((t) => ({ ...t, visible: false }))}
        style={{ height }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.2" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={fill} fill={`url(#${gradientId})`} />
        <polyline points={polyline} fill="none" stroke={color} strokeWidth="1.5" />
        {tooltip.visible && (
          <>
            {points.map((p, i) => {
              const rect = svgRef.current?.getBoundingClientRect();
              if (!rect) return null;
              const mouseLabel = labels?.[i] ?? `#${i + 1}`;
              if (mouseLabel !== tooltip.label) return null;
              return (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  fill={color}
                  stroke="var(--bg)"
                  strokeWidth={2}
                />
              );
            })}
          </>
        )}
      </svg>
      <Tooltip state={tooltip} />
    </div>
  );
}

export function BarChart({
  data,
  labels,
  height = 200,
  color = "var(--green)",
  valueFormatter = String,
  horizontal = false,
}: {
  data: number[];
  labels: string[];
  height?: number;
  color?: string;
  valueFormatter?: (n: number) => string;
  horizontal?: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (data.length === 0) return <div className="sparkline-empty">no data</div>;
  const max = Math.max(...data, 1);

  if (horizontal) {
    const barHeight = 28;
    const gap = 4;
    const totalHeight = (barHeight + gap) * data.length;
    const labelWidth = 140;
    const chartWidth = 400;

    return (
      <div className="horizontal-bar-chart">
        <svg viewBox={`0 0 ${chartWidth + labelWidth + 80} ${totalHeight}`} className="bar-chart-svg" style={{ height: Math.max(totalHeight, 60) }}>
          {data.map((value, i) => {
            const barW = (value / max) * chartWidth;
            const y = i * (barHeight + gap);
            const isHovered = hovered === i;
            return (
              <g
                key={i}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                className="bar-group"
              >
                <text
                  x={labelWidth - 8}
                  y={y + barHeight / 2 + 1}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fill={isHovered ? "var(--text-bright)" : "var(--text)"}
                  fontSize="11"
                  fontFamily="var(--mono)"
                >
                  {labels[i]?.length > 18 ? labels[i].slice(0, 18) + "..." : labels[i]}
                </text>
                <rect
                  x={labelWidth}
                  y={y}
                  width={Math.max(barW, 2)}
                  height={barHeight}
                  fill={isHovered ? "var(--bright-green)" : color}
                  opacity={isHovered ? 1 : 0.8}
                />
                <text
                  x={labelWidth + Math.max(barW, 2) + 8}
                  y={y + barHeight / 2 + 1}
                  dominantBaseline="middle"
                  fill={isHovered ? "var(--text-bright)" : "var(--muted)"}
                  fontSize="11"
                  fontFamily="var(--mono)"
                >
                  {valueFormatter(value)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    );
  }

  const totalWidth = 1000;
  const gap = Math.max(2, Math.floor((totalWidth / data.length) * 0.15));
  const barWidth = (totalWidth - gap * data.length) / data.length;
  const svgHeight = height;

  return (
    <div className="bar-chart-container" style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${totalWidth} ${svgHeight + 24}`} className="bar-chart-svg" preserveAspectRatio="none" style={{ width: "100%", height: svgHeight + 24 }}>
        {data.map((value, i) => {
          const barH = (value / max) * (svgHeight - 8);
          const x = i * (barWidth + gap);
          const y = svgHeight - barH;
          const isHovered = hovered === i;
          return (
            <g
              key={i}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              className="bar-group"
            >
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barH, 1)}
                fill={isHovered ? "var(--bright-green)" : color}
                opacity={isHovered ? 1 : 0.8}
              />
              {isHovered && (
                <text
                  x={x + barWidth / 2}
                  y={y - 6}
                  textAnchor="middle"
                  fill="var(--text-bright)"
                  fontSize="10"
                  fontFamily="var(--mono)"
                >
                  {valueFormatter(value)}
                </text>
              )}
              {(i % Math.max(1, Math.floor(data.length / 12)) === 0 || isHovered) && (
                <text
                  x={x + barWidth / 2}
                  y={svgHeight + 16}
                  textAnchor="middle"
                  fill="var(--muted)"
                  fontSize="8"
                  fontFamily="var(--mono)"
                >
                  {labels[i]?.slice(-5) ?? ""}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function AreaChart({
  data,
  labels,
  height = 200,
  color = "var(--green)",
  valueFormatter = String,
}: {
  data: number[];
  labels: string[];
  height?: number;
  color?: string;
  valueFormatter?: (n: number) => string;
}) {
  const [tooltip, setTooltip] = useState<TooltipState>({ x: 0, y: 0, label: "", value: "", visible: false });
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length < 2) return <div className="sparkline-empty">no data</div>;
  const max = Math.max(...data, 1);
  const width = 1000;
  const padding = 6;
  const step = (width - padding * 2) / (data.length - 1);

  const points = data.map((v, i) => ({
    x: padding + i * step,
    y: height - padding - (v / max) * (height - padding * 2 - 4),
    value: v,
  }));
  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");
  const fill = `${padding},${height} ${polyline} ${points[points.length - 1].x},${height}`;

  const gradientId = `areaFill-${Math.random().toString(36).slice(2, 8)}`;

  const handleMouse = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const mouseX = ((event.clientX - rect.left) / rect.width) * width;
      let closest = 0;
      let closestDist = Infinity;
      for (let i = 0; i < points.length; i++) {
        const dist = Math.abs(points[i].x - mouseX);
        if (dist < closestDist) {
          closestDist = dist;
          closest = i;
        }
      }
      const p = points[closest];
      const screenX = (p.x / width) * rect.width;
      const screenY = (p.y / height) * rect.height;
      setTooltip({
        x: screenX,
        y: screenY - 8,
        label: labels[closest] ?? "",
        value: valueFormatter(p.value),
        visible: true,
      });
    },
    [points, labels, valueFormatter, width, height]
  );

  const yTicks = 4;
  const yLabels: { y: number; label: string }[] = [];
  for (let i = 0; i <= yTicks; i++) {
    const value = (max / yTicks) * i;
    const y = height - padding - (value / max) * (height - padding * 2 - 4);
    yLabels.push({ y, label: valueFormatter(value) });
  }

  return (
    <div className="area-chart-container" style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="area-chart-svg"
        preserveAspectRatio="none"
        onMouseMove={handleMouse}
        onMouseLeave={() => setTooltip((t) => ({ ...t, visible: false }))}
        style={{ width: "100%", height }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {yLabels.map((tick, i) => (
          <line
            key={i}
            x1={padding}
            y1={tick.y}
            x2={width - padding}
            y2={tick.y}
            stroke="var(--border)"
            strokeWidth="0.5"
            strokeDasharray="4,4"
          />
        ))}
        <polygon points={fill} fill={`url(#${gradientId})`} />
        <polyline points={polyline} fill="none" stroke={color} strokeWidth="2" />
        {tooltip.visible &&
          points.map((p, i) => {
            if (labels[i] !== tooltip.label) return null;
            return (
              <g key={i}>
                <line
                  x1={p.x}
                  y1={padding}
                  x2={p.x}
                  y2={height - padding}
                  stroke="var(--border-bright)"
                  strokeWidth="1"
                  strokeDasharray="3,3"
                />
                <circle cx={p.x} cy={p.y} r={4} fill={color} stroke="var(--bg)" strokeWidth={2} />
              </g>
            );
          })}
      </svg>
      <Tooltip state={tooltip} />
    </div>
  );
}

export function Gauge({
  value,
  max = 100,
  label,
  size = 140,
  color,
}: {
  value: number;
  max?: number;
  label: string;
  size?: number;
  color?: string;
}) {
  const percent = Math.min(100, Math.max(0, (value / max) * 100));
  const fillColor = color ?? (percent >= 90 ? "var(--red)" : percent >= 70 ? "var(--bright-orange)" : "var(--green)");

  const cx = size / 2;
  const cy = size / 2;
  const radius = (size - 16) / 2;
  const circumference = Math.PI * radius;
  const startAngle = Math.PI;
  const sweep = (percent / 100) * Math.PI;

  const arcPath = (angle: number, r: number) => {
    const x = cx + r * Math.cos(startAngle + angle);
    const y = cy + r * Math.sin(startAngle + angle);
    return { x, y };
  };

  const bgStart = arcPath(0, radius);
  const bgEnd = arcPath(Math.PI, radius);
  const bgD = `M ${bgStart.x} ${bgStart.y} A ${radius} ${radius} 0 0 1 ${bgEnd.x} ${bgEnd.y}`;

  const valEnd = arcPath(sweep, radius);
  const largeArc = sweep > Math.PI / 2 ? 1 : 0;
  const valD = `M ${bgStart.x} ${bgStart.y} A ${radius} ${radius} 0 ${largeArc} 1 ${valEnd.x} ${valEnd.y}`;

  return (
    <div className="gauge" style={{ width: size }}>
      <svg viewBox={`0 0 ${size} ${size * 0.6}`} className="gauge-svg">
        <path d={bgD} fill="none" stroke="var(--border)" strokeWidth="8" strokeLinecap="butt" />
        <path d={valD} fill="none" stroke={fillColor} strokeWidth="8" strokeLinecap="butt" />
        <text x={cx} y={cy - 2} textAnchor="middle" dominantBaseline="middle" fill="var(--text-bright)" fontSize="20" fontFamily="var(--sans)" fontWeight="700">
          {Math.round(percent)}%
        </text>
      </svg>
      <div className="gauge-label">{label}</div>
    </div>
  );
}

export function DonutChart({
  segments,
  size = 180,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return <div className="sparkline-empty">no data</div>;

  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = (size - 8) / 2;
  const innerRadius = outerRadius * 0.6;

  let currentAngle = -Math.PI / 2;
  const paths = segments.map((seg, i) => {
    const angle = (seg.value / total) * Math.PI * 2;
    const start = currentAngle;
    const end = currentAngle + angle;
    currentAngle = end;

    const r = hovered === i ? outerRadius + 4 : outerRadius;
    const ir = hovered === i ? innerRadius - 2 : innerRadius;

    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const ix1 = cx + ir * Math.cos(end);
    const iy1 = cy + ir * Math.sin(end);
    const ix2 = cx + ir * Math.cos(start);
    const iy2 = cy + ir * Math.sin(start);
    const largeArc = angle > Math.PI ? 1 : 0;

    const d = [
      `M ${x1} ${y1}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${ix1} ${iy1}`,
      `A ${ir} ${ir} 0 ${largeArc} 0 ${ix2} ${iy2}`,
      `Z`,
    ].join(" ");

    return (
      <path
        key={i}
        d={d}
        fill={seg.color}
        opacity={hovered === null || hovered === i ? 1 : 0.4}
        onMouseEnter={() => setHovered(i)}
        onMouseLeave={() => setHovered(null)}
        className="donut-segment"
      />
    );
  });

  return (
    <div className="donut-chart" style={{ display: "flex", gap: 24, alignItems: "center" }}>
      <svg viewBox={`-8 -8 ${size + 16} ${size + 16}`} style={{ width: size + 16, height: size + 16, flexShrink: 0 }}>
        {paths}
        {hovered !== null && (
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fill="var(--text-bright)" fontSize="14" fontFamily="var(--mono)">
            {formatCurrency(segments[hovered].value)}
          </text>
        )}
      </svg>
      <div className="donut-legend">
        {segments.map((seg, i) => (
          <div
            key={i}
            className={`donut-legend-item ${hovered === i ? "hovered" : ""}`}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="donut-legend-swatch" style={{ background: seg.color }} />
            <span className="donut-legend-label">{seg.label}</span>
            <span className="donut-legend-value">{formatCurrency(seg.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MiniMetric({
  value,
  label,
  warn = false,
  unit,
}: {
  value: string;
  label: string;
  warn?: boolean;
  unit?: string;
}) {
  return (
    <div className="metric">
      <div className={`metric-value ${warn ? "warn" : ""}`}>
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

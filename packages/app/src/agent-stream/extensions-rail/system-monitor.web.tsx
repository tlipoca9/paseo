/*
 * Constraint brief (Refactoring UI):
 * - Primary: system health status at a glance (CPU sparkline + Mem/Disk bars + Services tree)
 * - Secondary: service sub-nodes (wxwork -> ES) and detail summaries
 * - Tertiary: section labels & metadata tooltips
 * - Tokens: Paseo Unistyles theme.colors (surface1, surface2, border, foreground*, success, warning, destructive, info)
 */
import { memo, useCallback, useEffect, useId, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, ChevronRight } from "lucide-react-native";
import type {
  DesktopSystemHealthSnapshot,
  DesktopSystemServiceNode,
  DesktopSystemServiceStatus,
} from "@/desktop/host";
import { formatBytesCompact } from "./use-system-health";

const STYLE_ELEMENT_ID = "paseo-extensions-rail-motion";

const MOTION_CSS = `
@keyframes paseo-rail-breathe {
  0%, 100% { opacity: 0.92; transform: scale(1); }
  50% { opacity: 0.52; transform: scale(0.88); }
}
@keyframes paseo-rail-ping {
  0% { transform: scale(1); opacity: 0.72; }
  75%, 100% { transform: scale(2.4); opacity: 0; }
}
@keyframes paseo-rail-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(220%); }
}
@keyframes paseo-rail-fade-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}
.paseo-rail-panel {
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  animation: paseo-rail-fade-in 220ms cubic-bezier(0.22, 1, 0.36, 1);
  transition: border-color 180ms ease, box-shadow 180ms ease;
}
.paseo-rail-pill {
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  animation: paseo-rail-fade-in 180ms cubic-bezier(0.22, 1, 0.36, 1);
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), border-color 160ms ease, opacity 160ms ease;
}
.paseo-rail-pill:hover {
  transform: translateY(-1px);
  opacity: 1 !important;
}
.paseo-rail-meter-fill {
  transition: width 600ms cubic-bezier(0.22, 1, 0.36, 1), background-color 320ms ease;
  position: relative;
  overflow: hidden;
}
.paseo-rail-meter-fill--hot::after {
  content: "";
  position: absolute;
  inset: 0;
  width: 45%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);
  animation: paseo-rail-shimmer 2.2s ease-in-out infinite;
}
.paseo-rail-dot-ok {
  animation: paseo-rail-breathe 3.2s ease-in-out infinite;
}
.paseo-rail-dot-warn {
  animation: paseo-rail-breathe 1.9s ease-in-out infinite;
}
.paseo-rail-dot-ring {
  animation: paseo-rail-ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite;
}
.paseo-rail-accordion {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 210ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease;
}
.paseo-rail-accordion[data-open="true"] {
  grid-template-rows: 1fr;
  opacity: 1;
}
.paseo-rail-accordion-inner {
  overflow: hidden;
  min-height: 0;
}
.paseo-rail-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.paseo-rail-chevron[data-open="true"] {
  transform: rotate(90deg);
}
.paseo-rail-row-hover {
  width: 100%;
  box-sizing: border-box;
  border-radius: 5px;
  transition: background-color 140ms ease;
}
.paseo-rail-row-hover:hover {
  background-color: rgba(128, 128, 128, 0.09);
}
.paseo-rail-tabular {
  font-variant-numeric: tabular-nums;
}
@media (prefers-reduced-motion: reduce) {
  .paseo-rail-panel,
  .paseo-rail-pill,
  .paseo-rail-dot-ok,
  .paseo-rail-dot-warn,
  .paseo-rail-dot-ring,
  .paseo-rail-meter-fill--hot::after {
    animation: none !important;
  }
  .paseo-rail-meter-fill,
  .paseo-rail-accordion,
  .paseo-rail-chevron {
    transition: none !important;
  }
}
`;

export function ensureRailMotionStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = MOTION_CSS;
  document.head.appendChild(style);
}

type MeterTone = "calm" | "warn" | "danger";

function getPercentTone(percent: number): MeterTone {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warn";
  return "calm";
}

function getDiskTone(freeBytes: number, percent: number): MeterTone {
  const freeGiB = freeBytes / 1024 ** 3;
  if (freeGiB < 5 || percent >= 95) return "danger";
  if (freeGiB < 15 || percent >= 88) return "warn";
  return "calm";
}

export function StatusDot({ status }: { status: DesktopSystemServiceStatus }) {
  const { theme } = useUnistyles();
  const color =
    status === "ok"
      ? theme.colors.statusSuccess
      : status === "warn"
        ? theme.colors.statusWarning
        : status === "error"
          ? theme.colors.statusDanger
          : theme.colors.borderAccent;

  const dotClass =
    status === "ok"
      ? "paseo-rail-dot-ok"
      : status === "warn"
        ? "paseo-rail-dot-warn"
        : undefined;

  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 8,
        height: 8,
        flexShrink: 0,
      }}
    >
      {status === "error" ? (
        <span
          className="paseo-rail-dot-ring"
          style={{
            position: "absolute",
            width: 6,
            height: 6,
            borderRadius: "9999px",
            backgroundColor: color,
          }}
        />
      ) : null}
      <span
        className={dotClass}
        style={{
          width: 5.5,
          height: 5.5,
          borderRadius: "9999px",
          backgroundColor: color,
          boxShadow: status === "ok" ? `0 0 6px ${color}66` : undefined,
        }}
      />
    </span>
  );
}

const CpuSparkline = memo(function CpuSparkline({
  values,
  color,
}: {
  values: readonly number[];
  color: string;
}) {
  const gradientId = useId();
  const maxPoints = 16;
  const viewWidth = 100;
  const height = 16;
  const padY = 2;

  const raw = values.length > 0 ? values : [0];
  const stepX = viewWidth / (maxPoints - 1);

  const points =
    raw.length === 1
      ? [
          {
            x: 0,
            y: height - padY - (Math.max(0, Math.min(100, raw[0]!)) / 100) * (height - padY * 2),
          },
          {
            x: stepX,
            y: height - padY - (Math.max(0, Math.min(100, raw[0]!)) / 100) * (height - padY * 2),
          },
        ]
      : raw.map((v, i) => {
          const clamped = Math.max(0, Math.min(100, v));
          const x = Math.min(viewWidth, i * stepX);
          const y = height - padY - (clamped / 100) * (height - padY * 2);
          return { x, y };
        });

  const linePath = points
    .map((pt, idx) => `${idx === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1] ?? { x: 0, y: height / 2 };
  const areaPath = `${linePath} L${last.x.toFixed(1)},${height} L0,${height} Z`;

  return (
    <div style={{ position: "relative", width: "100%", height }}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${viewWidth} ${height}`}
        preserveAspectRatio="none"
        style={{ display: "block", overflow: "visible" }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0.0} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={1.35}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transition: "stroke 320ms ease" }}
        />
      </svg>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: `${last.x}%`,
          top: `${last.y}px`,
          width: 4.5,
          height: 4.5,
          borderRadius: "9999px",
          backgroundColor: color,
          boxShadow: `0 0 6px ${color}88`,
          transform: "translate(-50%, -50%)",
          transition: "left 400ms ease, top 400ms ease, background-color 320ms ease",
        }}
      />
    </div>
  );
});

const AnimatedBar = memo(function AnimatedBar({
  percent,
  color,
  hot,
}: {
  percent: number;
  color: string;
  hot: boolean;
}) {
  const { theme } = useUnistyles();
  const clamped = Math.max(2, Math.min(100, percent));

  return (
    <div
      style={{
        flex: 1,
        height: 4,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <div
        className={`paseo-rail-meter-fill${hot ? " paseo-rail-meter-fill--hot" : ""}`}
        style={{
          width: `${clamped}%`,
          height: "100%",
          borderRadius: 999,
          backgroundColor: color,
        }}
      />
    </div>
  );
});

const ServiceTreeItem = memo(function ServiceTreeItem({
  node,
}: {
  node: DesktopSystemServiceNode;
}) {
  const { theme } = useUnistyles();
  const hasChildren = Boolean(node.children && node.children.length > 0);
  // Default service subtrees to collapsed; user clicks to inspect children.
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    if (!hasChildren) return;
    setExpanded((prev) => !prev);
  }, [hasChildren]);

  const summaryColor =
    node.status === "error"
      ? theme.colors.statusDanger
      : node.status === "warn"
        ? theme.colors.statusWarning
        : theme.colors.foregroundExtraMuted;

  return (
    <View style={styles.serviceTreeNode} testID={`system-service-${node.id}`}>
      <div className="paseo-rail-row-hover" title={node.detail ?? `${node.name}: ${node.summary}`}>
        <Pressable
          style={styles.serviceRow}
          onPress={toggle}
          disabled={!hasChildren}
          accessibilityRole={hasChildren ? "button" : undefined}
        >
          <View style={styles.serviceLeft}>
            <StatusDot status={node.status} />
            <Text style={styles.serviceName} numberOfLines={1}>
              {node.name}
            </Text>
          </View>
          <View style={styles.serviceRight}>
            {node.summary ? (
              <Text
                style={[styles.serviceSummary, { color: summaryColor }]}
                numberOfLines={1}
              >
                <span className="paseo-rail-tabular">{node.summary}</span>
              </Text>
            ) : node.status === "ok" ? (
              <Check size={11} strokeWidth={2.2} color={theme.colors.statusSuccess} />
            ) : null}
            {hasChildren ? (
              <span className="paseo-rail-chevron" data-open={expanded ? "true" : "false"}>
                <ChevronRight size={10} color={theme.colors.foregroundExtraMuted} />
              </span>
            ) : null}
          </View>
        </Pressable>
      </div>

      {hasChildren ? (
        <div className="paseo-rail-accordion" data-open={expanded ? "true" : "false"}>
          <div className="paseo-rail-accordion-inner">
            <View style={styles.treeChildren}>
              {node.children!.map((child, idx) => {
                const isLast = idx === node.children!.length - 1;
                const childSummaryColor =
                  child.status === "error"
                    ? theme.colors.statusDanger
                    : child.status === "warn"
                      ? theme.colors.statusWarning
                      : theme.colors.foregroundExtraMuted;

                return (
                  <div
                    key={child.id}
                    className="paseo-rail-row-hover"
                    title={child.detail ?? `${child.name}: ${child.summary}`}
                    style={{ position: "relative", paddingLeft: 16 }}
                  >
                    {/* Vertical trunk */}
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        left: 7,
                        top: 0,
                        bottom: isLast ? "50%" : 0,
                        width: 1,
                        backgroundColor: theme.colors.border,
                      }}
                    />
                    {/* Rounded horizontal elbow */}
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        left: 7,
                        top: "50%",
                        width: 7,
                        height: 1,
                        backgroundColor: theme.colors.border,
                      }}
                    />
                    <View
                      style={styles.serviceChildRow}
                      testID={`system-service-${child.id}`}
                    >
                      <View style={styles.serviceLeft}>
                        <StatusDot status={child.status} />
                        <Text style={styles.serviceChildName} numberOfLines={1}>
                          {child.name}
                        </Text>
                      </View>
                      <View style={styles.serviceRight}>
                        {child.summary ? (
                          <Text
                            style={[styles.serviceSummary, { color: childSummaryColor }]}
                            numberOfLines={1}
                          >
                            <span className="paseo-rail-tabular">{child.summary}</span>
                          </Text>
                        ) : child.status === "ok" ? (
                          <Check size={11} strokeWidth={2.2} color={theme.colors.statusSuccess} />
                        ) : null}
                      </View>
                    </View>
                  </div>
                );
              })}
            </View>
          </div>
        </div>
      ) : null}
    </View>
  );
});

export interface SystemMonitorSectionProps {
  snapshot: DesktopSystemHealthSnapshot;
  cpuHistory: readonly number[];
}

export const SystemMonitorSection = memo(function SystemMonitorSection({
  snapshot,
  cpuHistory,
}: SystemMonitorSectionProps) {
  const { theme } = useUnistyles();

  useEffect(() => {
    ensureRailMotionStyles();
  }, []);

  const toneColor = (tone: MeterTone) =>
    tone === "danger"
      ? theme.colors.statusDanger
      : tone === "warn"
        ? theme.colors.statusWarning
        : theme.colors.accent;

  const cpuTone = getPercentTone(snapshot.cpu.percent);
  const memTone = getPercentTone(snapshot.memory.percent);
  const diskTone = snapshot.disk
    ? getDiskTone(snapshot.disk.freeBytes, snapshot.disk.percent)
    : "calm";

  return (
    <View style={styles.container} testID="agent-extensions-system-section">
      {/* System metrics */}
      <View style={styles.group}>
        <Text style={styles.groupLabel}>SYSTEM</Text>

        {/* CPU with live sparkline */}
        <div
          className="paseo-rail-row-hover"
          title={`CPU ${snapshot.cpu.percent}% · ${snapshot.cpu.cores} cores · load ${snapshot.cpu.loadAvg1m}`}
        >
          <View style={styles.metricRow} testID="system-metric-cpu">
            <Text style={styles.metricLabel}>CPU</Text>
            <View style={styles.sparklineSlot}>
              <CpuSparkline values={cpuHistory} color={toneColor(cpuTone)} />
            </View>
            <Text
              style={[
                styles.metricValue,
                cpuTone !== "calm" && { color: toneColor(cpuTone) },
              ]}
            >
              <span className="paseo-rail-tabular">{snapshot.cpu.percent}%</span>
            </Text>
          </View>
        </div>

        {/* Memory */}
        <div
          className="paseo-rail-row-hover"
          title={`Memory ${formatBytesCompact(snapshot.memory.usedBytes)} / ${formatBytesCompact(snapshot.memory.totalBytes)} (${snapshot.memory.percent}%)`}
        >
          <View style={styles.metricRow} testID="system-metric-mem">
            <Text style={styles.metricLabel}>Mem</Text>
            <AnimatedBar
              percent={snapshot.memory.percent}
              color={toneColor(memTone)}
              hot={memTone !== "calm"}
            />
            <Text
              style={[
                styles.metricValue,
                memTone !== "calm" && { color: toneColor(memTone) },
              ]}
            >
              <span className="paseo-rail-tabular">{snapshot.memory.percent}%</span>
            </Text>
          </View>
        </div>

        {/* Disk */}
        {snapshot.disk ? (
          <div
            className="paseo-rail-row-hover"
            title={`Disk (${snapshot.disk.mount}) ${formatBytesCompact(snapshot.disk.freeBytes)} free of ${formatBytesCompact(snapshot.disk.totalBytes)} (${snapshot.disk.percent}% used)`}
          >
            <View style={styles.metricRow} testID="system-metric-disk">
              <Text style={styles.metricLabel}>Disk</Text>
              <AnimatedBar
                percent={snapshot.disk.percent}
                color={toneColor(diskTone)}
                hot={diskTone !== "calm"}
              />
              <Text
                style={[
                  styles.metricValue,
                  diskTone !== "calm" && { color: toneColor(diskTone) },
                ]}
              >
                <span className="paseo-rail-tabular">
                  {formatBytesCompact(snapshot.disk.freeBytes)}
                </span>
              </Text>
            </View>
          </div>
        ) : null}
      </View>

      {/* Services tree */}
      {snapshot.services.length > 0 ? (
        <View style={styles.group} testID="agent-extensions-services-section">
          <Text style={styles.groupLabel}>SERVICES</Text>
          <View style={styles.serviceList}>
            {snapshot.services.map((service) => (
              <ServiceTreeItem key={service.id} node={service} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  group: {
    gap: 4,
  },
  groupLabel: {
    fontSize: 9.5,
    fontWeight: "600",
    letterSpacing: 0.6,
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: theme.spacing[1],
    marginBottom: 1,
  },
  metricRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 3,
  },
  metricLabel: {
    fontSize: 11,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
    width: 28,
    flexShrink: 0,
  },
  sparklineSlot: {
    flex: 1,
    justifyContent: "center",
  },
  metricValue: {
    fontSize: 10.5,
    fontWeight: "500",
    color: theme.colors.foreground,
    width: 36,
    textAlign: "right",
    flexShrink: 0,
  },
  serviceList: {
    gap: 2,
  },
  serviceTreeNode: {
    gap: 1,
  },
  serviceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    gap: 6,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 3,
  },
  serviceLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  serviceRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginLeft: "auto",
    flexShrink: 1,
  },
  serviceName: {
    fontSize: 11,
    fontWeight: "500",
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  serviceSummary: {
    fontSize: 10,
    flexShrink: 1,
    textAlign: "right",
  },
  okIconWrap: {
    marginLeft: "auto",
    alignItems: "center",
    justifyContent: "center",
  },
  treeChildren: {
    gap: 1,
    paddingBottom: 2,
  },
  serviceChildRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    gap: 6,
    paddingRight: theme.spacing[1],
    paddingVertical: 2.5,
  },
  serviceChildName: {
    fontSize: 10.5,
    fontWeight: "400",
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
}));

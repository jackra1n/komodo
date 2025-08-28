import { hex_color_by_intention } from "@lib/color";
import { useRead } from "@lib/hooks";
import { Types } from "komodo_client";
import { useMemo } from "react";
import { useStatsGranularity } from "./hooks";
import { Loader2 } from "lucide-react";
import { AxisOptions, Chart } from "react-charts";
import { convertTsMsToLocalUnixTsInMs } from "@lib/utils";
import { useTheme } from "@ui/theme";
import { fmt_utc_date } from "@lib/formatting";

type StatType = "Cpu" | "Memory" | "Disk" | "Network Ingress" | "Network Egress" | "Load Average";

type StatDatapoint = { date: number; value: number };

export const StatChart = ({
  server_id,
  type,
  className,
}: {
  server_id: string;
  type: StatType;
  className?: string;
}) => {
  const [granularity] = useStatsGranularity();

  const { data, isPending } = useRead("GetHistoricalServerStats", {
    server: server_id,
    granularity,
  });

  const seriesData = useMemo(() => {
    if (!data?.stats) return [] as { label: string; data: StatDatapoint[] }[];
    const records = [...data.stats].reverse();
    if (type === "Load Average") {
      const one = records.map((s) => ({
        date: convertTsMsToLocalUnixTsInMs(s.ts),
        value: (s.load_average?.one ?? 0),
      }));
      const five = records.map((s) => ({
        date: convertTsMsToLocalUnixTsInMs(s.ts),
        value: (s.load_average?.five ?? 0),
      }));
      const fifteen = records.map((s) => ({
        date: convertTsMsToLocalUnixTsInMs(s.ts),
        value: (s.load_average?.fifteen ?? 0),
      }));
      return [
        { label: "1m", data: one },
        { label: "5m", data: five },
        { label: "15m", data: fifteen },
      ];
    }

    // For network charts, convert cumulative bytes to rate in MB/s
    if (type === "Network Ingress" || type === "Network Egress") {
      const getBytes = (s: Types.SystemStatsRecord) =>
        type === "Network Ingress"
          ? (s.network_ingress_bytes ?? 0)
          : (s.network_egress_bytes ?? 0);
      const rate = records.map((s, idx) => {
        const date = convertTsMsToLocalUnixTsInMs(s.ts);
        if (idx === 0) return { date, value: 0 };
        const prev = records[idx - 1];
        const currBytes = getBytes(s);
        const prevBytes = getBytes(prev);
        const deltaBytes = Math.max(0, currBytes - prevBytes);
        const deltaSeconds = Math.max(1, (s.ts - prev.ts) / 1000);
        const bytesPerSec = deltaBytes / deltaSeconds;
        return { date, value: bytesPerSec }; // store as B/s for flexible display
      });
      // Debug: peek first/last few points and extrema
      try {
        const sample = [...rate.slice(0, 3), ...rate.slice(-3)];
        const max = rate.reduce((m, d) => Math.max(m, d.value), 0);
        const min = rate.reduce((m, d) => Math.min(m, d.value), Number.POSITIVE_INFINITY);
        // eslint-disable-next-line no-console
        console.debug("[StatChart] network rates (B/s)", type, {
          points: sample,
          min,
          max,
          count: rate.length,
        });
      } catch {}
      return [{ label: type, data: rate }];
    }

    const single = records.map((stat) => ({
      date: convertTsMsToLocalUnixTsInMs(stat.ts),
      value: getStat(stat, type),
    }));
    return [{ label: type, data: single }];
  }, [data, type]);

  return (
    <div className={className}>
      <h1 className="px-2 py-1">{type}</h1>
      {isPending ? (
        <div className="w-full max-w-full h-full flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      ) : seriesData.length > 0 ? (
        <InnerStatChart type={type} stats={seriesData.flatMap((s) => s.data)} seriesData={seriesData} />
      ) : null}
    </div>
  );
};

const BYTES_PER_MB = 1048576.0;
const BYTES_PER_KB = 1024.0;

export const InnerStatChart = ({
  type,
  stats,
  seriesData,
}: {
  type: StatType;
  stats: StatDatapoint[] | undefined;
  seriesData?: { label: string; data: StatDatapoint[] }[];
}) => {
  const { theme: _theme } = useTheme();
  const theme =
    _theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : _theme;

  const min = stats?.[0]?.date ?? 0;
  const max = stats?.[stats.length - 1]?.date ?? 0;
  const diff = max - min;

  const timeAxis = useMemo((): AxisOptions<StatDatapoint> => {
    return {
      getValue: (datum) => new Date(datum.date),
      hardMax: new Date(max + diff * 0.02),
      hardMin: new Date(min - diff * 0.02),
      tickCount: 6,
      formatters: {
        // scale: (value?: Date) => fmt_date(value ?? new Date()),
        tooltip: (value?: Date) => (
          <div className="text-lg font-mono">
            {fmt_utc_date(value ?? new Date())}
          </div>
        ),
        cursor: (_value?: Date) => false,
      },
    };
  }, []);

  // Determine the axis max dynamically
  const allValues = (seriesData ?? [{ data: stats ?? [] }]).flatMap((s) => s.data.map((d) => d.value));
  const maxStatValue = Math.max(...(allValues.length ? allValues : [0]));

  const { unit, unitDivisor, maxUnitValue } = useMemo(() => {
    if (type === "Network Ingress" || type === "Network Egress") {
      // Choose best unit based on observed max B/s
      const choose = () => {
        if (maxStatValue >= BYTES_PER_MB) {
          return { unit: "MB/s" as const, unitDivisor: BYTES_PER_MB };
        } else if (maxStatValue >= BYTES_PER_KB) {
          return { unit: "KB/s" as const, unitDivisor: BYTES_PER_KB };
        } else {
          return { unit: "B/s" as const, unitDivisor: 1 };
        }
      };
      const chosen = choose();
      const ret = {
        unit: chosen.unit,
        unitDivisor: chosen.unitDivisor,
        maxUnitValue: (maxStatValue === 0 ? 1 : maxStatValue * 1.2) / chosen.unitDivisor,
      };
      try {
        // eslint-disable-next-line no-console
        console.debug("[StatChart] axis", type, { maxStatValue_Bps: maxStatValue, unit: ret.unit, maxUnitValue_units: ret.maxUnitValue });
      } catch {}
      return ret;
    }
    if (type === "Load Average") {
      return { unit: "", unitDivisor: 1, maxUnitValue: maxStatValue === 0 ? 1 : maxStatValue * 1.2 };
    }
    return { unit: "", unitDivisor: 1, maxUnitValue: 100 }; // Default for CPU, memory, disk
  }, [type, maxStatValue]);

  const valueAxis = useMemo(
    (): AxisOptions<StatDatapoint>[] => [
      {
        getValue: (datum) => {
          if (type === "Network Ingress" || type === "Network Egress") {
            // Convert stored B/s to selected unit for plotting
            return datum.value / unitDivisor;
          }
          return datum.value;
        },
        elementType: type === "Load Average" ? "line" : "area",
        stacked: type !== "Load Average",
        min: 0,
        max: maxUnitValue,
        formatters: {
          tooltip: (value?: number) => {
            const v = value ?? 0;
            const fmt = (u: string) =>
              u === "MB/s" ? v.toFixed(2) : u === "KB/s" ? v.toFixed(1) : Math.round(v).toString();
            return (
              <div className="text-lg font-mono">
                {type === "Network Ingress" || type === "Network Egress"
                  ? `${fmt(unit)} ${unit}`
                  : type === "Load Average"
                    ? `${v.toFixed(2)}`
                    : `${v.toFixed(2)}%`}
              </div>
            );
          },
          // Format Y-axis ticks
          scale: (value?: number) => {
            const v = value ?? 0;
            if (type === "Network Ingress" || type === "Network Egress") {
              return unit === "MB/s" ? `${v.toFixed(2)} MB/s` : unit === "KB/s" ? `${v.toFixed(1)} KB/s` : `${Math.round(v)} B/s`;
            }
            return type === "Load Average" ? `${v.toFixed(1)}` : `${v.toFixed(0)}%`;
          },
        },
      },
    ],
    [type, maxUnitValue, unit, unitDivisor]
  );
  return (
    <Chart
      options={{
        data: seriesData ?? [{ label: type, data: stats ?? [] }],
        primaryAxis: timeAxis,
        secondaryAxes: valueAxis,
        defaultColors:
          type === "Load Average"
            ? [
                hex_color_by_intention("Good"),
                hex_color_by_intention("Neutral"),
                hex_color_by_intention("Unknown"),
              ]
            : [getColor(type)],
        dark: theme === "dark",
        padding: {
          left: 10,
          right: 10,
        },
        // tooltip: {
        //   showDatumInTooltip: () => false,
        // },
      }}
    />
  );
};

const getStat = (stat: Types.SystemStatsRecord, type: StatType) => {
  if (type === "Cpu") return stat.cpu_perc || 0;
  if (type === "Memory") return (100 * stat.mem_used_gb) / stat.mem_total_gb;
  if (type === "Disk") return (100 * stat.disk_used_gb) / stat.disk_total_gb;
  if (type === "Network Ingress") return stat.network_ingress_bytes || 0;
  if (type === "Network Egress") return stat.network_egress_bytes || 0;
  return 0;
};

const getColor = (type: StatType) => {
  if (type === "Cpu") return hex_color_by_intention("Good");
  if (type === "Memory") return hex_color_by_intention("Warning");
  if (type === "Disk") return hex_color_by_intention("Neutral");
  if (type === "Network Ingress") return hex_color_by_intention("Good");
  if (type === "Network Egress") return hex_color_by_intention("Critical");
  return hex_color_by_intention("Unknown");
};

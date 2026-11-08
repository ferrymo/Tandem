"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App as AntdApp, DatePicker, Popover, Segmented, Spin } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { api, type LogItem, type MineEffort, type TeamEffort } from "@/lib/api";
import { useUser } from "@/lib/user";

type Preset = "week" | "month" | "30d" | "custom";

function rangeOf(preset: Preset, custom: [Dayjs, Dayjs] | null): [Dayjs, Dayjs] {
  const today = dayjs();
  switch (preset) {
    case "week": {
      const dow = today.day() === 0 ? 7 : today.day();
      const monday = today.subtract(dow - 1, "day");
      return [monday, today];
    }
    case "month":
      return [today.startOf("month"), today];
    case "30d":
      return [today.subtract(29, "day"), today];
    case "custom":
      return custom ?? [today.subtract(6, "day"), today];
  }
}

/** 工时格颜色：0h 无色 → 高工时深蓝 */
function cellColor(total: number): { bg: string; color: string } {
  if (total <= 0) return { bg: "transparent", color: "#bfbfbf" };
  const alpha = Math.min(0.14 + total / 12, 0.92);
  return {
    bg: `rgba(22, 119, 255, ${alpha.toFixed(2)})`,
    color: alpha > 0.5 ? "#fff" : "#1677ff",
  };
}

export default function TimelinePage() {
  const { message } = AntdApp.useApp();
  const user = useUser();
  const [preset, setPreset] = useState<Preset>("week");
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | null>(null);
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [items, setItems] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(false);

  const isLead = Boolean(user?.lead);

  const [from, to] = rangeOf(preset, custom);
  const fromStr = from.format("YYYY-MM-DD");
  const toStr = to.format("YYYY-MM-DD");

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const useTeam = isLead && scope === "all";
      const path = useTeam
        ? `/api/effort/team?from=${fromStr}&to=${toStr}`
        : `/api/effort/mine?from=${fromStr}&to=${toStr}`;
      const d = await api<TeamEffort | MineEffort>(path);
      setItems(d.items ?? []);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user, isLead, scope, fromStr, toStr, message]);

  useEffect(() => {
    reload();
  }, [reload]);

  const days = useMemo(() => {
    const out: Dayjs[] = [];
    let d = from;
    while (!d.isAfter(to, "day")) {
      out.push(d);
      d = d.add(1, "day");
    }
    return out;
  }, [from, to]);

  const { persons, cellMap } = useMemo(() => {
    const persons: Array<{ account: string; realname: string }> = [];
    const seen = new Set<string>();
    const cellMap = new Map<string, { total: number; details: LogItem[] }>();
    for (const it of items) {
      if (!seen.has(it.account)) {
        seen.add(it.account);
        persons.push({ account: it.account, realname: it.realname || it.account });
      }
      const key = `${it.account}|${it.date}`;
      const cell = cellMap.get(key) ?? { total: 0, details: [] };
      cell.total = Math.round((cell.total + it.consumed) * 100) / 100;
      cell.details.push(it);
      cellMap.set(key, cell);
    }
    persons.sort((a, b) => a.realname.localeCompare(b.realname, "zh"));
    return { persons, cellMap };
  }, [items]);

  const dayTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) m.set(it.date, Math.round(((m.get(it.date) ?? 0) + it.consumed) * 100) / 100);
    return m;
  }, [items]);

  const grandTotal = Math.round(items.reduce((a, i) => a + i.consumed, 0) * 100) / 100;
  const cellW = 52;
  const gridTemplate = `150px repeat(${days.length}, ${cellW}px) 90px`;

  return (
    <div style={{ padding: 16 }}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          value={preset}
          onChange={(v) => setPreset(v as Preset)}
          options={[
            { value: "week", label: "本周" },
            { value: "month", label: "本月" },
            { value: "30d", label: "近30天" },
            { value: "custom", label: "自定义" },
          ]}
        />
        <DatePicker.RangePicker
          value={[from, to]}
          allowClear={false}
          onChange={(v) => {
            if (v && v[0] && v[1]) {
              setCustom([v[0], v[1]]);
              setPreset("custom");
            }
          }}
        />
        {isLead && (
          <Segmented
            value={scope}
            onChange={(v) => setScope(v as "all" | "mine")}
            options={[
              { value: "all", label: "全员" },
              { value: "mine", label: "仅自己" },
            ]}
          />
        )}
        <span className="text-sm text-gray-500">
          合计 <b>{grandTotal}</b>h · {persons.length} 人
        </span>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="数据来源：通过本工具提交的工时；接入禅道只读数据库后将展示全量历史工时（含网页登记）"
      />

      <Spin spinning={loading}>
        {persons.length === 0 ? (
          <div className="py-16 text-center text-gray-400">该范围内暂无工时记录</div>
        ) : (
          <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 260px)" }}>
            <div className="timeline-grid" style={{ gridTemplateColumns: gridTemplate }}>
              {/* 表头 */}
              <div className="tl-cell tl-head tl-sticky-name" style={{ zIndex: 3 }}>
                成员 / 日期
              </div>
              {days.map((d) => (
                <div
                  key={d.format("YYYY-MM-DD")}
                  className="tl-cell tl-head"
                  style={{
                    background: [0, 6].includes(d.day()) ? "#f5f5f5" : "#fafafa",
                    flexDirection: "column",
                    justifyContent: "center",
                    gap: 0,
                    lineHeight: 1.3,
                    ...(d.isSame(dayjs(), "day")
                      ? { color: "#1677ff", background: "#e6f4ff" }
                      : {}),
                  }}
                >
                  <span>{d.format("MM-DD")}</span>
                  <span style={{ fontSize: 10, color: "#999", fontWeight: 400 }}>
                    {"日一二三四五六"[d.day()]}
                  </span>
                </div>
              ))}
              <div className="tl-cell tl-head" style={{ justifyContent: "center" }}>
                合计(h)
              </div>

              {/* 数据行 */}
              {persons.map((p) => {
                const rowTotal =
                  Math.round(
                    days.reduce(
                      (a, d) => a + (cellMap.get(`${p.account}|${d.format("YYYY-MM-DD")}`)?.total ?? 0),
                      0,
                    ) * 100,
                  ) / 100;
                return (
                  <div key={p.account} style={{ display: "contents" }}>
                    <div className="tl-cell tl-sticky-name">{p.realname}</div>
                    {days.map((d) => {
                      const key = `${p.account}|${d.format("YYYY-MM-DD")}`;
                      const cell = cellMap.get(key);
                      const { bg, color } = cellColor(cell?.total ?? 0);
                      const weekend = [0, 6].includes(d.day());
                      return (
                        <div
                          key={key}
                          className="tl-cell"
                          style={{
                            background: weekend && !cell ? "#fafafa" : bg,
                            color,
                            fontWeight: cell ? 600 : 400,
                          }}
                        >
                          {cell && (
                            <Popover
                              title={`${p.realname} · ${d.format("MM月DD日")}（${cell.total}h）`}
                              content={
                                <div style={{ maxWidth: 360 }}>
                                  {cell.details.map((det, i) => (
                                    <div key={i} style={{ padding: "3px 0", fontSize: 12 }}>
                                      <b style={{ color: "#1677ff" }}>{det.consumed}h</b>
                                      {"  "}
                                      [{det.projectName}] {det.taskName}
                                      {det.work ? ` — ${det.work}` : ""}
                                    </div>
                                  ))}
                                </div>
                              }
                            >
                              <span style={{ cursor: "pointer" }}>{cell.total}</span>
                            </Popover>
                          )}
                        </div>
                      );
                    })}
                    <div
                      className="tl-cell"
                      style={{ justifyContent: "center", fontWeight: 700, color: "#333" }}
                    >
                      {rowTotal}
                    </div>
                  </div>
                );
              })}

              {/* 日合计行 */}
              <div
                className="tl-cell tl-sticky-name"
                style={{ background: "#fafafa", fontWeight: 700 }}
              >
                当日团队合计
              </div>
              {days.map((d) => (
                <div
                  key={d.format("YYYY-MM-DD")}
                  className="tl-cell"
                  style={{ justifyContent: "center", background: "#fafafa", fontWeight: 600 }}
                >
                  {dayTotals.get(d.format("YYYY-MM-DD")) ?? ""}
                </div>
              ))}
              <div
                className="tl-cell"
                style={{ justifyContent: "center", background: "#fafafa", fontWeight: 700 }}
              >
                {grandTotal}
              </div>
            </div>
          </div>
        )}
      </Spin>
    </div>
  );
}

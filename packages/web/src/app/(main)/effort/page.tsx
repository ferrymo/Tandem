"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  DatePicker,
  Input,
  InputNumber,
  Popover,
  Progress,
  Segmented,
  Table,
  Tabs,
  Tag,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import {
  api,
  type Bucket,
  type LogItem,
  type MineEffort,
  type ProjectAgg,
  type SummaryDto,
  type TaskDto,
  type TeamEffort,
} from "@/lib/api";
import { useUser } from "@/lib/user";
import { Avatar, ProjectDot, projectColor } from "@/components/ui";

type Preset = "week" | "month" | "30d" | "custom";

function rangeOf(preset: Preset, custom: [Dayjs, Dayjs] | null): [Dayjs, Dayjs] {
  const today = dayjs();
  switch (preset) {
    case "week": {
      const dow = today.day() === 0 ? 7 : today.day();
      return [today.subtract(dow - 1, "day"), today];
    }
    case "month":
      return [today.startOf("month"), today];
    case "30d":
      return [today.subtract(29, "day"), today];
    case "custom":
      return custom ?? [today.subtract(6, "day"), today];
  }
}

/* ================= 填报 ================= */

interface RowForm {
  consumed: number;
  left: number;
  work: string;
}

function FillTab({ onChanged }: { onChanged?: () => void }) {
  const { message } = AntdApp.useApp();
  const user = useUser();
  const [date, setDate] = useState<Dayjs>(dayjs());
  const [rows, setRows] = useState<TaskDto[]>([]);
  const [form, setForm] = useState<Record<number, RowForm>>({});
  const [results, setResults] = useState<Record<number, boolean | string>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const total = useMemo(
    () => Math.round(rows.reduce((a, r) => a + (form[r.id]?.consumed ?? 0), 0) * 100) / 100,
    [rows, form],
  );

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const r = await api<{ tasks: TaskDto[] }>("/api/effort/tasks");
      setRows(r.tasks);
      setForm((prev) => {
        const next: Record<number, RowForm> = {};
        for (const t of r.tasks) {
          next[t.id] = prev[t.id] ?? { consumed: 0, left: t.left, work: "" };
          next[t.id].left = t.left;
        }
        return next;
      });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user, message]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function submit() {
    const entries = rows
      .filter((r) => (form[r.id]?.consumed ?? 0) > 0)
      .map((r) => ({ taskId: r.id, consumed: form[r.id].consumed, left: form[r.id].left, work: form[r.id].work }));
    if (entries.length === 0) return;
    setSubmitting(true);
    setResults({});
    try {
      const resp = await api<{ results: Array<{ taskId: number; ok: boolean; error?: string }> }>("/api/effort/submit", {
        method: "POST",
        body: { date: date.format("YYYY-MM-DD"), entries },
      });
      const next: Record<number, boolean | string> = {};
      for (const r of resp.results) next[r.taskId] = r.ok ? true : r.error ?? "失败";
      setResults(next);
      const okCount = resp.results.filter((r) => r.ok).length;
      if (okCount > 0) {
        message.success(`已登记 ${okCount} 条工时到禅道`);
        window.dispatchEvent(new CustomEvent("ztp:user-updated"));
        onChanged?.();
      }
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const pct = Math.min(Math.round((total / 8) * 100), 100);

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <DatePicker value={date} onChange={(d) => d && setDate(d)} allowClear={false} style={{ width: 140 }} />
        <Button size="small" type="text" onClick={() => setDate(dayjs().subtract(1, "day"))}>
          昨天
        </Button>
        <Button size="small" type="text" onClick={() => setDate(dayjs())}>
          今天
        </Button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
          今日合计 <b style={{ fontSize: 16, color: "var(--text-1)" }}>{total}</b> / 8h
        </span>
        <div style={{ width: 120 }}>
          <Progress percent={pct} size={["100%", 6]} showInfo={false} strokeColor={pct >= 100 ? "#16a34a" : "#5b5bd6"} />
        </div>
        <Button type="primary" loading={submitting} disabled={total <= 0} onClick={submit}>
          提交到禅道
        </Button>
      </div>

      <div className="card" style={{ padding: "4px 16px 10px" }}>
        <Table<TaskDto>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: "没有指派给你的进行中/待开始任务" }}
          columns={[
            {
              title: "任务",
              key: "task",
              ellipsis: true,
              render: (_: unknown, r: TaskDto) => (
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <ProjectDot name={r.projectName} />
                  <span style={{ fontWeight: 500 }}>{r.name}</span>
                </span>
              ),
            },
            { title: "项目", dataIndex: "projectName", width: 120, ellipsis: true },
            { title: "剩余(h)", dataIndex: "left", width: 78 },
            {
              title: "当日工时(h)",
              width: 120,
              render: (_: unknown, r: TaskDto) => (
                <InputNumber
                  size="small"
                  min={0}
                  max={24}
                  step={0.5}
                  style={{ width: 100 }}
                  value={form[r.id]?.consumed ?? 0}
                  onChange={(v) => setForm((f) => ({ ...f, [r.id]: { ...f[r.id], consumed: v ?? 0 } }))}
                />
              ),
            },
            {
              title: "完成后剩余(h)",
              width: 130,
              render: (_: unknown, r: TaskDto) => (
                <InputNumber
                  size="small"
                  min={0}
                  step={0.5}
                  style={{ width: 110 }}
                  value={form[r.id]?.left ?? 0}
                  onChange={(v) => setForm((f) => ({ ...f, [r.id]: { ...f[r.id], left: v ?? 0 } }))}
                />
              ),
            },
            {
              title: "工作内容",
              width: 200,
              render: (_: unknown, r: TaskDto) => (
                <Input
                  size="small"
                  placeholder="选填"
                  value={form[r.id]?.work ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, [r.id]: { ...f[r.id], work: e.target.value } }))}
                />
              ),
            },
            {
              title: "结果",
              width: 90,
              render: (_: unknown, r: TaskDto) =>
                results[r.id] === true ? (
                  <Tag color="success" style={{ borderRadius: 6 }}>已记入</Tag>
                ) : typeof results[r.id] === "string" ? (
                  <Tag color="error" style={{ borderRadius: 6 }}>失败</Tag>
                ) : null,
            },
          ]}
        />
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-3)" }}>
        提交即写入禅道任务工时（可在任务详情核对）；左侧剩余工时可按实际情况调整，完成后置 0。
      </div>
    </>
  );
}

/* ================= 时间轴 ================= */

function TimelineTab() {
  const { message } = AntdApp.useApp();
  const user = useUser();
  const isLead = Boolean(user?.lead);
  const [preset, setPreset] = useState<Preset>("week");
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | null>(null);
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [items, setItems] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(false);

  const [from, to] = rangeOf(preset, custom);
  const fromStr = from.format("YYYY-MM-DD");
  const toStr = to.format("YYYY-MM-DD");

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const useTeam = isLead && scope === "all";
      const d = await api<TeamEffort | MineEffort>(
        useTeam ? `/api/effort/team?from=${fromStr}&to=${toStr}` : `/api/effort/mine?from=${fromStr}&to=${toStr}`,
      );
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
  const cellW = 50;
  const gridTemplate = `190px repeat(${days.length}, ${cellW}px) 90px`;

  function cellColor(total: number): { bg: string; color: string } {
    if (total <= 0) return { bg: "transparent", color: "var(--text-3)" };
    const alpha = Math.min(0.16 + total / 12, 0.92);
    return { bg: `rgba(91, 91, 214, ${alpha.toFixed(2)})`, color: alpha > 0.55 ? "#fff" : "#4747b8" };
  }

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 14 }}>
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
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
          合计 <b style={{ color: "var(--text-1)" }}>{grandTotal}</b>h · {persons.length} 人
        </span>
      </div>

      {persons.length === 0 ? (
        <div className="card empty-hint">该范围内暂无工时记录（当前统计经本工具提交的工时；接入禅道数据库后展示全量）</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "auto", maxHeight: "calc(100vh - 300px)" }}>
          <div className="tl-grid" style={{ gridTemplateColumns: gridTemplate }}>
            <div className="tl-cell tl-head-cell tl-name" style={{ zIndex: 3 }}>
              成员 / 日期
            </div>
            {days.map((d) => (
              <div
                key={d.format("YYYY-MM-DD")}
                className="tl-cell tl-head-cell"
                style={{
                  flexDirection: "column",
                  justifyContent: "center",
                  gap: 0,
                  lineHeight: 1.35,
                  background: d.isSame(dayjs(), "day") ? "var(--accent-weak)" : "#fafafc",
                  color: d.isSame(dayjs(), "day") ? "#4747b8" : "var(--text-2)",
                }}
              >
                <span>{d.format("MM-DD")}</span>
                <span style={{ fontSize: 10, fontWeight: 400, color: "var(--text-3)" }}>{"日一二三四五六"[d.day()]}</span>
              </div>
            ))}
            <div className="tl-cell tl-head-cell" style={{ justifyContent: "center" }}>
              合计(h)
            </div>

            {persons.map((p) => {
              const rowTotal =
                Math.round(
                  days.reduce((a, d) => a + (cellMap.get(`${p.account}|${d.format("YYYY-MM-DD")}`)?.total ?? 0), 0) * 100,
                ) / 100;
              return (
                <div key={p.account} style={{ display: "contents" }}>
                  <div className="tl-cell tl-name">
                    <Avatar name={p.realname} size={24} />
                    {p.realname}
                  </div>
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
                          borderRadius: cell ? 4 : 0,
                        }}
                      >
                        {cell && (
                          <Popover
                            title={`${p.realname} · ${d.format("MM月DD日")}（${cell.total}h）`}
                            content={
                              <div style={{ maxWidth: 360 }}>
                                {cell.details.map((det, i) => (
                                  <div key={i} style={{ padding: "3px 0", fontSize: 12 }}>
                                    <b style={{ color: "#5b5bd6" }}>{det.consumed}h</b> [{det.projectName}] {det.taskName}
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
                  <div className="tl-cell" style={{ justifyContent: "center", fontWeight: 700 }}>
                    {rowTotal}
                  </div>
                </div>
              );
            })}

            <div className="tl-cell tl-name" style={{ background: "#fafafc", fontWeight: 650, color: "var(--text-2)" }}>
              当日团队合计
            </div>
            {days.map((d) => (
              <div
                key={d.format("YYYY-MM-DD")}
                className="tl-cell"
                style={{ justifyContent: "center", background: "#fafafc", fontWeight: 600 }}
              >
                {dayTotals.get(d.format("YYYY-MM-DD")) ?? ""}
              </div>
            ))}
            <div className="tl-cell" style={{ justifyContent: "center", background: "#fafafc", fontWeight: 700 }}>
              {grandTotal}
            </div>
          </div>
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-3)" }}>
        数据来源：通过本工具提交的工时；接入禅道只读数据库后将展示全量历史工时（含网页登记）。
      </div>
    </>
  );
}

/* ================= 统计 ================= */

function StatsTab() {
  const user = useUser();
  const [mine, setMine] = useState<MineEffort | null>(null);
  const [team, setTeam] = useState<TeamEffort | null>(null);
  const [summary, setSummary] = useState<SummaryDto | null>(null);

  useEffect(() => {
    if (!user) return;
    const monday = (() => {
      const t = dayjs();
      const dow = t.day() === 0 ? 7 : t.day();
      return t.subtract(dow - 1, "day").format("YYYY-MM-DD");
    })();
    const today = dayjs().format("YYYY-MM-DD");
    const jobs: Promise<unknown>[] = [
      api<MineEffort>(`/api/effort/mine?from=${monday}&to=${today}`).then(setMine),
      api<SummaryDto>("/api/effort/summary").then(setSummary),
    ];
    if (user.lead) jobs.push(api<TeamEffort>(`/api/effort/team?from=${monday}&to=${today}`).then(setTeam));
    Promise.all(jobs).catch(() => {});
  }, [user]);

  const bucketCols = (title: string, dataKey: "key") => [
    { title, dataIndex: dataKey, ellipsis: true },
    { title: "工时(h)", dataIndex: "total", width: 100 },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
      <div className="card" style={{ padding: "16px 18px" }}>
        <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 10 }}>我本周 · 按日</div>
        <Table<Bucket> size="small" rowKey="key" columns={bucketCols("日期", "key")} dataSource={mine?.byDate ?? []} pagination={false} />
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-3)" }}>本周合计 {mine?.total ?? 0}h</div>
      </div>
      <div className="card" style={{ padding: "16px 18px" }}>
        <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 10 }}>我本周 · 按项目</div>
        <Table<Bucket> size="small" rowKey="key" columns={bucketCols("项目", "key")} dataSource={mine?.byProject ?? []} pagination={false} />
      </div>
      {user?.lead && (
        <div className="card" style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 10 }}>团队本周</div>
          <Table<{ account: string; realname: string; total: number }>
            size="small"
            rowKey="account"
            columns={[
              {
                title: "成员",
                dataIndex: "realname",
                render: (n: string, r) => (
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <Avatar name={n} size={22} /> {n}
                  </span>
                ),
              },
              { title: "工时(h)", dataIndex: "total", width: 90 },
            ]}
            dataSource={team?.byAccount ?? []}
            pagination={false}
            scroll={{ y: 300 }}
          />
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-3)" }}>团队合计 {team?.total ?? 0}h（本工具提交口径）</div>
        </div>
      )}
      <div className="card" style={{ padding: "16px 18px" }}>
        <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 10 }}>项目工时累计（全量·来自禅道）</div>
        <Table<ProjectAgg>
          size="small"
          rowKey="projectId"
          columns={[
            {
              title: "项目",
              dataIndex: "projectName",
              ellipsis: true,
              render: (n: string) => (
                <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <ProjectDot name={n} /> {n}
                </span>
              ),
            },
            { title: "任务数", dataIndex: "taskCount", width: 70 },
            { title: "消耗(h)", dataIndex: "consumed", width: 80 },
            { title: "剩余(h)", dataIndex: "left", width: 80 },
          ]}
          dataSource={summary?.byProject ?? []}
          pagination={false}
          scroll={{ y: 300 }}
        />
      </div>
    </div>
  );
}

/* ================= 页面 ================= */

export default function EffortPage() {
  const user = useUser();
  const [tab, setTab] = useState("fill");
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">工时</div>
          <div className="page-desc">填报、时间轴与统计分析</div>
        </div>
      </div>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "fill", label: "填报", children: <FillTab onChanged={() => setRefreshKey((k) => k + 1)} /> },
          { key: "timeline", label: "时间轴", children: <TimelineTab /> },
          { key: "stats", label: "统计", children: <StatsTab key={refreshKey} /> },
        ]}
      />
    </div>
  );
}

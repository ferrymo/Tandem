"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { App as AntdApp, Button, DatePicker, Select, Spin, Table, Tag, Tooltip } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { api, type TaskDto } from "@/lib/api";
import { useUser } from "@/lib/user";
import { Avatar, projectColor } from "@/components/ui";

const DAY_W = 40;
const ACTIVE = ["wait", "doing", "pause"];

interface Bar {
  task: TaskDto;
  start: Dayjs;
  end: Dayjs;
  lane: number;
  clampedLeft: boolean;
  clampedRight: boolean;
  overdue: boolean;
}

interface PersonPlan {
  account: string;
  realname: string;
  projects: string[];
  activeCount: number;
  unscheduled: number;
  latestDeadline: string;
  freeFrom: string;
  freeSoon: boolean;
  bars: Bar[];
}

export default function PlanPage() {
  const { message } = AntdApp.useApp();
  const user = useUser();
  const isLead = Boolean(user?.lead);

  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs(), dayjs().add(30, "day")]);
  const [selected, setSelected] = useState<string[] | undefined>(undefined);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [users, setUsers] = useState<Array<{ account: string; realname: string }>>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [t, u] = await Promise.all([
        api<{ tasks: TaskDto[] }>(`/api/tasks?limit=2000${isLead ? "" : "&mine=1"}`),
        isLead ? api<Array<{ account: string; realname: string }>>("/api/users") : Promise.resolve([]),
      ]);
      setTasks(t.tasks);
      setUsers(u);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user, isLead, message]);

  useEffect(() => {
    reload();
  }, [reload]);

  const [from, to] = range;
  const days = useMemo(() => {
    const out: Dayjs[] = [];
    let d = from;
    while (!d.isAfter(to, "day")) {
      out.push(d);
      d = d.add(1, "day");
    }
    return out;
  }, [from, to]);

  const todayStr = dayjs().format("YYYY-MM-DD");

  const plans = useMemo<PersonPlan[]>(() => {
    const byPerson = new Map<string, TaskDto[]>();
    for (const t of tasks) {
      if (!ACTIVE.includes(t.status) || !t.assignedTo) continue;
      const arr = byPerson.get(t.assignedTo.account) ?? [];
      arr.push(t);
      byPerson.set(t.assignedTo.account, arr);
    }
    const result: PersonPlan[] = [];
    for (const [account, list] of byPerson) {
      const realname = list[0]?.assignedTo?.realname || account;
      const bars: Bar[] = [];
      let unscheduled = 0;
      const laneEnds: string[] = [];
      for (const t of list) {
        const hasStart = Boolean(t.estStarted);
        const hasDeadline = Boolean(t.deadline);
        if (!hasStart && !hasDeadline) {
          unscheduled++;
          continue;
        }
        const startRaw = hasStart
          ? dayjs(t.estStarted)
          : dayjs(t.deadline).isAfter(dayjs())
            ? dayjs(t.deadline).subtract(2, "day")
            : dayjs();
        const endRaw = hasDeadline ? dayjs(t.deadline) : startRaw.add(1, "day");
        if (endRaw.isBefore(from, "day") || startRaw.isAfter(to, "day")) continue;
        const start = startRaw.isBefore(from, "day") ? from : startRaw;
        const end = endRaw.isAfter(to, "day") ? to : endRaw;
        let lane = laneEnds.findIndex((e) => e < start.format("YYYY-MM-DD"));
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push("");
        }
        laneEnds[lane] = end.format("YYYY-MM-DD");
        bars.push({
          task: t,
          start,
          end,
          lane,
          clampedLeft: startRaw.isBefore(from, "day"),
          clampedRight: endRaw.isAfter(to, "day"),
          overdue: hasDeadline && t.deadline < todayStr,
        });
      }
      bars.sort((a, b) => a.start.valueOf() - b.start.valueOf());
      const futureDeadlines = list
        .filter((t) => t.deadline && t.deadline >= todayStr)
        .map((t) => t.deadline)
        .sort();
      const allDeadlines = list.map((t) => t.deadline).filter(Boolean).sort();
      result.push({
        account,
        realname,
        projects: [...new Set(list.map((t) => t.projectName))],
        activeCount: list.length,
        unscheduled,
        latestDeadline: allDeadlines[allDeadlines.length - 1] ?? "",
        freeFrom: futureDeadlines.length
          ? dayjs(futureDeadlines[futureDeadlines.length - 1]).add(1, "day").format("MM-DD")
          : list.length
            ? "待排期"
            : "现在有空",
        freeSoon: futureDeadlines.length === 0,
        bars,
      });
    }
    result.sort((a, b) => a.freeFrom.localeCompare(b.freeFrom) || b.activeCount - a.activeCount);
    return result;
  }, [tasks, from, to, todayStr]);

  const shown = useMemo(() => {
    if (!selected || selected.length === 0) return plans;
    return plans.filter((p) => selected.includes(p.account));
  }, [plans, selected]);

  const gridW = days.length * DAY_W;
  const offsetOf = (d: Dayjs) => d.diff(from, "day") * DAY_W;
  const todayIdx = dayjs().isBefore(from, "day") || dayjs().isAfter(to, "day") ? -1 : dayjs().diff(from, "day");

  const barTooltip = (b: Bar) => (
    <div style={{ maxWidth: 340, fontSize: 12 }}>
      <div style={{ fontWeight: 600 }}>{b.task.name}</div>
      <div style={{ marginTop: 3 }}>
        {b.task.projectName} · {b.task.executionName}
      </div>
      <div>
        排期：{b.task.estStarted || "未填"} → {b.task.deadline || "未填"}
        {b.clampedLeft ? "（早于视图）" : ""}
        {b.clampedRight ? "（晚于视图）" : ""}
      </div>
      <div>
        状态 {b.task.status} · 剩余 {b.task.left}h
      </div>
      {b.overdue && <div style={{ color: "#ef4444" }}>⚠ 已逾期</div>}
    </div>
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">排期</div>
          <div className="page-desc">成员任务排期与空档规划——颜色为项目，红框为逾期，竖线为今天</div>
        </div>
        <Button onClick={() => reload()}>刷新</Button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <DatePicker.RangePicker
          value={range}
          allowClear={false}
          onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
        />
        {isLead && (
          <Select
            mode="multiple"
            allowClear
            placeholder="全部成员"
            style={{ minWidth: 280, maxWidth: 560 }}
            value={selected}
            onChange={setSelected}
            options={users.map((u) => ({ value: u.account, label: u.realname }))}
            maxTagCount="responsive"
          />
        )}
        <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
          {shown.length} 人 · {shown.reduce((a, p) => a + p.bars.length, 0)} 条排期
        </span>
      </div>

      {/* 空档速览 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {shown.slice(0, 12).map((p) => (
          <span
            key={p.account}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              fontSize: 12.5,
            }}
          >
            <Avatar name={p.realname} size={20} />
            {p.realname}
            <Tag color={p.freeSoon ? "success" : "default"} style={{ borderRadius: 999, marginInlineEnd: 0 }}>
              {p.freeSoon} 起空闲
            </Tag>
          </span>
        ))}
      </div>

      <Spin spinning={loading}>
        <div className="card" style={{ padding: 0, overflow: "auto", maxHeight: "calc(100vh - 300px)" }}>
          <div style={{ minWidth: gridW + 250 }}>
            {/* 日期标尺 */}
            <div style={{ display: "flex" }}>
              <div
                className="tl-name"
                style={{ width: 250, minWidth: 250, height: 40, fontWeight: 650, color: "var(--text-2)", background: "#fafafc", position: "sticky", top: 0, zIndex: 2 }}
              >
                成员
              </div>
              {days.map((d) => (
                <div
                  key={d.format("YYYY-MM-DD")}
                  style={{
                    width: DAY_W,
                    height: 40,
                    flexShrink: 0,
                    textAlign: "center",
                    fontSize: 11,
                    lineHeight: "15px",
                    paddingTop: 5,
                    background: [0, 6].includes(d.day())
                      ? "#fafafa"
                      : d.isSame(dayjs(), "day")
                        ? "var(--accent-weak)"
                        : "#fafafc",
                    color: d.isSame(dayjs(), "day") ? "#4747b8" : "var(--text-2)",
                    fontWeight: d.isSame(dayjs(), "day") ? 700 : 400,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div>{d.format("M/D")}</div>
                  <div style={{ color: "var(--text-3)" }}>{"日一二三四五六"[d.day()]}</div>
                </div>
              ))}
            </div>

            {shown.map((p) => {
              const lanes = Math.max(1, ...p.bars.map((b) => b.lane + 1));
              const rowH = lanes * 30 + 12;
              return (
                <div key={p.account} style={{ display: "flex", borderBottom: "1px solid #f2f2f6" }}>
                  <div
                    className="tl-name"
                    style={{ width: 250, minWidth: 250, height: rowH, justifyContent: "space-between" }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Avatar name={p.realname} size={26} />
                      <span style={{ fontWeight: 600 }}>{p.realname}</span>
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-3)" }}>{p.activeCount} 任务</span>
                  </div>
                  <div style={{ position: "relative", width: gridW, height: rowH, flexShrink: 0 }}>
                    {days.map((d, i) => (
                      <div
                        key={i}
                        style={{
                          position: "absolute",
                          left: i * DAY_W,
                          top: 0,
                          width: DAY_W,
                          height: rowH,
                          background: [0, 6].includes(d.day()) ? "#fafbfc" : undefined,
                          borderRight: "1px solid #f5f5f8",
                        }}
                      />
                    ))}
                    {todayIdx >= 0 && (
                      <div
                        style={{
                          position: "absolute",
                          left: todayIdx * DAY_W + DAY_W / 2,
                          top: 0,
                          width: 2,
                          height: rowH,
                          background: "#ef4444",
                          opacity: 0.55,
                          zIndex: 1,
                        }}
                      />
                    )}
                    {p.bars.map((b) => {
                      const left = offsetOf(b.start);
                      const width = Math.max((b.end.diff(b.start, "day") + 1) * DAY_W - 4, 8);
                      return (
                        <Tooltip key={b.task.id} title={barTooltip(b)}>
                          <div
                            className={`gantt-bar${b.overdue ? " gantt-bar-overdue" : ""}`}
                            style={{
                              left: left + 2,
                              width,
                              top: 6 + b.lane * 30,
                              background: projectColor(b.task.projectName),
                            }}
                          >
                            {b.clampedLeft ? "◀ " : ""}
                            {b.task.name}
                          </div>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {shown.length === 0 && !loading && <div className="empty-hint">范围内没有进行中的任务排期</div>}
          </div>
        </div>
      </Spin>
      <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-3)" }}>
        提示：禅道任务普遍缺少「预计开始/截止」，未填日期的任务计入上方"待排期"——建议团队规范：任务必须填截止日期。
      </div>
    </div>
  );
}

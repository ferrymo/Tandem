"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { App as AntdApp, Button, DatePicker, Empty, Segmented, Select, Spin, Tooltip } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { api, type TaskDto } from "@/lib/api";
import { useUser } from "@/lib/user";
import { Avatar, projectTone } from "@/components/ui";

const DAY_W = 36;
const ACTIVE = ["wait", "doing", "pause"];

/** 任务条配色：项目弱底 tone + 状态描边（进行中=品牌蓝实心感，其余轻描边） */
function barStyle(task: TaskDto): { bg: string; fg: string; border: string } {
  const tone = projectTone(task.projectName);
  if (task.status === "doing") {
    return { bg: tone.bg, fg: tone.fg, border: tone.fg };
  }
  if (task.status === "pause") {
    return { bg: "var(--warn-weak)", fg: "#b45309", border: "#e8c48a" };
  }
  return { bg: tone.bg, fg: "var(--ink-2)", border: "var(--line-strong)" };
}

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
  projectCount: number;
  activeCount: number;
  unscheduled: number;
  freeFrom: string;
  freeSoon: boolean;
  loadLeft: number;
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
  const [sortBy, setSortBy] = useState<string>("free");

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
      const futureDeadlines = list.filter((t) => t.deadline && t.deadline >= todayStr).map((t) => t.deadline).sort();
      const loadLeft = list.reduce((a, t) => a + t.left, 0);
      result.push({
        account,
        realname,
        projectCount: new Set(list.map((t) => t.projectId)).size,
        activeCount: list.length,
        unscheduled,
        freeFrom: futureDeadlines.length
          ? dayjs(futureDeadlines[futureDeadlines.length - 1]).add(1, "day").format("MM-DD")
          : list.length
            ? "待排期"
            : "现在有空",
        freeSoon: futureDeadlines.length === 0,
        loadLeft,
        bars,
      });
    }
    result.sort((a, b) =>
      sortBy === "load" ? b.loadLeft - a.loadLeft : a.freeFrom.localeCompare(b.freeFrom) || b.activeCount - a.activeCount,
    );
    return result;
  }, [tasks, from, to, todayStr, sortBy]);

  const shown = useMemo(() => {
    if (!selected || selected.length === 0) return plans;
    return plans.filter((p) => selected.includes(p.account));
  }, [plans, selected]);

  const gridW = days.length * DAY_W;
  const offsetOf = (d: Dayjs) => d.diff(from, "day") * DAY_W;
  const todayIdx = dayjs().isBefore(from, "day") || dayjs().isAfter(to, "day") ? -1 : dayjs().diff(from, "day");

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">排期</div>
          <div className="page-desc">成员任务排期与空档——蓝为进行中，灰为待开始，斜纹为已逾期</div>
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
            style={{ minWidth: 260, maxWidth: 520 }}
            value={selected}
            onChange={setSelected}
            options={users.map((u) => ({ value: u.account, label: u.realname }))}
            maxTagCount="responsive"
          />
        )}
        <div style={{ flex: 1 }} />
        <Segmented
          value={sortBy}
          onChange={(v) => setSortBy(v as string)}
          options={[
            { value: "free", label: "按空档" },
            { value: "load", label: "按负载" },
          ]}
        />
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
          {shown.length} 人 · {shown.reduce((a, p) => a + p.bars.length, 0)} 条排期
        </span>
      </div>

      <Spin spinning={loading}>
        {plans.length === 0 && !loading ? (
          <div className="card"><Empty description="没有进行中的任务排期" style={{ padding: 40 }} /></div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: "auto", maxHeight: "calc(100vh - 250px)" }}>
            <div style={{ minWidth: gridW + 280 }}>
              {/* 日期标尺 */}
              <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 2, background: "var(--card)" }}>
                <div
                  className="tl-name"
                  style={{ width: 280, minWidth: 280, height: 44, background: "var(--bg)", fontWeight: 500, color: "var(--ink-2)", zIndex: 3 }}
                >
                  成员
                </div>
                {days.map((d) => (
                  <div
                    key={d.format("YYYY-MM-DD")}
                    style={{
                      width: DAY_W,
                      height: 44,
                      flexShrink: 0,
                      textAlign: "center",
                      fontSize: 11,
                      lineHeight: "16px",
                      paddingTop: 6,
                      background: d.isSame(dayjs(), "day")
                        ? "var(--brand-50)"
                        : [0, 6].includes(d.day())
                          ? "var(--bg)"
                          : "var(--bg)",
                      color: d.isSame(dayjs(), "day") ? "var(--brand-500)" : "var(--ink-2)",
                      fontWeight: d.isSame(dayjs(), "day") ? 600 : 400,
                      borderBottom: "0.5px solid var(--line)",
                    }}
                  >
                    <div>{d.format("M/D")}</div>
                    <div style={{ color: "var(--ink-3)" }}>{"日一二三四五六"[d.day()]}</div>
                  </div>
                ))}
              </div>

              {shown.map((p) => {
                const lanes = Math.max(1, ...p.bars.map((b) => b.lane + 1));
                const rowH = lanes * 28 + 10;
                return (
                  <div key={p.account} style={{ display: "flex", borderBottom: "0.5px solid var(--layer-2)" }}>
                    {/* 成员信息列 */}
                    <div className="tl-name" style={{ width: 280, minWidth: 280, height: rowH, gap: 10 }}>
                      <Avatar name={p.realname} size={26} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                          {p.realname}
                          {p.freeSoon ? (
                            <span style={{ fontSize: 11, color: "var(--ok)" }}>有空档</span>
                          ) : p.unscheduled > 0 ? (
                            <span style={{ fontSize: 11, color: "var(--warn)" }}>{p.unscheduled} 未排</span>
                          ) : null}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>
                          {p.projectCount} 项目 · 余 {p.loadLeft}h
                          {!p.freeSoon && ` · ${p.freeFrom} 起空闲`}
                        </div>
                      </div>
                    </div>
                    {/* 甘特区 */}
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
                            background: [0, 6].includes(d.day()) ? "var(--bg)" : undefined,
                            borderRight: "0.5px solid var(--layer-2)",
                          }}
                        />
                      ))}
                      {todayIdx >= 0 && (
                        <div
                          style={{
                            position: "absolute",
                            left: todayIdx * DAY_W + DAY_W / 2,
                            top: 0,
                            width: 1.5,
                            height: rowH,
                            background: "var(--bad)",
                            opacity: 0.45,
                            zIndex: 1,
                          }}
                        />
                      )}
                      {p.bars.map((b) => {
                        const left = offsetOf(b.start);
                        const width = Math.max((b.end.diff(b.start, "day") + 1) * DAY_W - 4, 8);
                        const st = barStyle(b.task);
                        return (
                          <Tooltip
                            key={b.task.id}
                            title={
                              <div style={{ maxWidth: 320, fontSize: 12 }}>
                                <div style={{ fontWeight: 500 }}>{b.task.name}</div>
                                <div style={{ marginTop: 3, color: "var(--ink-2)" }}>
                                  {b.task.projectName} · {b.task.executionName}
                                </div>
                                <div style={{ marginTop: 2, color: "var(--ink-2)" }}>
                                  {b.task.estStarted || "未填"} → {b.task.deadline || "未填"} · 余 {b.task.left}h
                                </div>
                                {b.overdue && <div style={{ color: "#ef4444", marginTop: 2 }}>已逾期</div>}
                              </div>
                            }
                          >
                            <div
                              style={{
                                position: "absolute",
                                left: left + 2,
                                width,
                                top: 5 + b.lane * 28,
                                height: 20,
                                borderRadius: 5,
                                background: st.bg,
                                color: st.fg,
                                boxShadow: `inset 0 0 0 1px ${st.border}`,
                                fontSize: 11,
                                fontWeight: 400,
                                lineHeight: "20px",
                                padding: "0 7px",
                                overflow: "hidden",
                                whiteSpace: "nowrap",
                                textOverflow: "ellipsis",
                                cursor: "pointer",
                                ...(b.overdue
                                  ? {
                                      backgroundImage:
                                        "repeating-linear-gradient(135deg, transparent 0 4px, rgb(239 68 68 / 14%) 4px 8px)",
                                    }
                                  : {}),
                              }}
                            >
                              {b.clampedLeft ? "‹ " : ""}
                              {b.task.name}
                            </div>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Spin>

      <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-3)" }}>
        提示：禅道任务普遍缺少「预计开始/截止」，未填日期的任务计入「未排」——建议团队规范：任务必须填截止日期。
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App as AntdApp, Button, DatePicker, Select, Spin, Table, Tag, Tooltip } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { api, projectColor, type TaskDto } from "@/lib/api";
import { useUser } from "@/lib/user";

const DAY_W = 38;
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
        const startRaw = hasStart ? dayjs(t.estStarted) : dayjs(Math.max(dayjs(t.deadline).diff(dayjs(), "day") > 0 ? dayjs(t.deadline).subtract(2, "day").valueOf() : dayjs().valueOf()));
        const endRaw = hasDeadline ? dayjs(t.deadline) : startRaw.add(1, "day");
        if (endRaw.isBefore(from, "day") || startRaw.isAfter(to, "day")) continue;
        const start = startRaw.isBefore(from, "day") ? from : startRaw;
        const end = endRaw.isAfter(to, "day") ? to : endRaw;
        let lane = laneEnds.findIndex((e) => e < t.estStarted || e < start.format("YYYY-MM-DD"));
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
      <div>项目：{b.task.projectName} · {b.task.executionName}</div>
      <div>状态：{b.task.status} · P{b.task.pri} · 剩余 {b.task.left}h</div>
      <div>
        排期：{b.task.estStarted || "未填"} → {b.task.deadline || "未填"}
        {b.clampedLeft ? "（早于视图起点）" : ""}
        {b.clampedRight ? "（晚于视图终点）" : ""}
      </div>
      {b.overdue && <div style={{ color: "#ff4d4f" }}>⚠ 已逾期</div>}
    </div>
  );

  return (
    <div style={{ padding: 16 }}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <DatePicker.RangePicker value={range} allowClear={false} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
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
        <span className="text-sm text-gray-500">
          {shown.length} 人 · {shown.reduce((a, p) => a + p.bars.length, 0)} 条排期
        </span>
        <div className="flex-1" />
        <Button onClick={reload}>刷新</Button>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="按人员查看任务排期与空档：条形 = 任务排期（颜色为项目），红框 = 已逾期；「预计空闲」= 最后一个未来截止日的次日。默认只显示进行中/待开始/暂停的任务。"
      />

      <Spin spinning={loading}>
        <Table<PersonPlan>
          size="small"
          rowKey="account"
          style={{ marginBottom: 12 }}
          pagination={false}
          dataSource={shown}
          columns={[
            { title: "成员", dataIndex: "realname", width: 100 },
            {
              title: "参与项目",
              dataIndex: "projects",
              render: (ps: string[]) => (
                <>
                  {ps.map((p) => (
                    <Tag key={p} color={projectColor(p)} style={{ margin: 2 }}>
                      {p}
                    </Tag>
                  ))}
                </>
              ),
            },
            { title: "活跃任务", dataIndex: "activeCount", width: 90 },
            {
              title: "未排期",
              dataIndex: "unscheduled",
              width: 80,
              render: (v: number) => (v > 0 ? <Tag color="orange">{v}</Tag> : "-"),
            },
            { title: "最近截止", dataIndex: "latestDeadline", width: 110 },
            {
              title: "预计空闲",
              dataIndex: "freeFrom",
              width: 100,
              render: (v: string, r: PersonPlan) => (
                <Tag color={r.freeSoon ? "green" : "default"}>{v}</Tag>
              ),
            },
          ]}
        />

        <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 200px)" }}>
          <div style={{ minWidth: gridW + 230 }}>
            {/* 日期标尺 */}
            <div className="flex">
              <div
                className="tl-sticky-name"
                style={{ width: 220, minWidth: 220, height: 36, fontWeight: 600, background: "#fafafa" }}
              >
                成员 / 日期
              </div>
              <div style={{ display: "flex" }}>
                {days.map((d) => (
                  <div
                    key={d.format("YYYY-MM-DD")}
                    style={{
                      width: DAY_W,
                      height: 36,
                      flexShrink: 0,
                      textAlign: "center",
                      fontSize: 11,
                      lineHeight: "14px",
                      paddingTop: 4,
                      background: [0, 6].includes(d.day())
                        ? "#f5f5f5"
                        : d.isSame(dayjs(), "day")
                          ? "#e6f4ff"
                          : "#fafafa",
                      color: d.isSame(dayjs(), "day") ? "#1677ff" : "#666",
                      fontWeight: d.isSame(dayjs(), "day") ? 700 : 400,
                      borderBottom: "1px solid #f0f0f0",
                    }}
                  >
                    <div>{d.format("M/D")}</div>
                    <div style={{ color: "#bbb" }}>{"日一二三四五六"[d.day()]}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* 人员行 */}
            {shown.map((p) => {
              const lanes = Math.max(1, ...p.bars.map((b) => b.lane + 1));
              const rowH = lanes * 32 + 10;
              return (
                <div key={p.account} className="flex">
                  <div
                    className="tl-sticky-name"
                    style={{ width: 220, minWidth: 220, height: rowH, justifyContent: "space-between" }}
                  >
                    <span style={{ fontWeight: 600 }}>{p.realname}</span>
                    <Tag color={p.freeSoon ? "green" : "default"} style={{ marginRight: 0 }}>
                      {p.freeFrom} 起
                    </Tag>
                  </div>
                  <div style={{ position: "relative", width: gridW, height: rowH, flexShrink: 0 }}>
                    {/* 网格线 + 周末底色 */}
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
                          borderRight: "1px solid #f5f5f5",
                        }}
                      />
                    ))}
                    {/* 今日线 */}
                    {todayIdx >= 0 && (
                      <div
                        style={{
                          position: "absolute",
                          left: todayIdx * DAY_W + DAY_W / 2,
                          top: 0,
                          width: 2,
                          height: rowH,
                          background: "#ff4d4f",
                          opacity: 0.6,
                          zIndex: 1,
                        }}
                      />
                    )}
                    {/* 任务条 */}
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
                              top: 5 + b.lane * 32,
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
            {shown.length === 0 && !loading && (
              <div className="py-16 text-center text-gray-400">范围内没有进行中的任务排期</div>
            )}
          </div>
        </div>
      </Spin>
    </div>
  );
}

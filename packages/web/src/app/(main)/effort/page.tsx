"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  DatePicker,
  Input,
  InputNumber,
  Table,
  Tabs,
  Tag,
  Progress,
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

interface RowForm {
  consumed: number;
  left: number;
  work: string;
}

function mondayOf(d: Dayjs): string {
  const day = d.day() === 0 ? 7 : d.day();
  return d.subtract(day - 1, "day").format("YYYY-MM-DD");
}

export default function EffortPage() {
  const { message } = AntdApp.useApp();
  const user = useUser();
  const [date, setDate] = useState<Dayjs>(dayjs());
  const [rows, setRows] = useState<TaskDto[]>([]);
  const [form, setForm] = useState<Record<number, RowForm>>({});
  const [results, setResults] = useState<Record<number, boolean | string>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pwdRequired, setPwdRequired] = useState(false);
  const [mine, setMine] = useState<MineEffort | null>(null);
  const [team, setTeam] = useState<TeamEffort | null>(null);
  const [summary, setSummary] = useState<SummaryDto | null>(null);

  const weekStart = mondayOf(dayjs());
  const todayStr = dayjs().format("YYYY-MM-DD");

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const d = date.format("YYYY-MM-DD");
      const jobs: Promise<unknown>[] = [
        api<{ tasks: TaskDto[] }>("/api/effort/tasks").then((r) => {
          setRows(r.tasks);
          setForm((prev) => {
            const next: Record<number, RowForm> = {};
            for (const t of r.tasks) {
              next[t.id] = prev[t.id] ?? { consumed: 0, left: t.left, work: "" };
              next[t.id].left = t.left;
            }
            return next;
          });
        }),
        api<MineEffort>(`/api/effort/mine?from=${weekStart}&to=${todayStr}`).then(setMine),
        api<SummaryDto>("/api/effort/summary").then(setSummary),
      ];
      if (user.lead) {
        jobs.push(
          api<TeamEffort>(`/api/effort/team?from=${weekStart}&to=${todayStr}`).then(setTeam),
        );
      }
      await Promise.all(jobs);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user, date, weekStart, todayStr, message]);

  useEffect(() => {
    reload();
  }, [reload]);

  const total =
    Math.round(rows.reduce((a, r) => a + (form[r.id]?.consumed ?? 0), 0) * 100) / 100;

  async function submit() {
    const entries = rows
      .filter((r) => (form[r.id]?.consumed ?? 0) > 0)
      .map((r) => ({
        taskId: r.id,
        consumed: form[r.id].consumed,
        left: form[r.id].left,
        work: form[r.id].work,
      }));
    if (entries.length === 0) return;
    setSubmitting(true);
    setResults({});
    try {
      const resp = await api<{ results: Array<{ taskId: number; ok: boolean; error?: string }> }>(
        "/api/effort/submit",
        { method: "POST", body: { date: date.format("YYYY-MM-DD"), entries } },
      );
      const next: Record<number, boolean | string> = {};
      for (const r of resp.results) next[r.taskId] = r.ok ? true : r.error ?? "失败";
      setResults(next);
      const okCount = resp.results.filter((r) => r.ok).length;
      if (okCount > 0) {
        message.success(`已登记 ${okCount} 条工时到禅道`);
        // 提交成功说明网页会话已恢复，刷新顶部横幅状态
        window.dispatchEvent(new CustomEvent("ztp:user-updated"));
      }
      await reload();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "PASSWORD_CHANGE_REQUIRED") setPwdRequired(true);
      message.error(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const fillColumns = [
    { title: "项目", dataIndex: "projectName", width: 130, ellipsis: true },
    { title: "执行", dataIndex: "executionName", width: 120, ellipsis: true },
    { title: "任务", dataIndex: "name", ellipsis: true },
    { title: "优先级", dataIndex: "pri", width: 70, render: (p: number) => `P${p}` },
    { title: "剩余(h)", dataIndex: "left", width: 80 },
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
          onChange={(v) =>
            setForm((f) => ({ ...f, [r.id]: { ...f[r.id], consumed: v ?? 0 } }))
          }
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
      width: 180,
      render: (_: unknown, r: TaskDto) => (
        <Input
          size="small"
          placeholder="选填"
          value={form[r.id]?.work ?? ""}
          onChange={(e) =>
            setForm((f) => ({ ...f, [r.id]: { ...f[r.id], work: e.target.value } }))
          }
        />
      ),
    },
    {
      title: "结果",
      width: 90,
      render: (_: unknown, r: TaskDto) =>
        results[r.id] === true ? (
          <Tag color="success">已记入</Tag>
        ) : typeof results[r.id] === "string" ? (
          <Tag color="error">{results[r.id]}</Tag>
        ) : null,
    },
  ];

  const logColumns = [
    { title: "日期", dataIndex: "date", width: 100 },
    { title: "项目", dataIndex: "projectName", ellipsis: true },
    { title: "任务", dataIndex: "taskName", ellipsis: true },
    { title: "工时(h)", dataIndex: "consumed", width: 80 },
    { title: "内容", dataIndex: "work", ellipsis: true },
  ];

  return (
    <div style={{ padding: 16 }}>
      {pwdRequired && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <>
              禅道要求先修改密码，无法记录工时。
              <a
                href={(user?.ztUrl ?? "") + "/index.php?m=my&f=changePassword"}
                target="_blank"
                rel="noreferrer"
              >
                {" "}
                去修改密码
              </a>
            </>
          }
        />
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <DatePicker
          value={date}
          onChange={(d) => d && setDate(d)}
          allowClear={false}
          style={{ width: 150 }}
        />
        <span className="text-sm text-gray-400">
          跨项目任务一屏填报，一次提交写入禅道
        </span>
        <div className="flex-1" />
        <Button onClick={reload}>刷新</Button>
      </div>

      <Table<TaskDto>
        size="small"
        bordered
        rowKey="id"
        loading={loading}
        columns={fillColumns}
        dataSource={rows}
        pagination={false}
        scroll={{ y: "calc(100vh - 420px)" }}
        locale={{ emptyText: "没有指派给你的进行中/待开始任务" }}
      />

      <div className="my-3 flex items-center gap-4">
        <span>
          当日合计：<b style={{ fontSize: 17 }}>{total}</b> 小时
        </span>
        <Button type="primary" loading={submitting} disabled={total <= 0} onClick={submit}>
          提交到禅道
        </Button>
        <span className="text-xs text-gray-400">提交即写入禅道任务工时，可在任务详情核对</span>
      </div>

      <Tabs
        items={[
          {
            key: "mine",
            label: "本周记录",
            children: (
              <>
                <div className="flex flex-wrap gap-6">
                  <Table<Bucket>
                    size="small"
                    rowKey="key"
                    columns={[
                      { title: "日期", dataIndex: "key", width: 120 },
                      { title: "工时(h)", dataIndex: "total", width: 100 },
                    ]}
                    dataSource={mine?.byDate ?? []}
                    pagination={false}
                  />
                  <Table<Bucket>
                    size="small"
                    rowKey="key"
                    columns={[
                      { title: "项目", dataIndex: "key", ellipsis: true },
                      { title: "本周工时(h)", dataIndex: "total", width: 110 },
                    ]}
                    dataSource={mine?.byProject ?? []}
                    pagination={false}
                  />
                </div>
                <div className="mt-2 text-xs text-gray-400">
                  本周合计 {mine?.total ?? 0}h（当前展示的是通过本工具提交的记录；接入禅道数据库后展示全量工时）
                </div>
                <Table<LogItem>
                  style={{ marginTop: 8 }}
                  size="small"
                  rowKey={(r) => `${r.taskId}-${r.submittedAt}`}
                  columns={logColumns}
                  dataSource={mine?.items ?? []}
                  pagination={{ pageSize: 8, hideOnSinglePage: true }}
                />
              </>
            ),
          },
          ...(user?.lead
            ? [
                {
                  key: "team",
                  label: "团队记录",
                  children: (
                    <>
                      <Table<{ account: string; realname: string; total: number }>
                        size="small"
                        bordered
                        rowKey="account"
                        columns={[
                          { title: "成员", dataIndex: "realname", width: 140 },
                          { title: "本周工时(h)", dataIndex: "total", width: 120 },
                          {
                            title: "占比",
                            key: "pct",
                            render: (_: unknown, r) => (
                              <Progress
                                size="small"
                                percent={
                                  (team?.total ?? 0) > 0
                                    ? Math.round((r.total / (team?.total ?? 1)) * 100)
                                    : 0
                                }
                              />
                            ),
                          },
                        ]}
                        dataSource={team?.byAccount ?? []}
                        pagination={false}
                      />
                      <div className="mt-2 text-xs text-gray-400">{team?.meta ?? ""}</div>
                    </>
                  ),
                },
              ]
            : []),
          {
            key: "project",
            label: "按项目累计",
            children: (
              <Table<ProjectAgg>
                size="small"
                bordered
                rowKey="projectId"
                columns={[
                  { title: "项目", dataIndex: "projectName", ellipsis: true },
                  { title: "任务数", dataIndex: "taskCount", width: 90 },
                  { title: "预计(h)", dataIndex: "estimate", width: 100 },
                  { title: "已消耗(h)", dataIndex: "consumed", width: 100 },
                  { title: "剩余(h)", dataIndex: "left", width: 100 },
                ]}
                dataSource={summary?.byProject ?? []}
                pagination={false}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

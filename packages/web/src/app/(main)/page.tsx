"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  Checkbox,
  Col,
  Empty,
  Input,
  Progress,
  Row,
  Segmented,
  Select,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
} from "antd";
import {
  api,
  PROJECT_STATUS_LABEL,
  type MineEffort,
  type OverviewDto,
  type SummaryDto,
} from "@/lib/api";
import { useUser } from "@/lib/user";

const FAV_KEY = "ztp:favs";

interface PersonRow {
  account: string;
  realname: string;
  estimate: number;
  consumed: number;
  left: number;
  taskCount: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const user = useUser();
  const [ov, setOv] = useState<OverviewDto | null>(null);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [mine, setMine] = useState<MineEffort | null>(null);
  const [loading, setLoading] = useState(true);
  const [kw, setKw] = useState("");
  const [programId, setProgramId] = useState<number | undefined>();
  const [showFinished, setShowFinished] = useState(false);
  const [onlyFav, setOnlyFav] = useState(false);
  const [favs, setFavs] = useState<Set<number>>(new Set());

  useEffect(() => {
    setFavs(new Set<number>(JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]")));
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const jobs: Promise<unknown>[] = [
      api<OverviewDto>("/api/overview").then(setOv),
      api<MineEffort>("/api/effort/mine").then(setMine),
    ];
    if (user.lead) jobs.push(api<SummaryDto>("/api/effort/summary").then(setSummary));
    Promise.all(jobs).finally(() => setLoading(false));
  }, [user]);

  const projects = ov?.projects ?? [];

  const filtered = useMemo(() => {
    let list = projects;
    if (programId) list = list.filter((p) => p.programId === programId);
    if (kw) list = list.filter((p) => p.name.toLowerCase().includes(kw.toLowerCase()));
    if (!showFinished) list = list.filter((p) => !["closed", "done", "finish"].includes(p.status));
    if (onlyFav) list = list.filter((p) => favs.has(p.id));
    return [...list].sort(
      (a, b) => Number(favs.has(b.id)) - Number(favs.has(a.id)) || b.tasksTotal - a.tasksTotal,
    );
  }, [projects, programId, kw, showFinished, onlyFav, favs]);

  const stats = useMemo(() => {
    const active = projects.filter((p) => p.status === "doing");
    return {
      doingProjects: active.length,
      totalProjects: projects.length,
      activeTasks: projects.reduce(
        (a, p) => a + p.executions.filter((e) => e.status === "doing" || e.status === "wait").reduce((x, e) => x + e.tasksTotal, 0),
        0,
      ),
      delayed: projects.filter((p) => p.delayedExecutions > 0).length,
    };
  }, [projects]);

  function statusColor(s: string): string {
    if (s === "doing") return "success";
    if (s === "wait") return "warning";
    if (s === "closed" || s === "done") return "default";
    return "error";
  }

  function toggleFav(id: number) {
    const next = new Set(favs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFavs(next);
    localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
  }

  const personColumns = [
    { title: "成员", dataIndex: "realname", width: 130 },
    { title: "在办任务", dataIndex: "taskCount", width: 100 },
    { title: "预计(h)", dataIndex: "estimate", width: 100 },
    { title: "已消耗(h)", dataIndex: "consumed", width: 100 },
    { title: "剩余(h)", dataIndex: "left", width: 100 },
    {
      title: "负载（消耗/预计）",
      key: "load",
      render: (_: unknown, r: PersonRow) => (
        <Progress
          percent={r.estimate > 0 ? Math.round((r.consumed / r.estimate) * 100) : 0}
          size="small"
          strokeColor={r.estimate > 0 && r.consumed / r.estimate > 1 ? "#ff4d4f" : undefined}
        />
      ),
    },
  ];

  return (
    <div style={{ padding: 16 }}>
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="进行中项目" value={stats.doingProjects} suffix={`/ ${stats.totalProjects}`} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="活跃任务数" value={stats.activeTasks} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="延期项目"
              value={stats.delayed}
              valueStyle={stats.delayed > 0 ? { color: "#ff4d4f" } : undefined}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="我的本周工时(h)" value={mine?.total ?? 0} />
          </Card>
        </Col>
      </Row>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          allowClear
          placeholder="搜索项目"
          style={{ width: 200 }}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
        <Select
          allowClear
          placeholder="全部项目集"
          style={{ width: 180 }}
          value={programId}
          onChange={setProgramId}
          options={(ov?.programs ?? []).map((p) => ({ value: p.id, label: p.name }))}
        />
        <Segmented
          value={onlyFav ? "fav" : "all"}
          onChange={(v) => setOnlyFav(v === "fav")}
          options={[
            { value: "all", label: "全部" },
            { value: "fav", label: "★ 收藏" },
          ]}
        />
        <Checkbox checked={showFinished} onChange={(e) => setShowFinished(e.target.checked)}>
          显示已结束
        </Checkbox>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Spin size="large" />
        </div>
      ) : filtered.length ? (
        <Row gutter={[12, 12]}>
          {filtered.map((p) => (
            <Col key={p.id} xs={24} sm={12} lg={8} xxl={6}>
              <Card
                size="small"
                hoverable
                onClick={() => router.push(`/board?project=${p.id}`)}
                title={
                  <div className="flex items-center gap-2">
                    <span
                      className="cursor-pointer text-[16px]"
                      style={{ color: favs.has(p.id) ? "#fadb14" : "#d9d9d9" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFav(p.id);
                      }}
                    >
                      ★
                    </span>
                    <span className="flex-1 truncate">{p.name}</span>
                    <Tag color={statusColor(p.status)}>{PROJECT_STATUS_LABEL[p.status] ?? p.status}</Tag>
                  </div>
                }
              >
                <Progress percent={Math.min(Math.round(p.progress), 100)} size="small" />
                <div className="mt-2 flex flex-wrap gap-1">
                  <Tag>任务 {p.tasksTotal}</Tag>
                  <Tag>执行 {p.executions.length}</Tag>
                  {p.doingExecutions > 0 && <Tag color="green">进行中 {p.doingExecutions}</Tag>}
                  {p.delayedExecutions > 0 && (
                    <Tooltip title={`${p.delayedExecutions} 个执行延期`}>
                      <Tag color="red">延期 {p.delayedExecutions}</Tag>
                    </Tooltip>
                  )}
                </div>
                <div className="mt-2 text-xs text-gray-400">
                  {p.begin} ~ {p.end}
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      ) : (
        <Empty description="没有符合条件的项目" />
      )}

      {user?.lead && summary && (
        <Card size="small" title="团队全貌（成员任务与工时累计）" style={{ marginTop: 20 }}>
          <Table<PersonRow>
            size="small"
            rowKey="account"
            columns={personColumns}
            dataSource={summary.byPerson}
            pagination={false}
          />
        </Card>
      )}
    </div>
  );
}

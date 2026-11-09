"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Empty, Progress, Segmented, Skeleton, Tooltip } from "antd";
import { api, type MineEffort, type OverviewDto, type SummaryDto, type TaskDto } from "@/lib/api";
import { useUser } from "@/lib/user";
import { Avatar, ProjectDot, StatusPill, isOverdue, todayStr } from "@/components/ui";

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
  const [mineEffort, setMineEffort] = useState<MineEffort | null>(null);
  const [myTasks, setMyTasks] = useState<TaskDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<string>("active");
  const [favs, setFavs] = useState<Set<number>>(new Set());

  useEffect(() => {
    setFavs(new Set<number>(JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]")));
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const today = todayStr();
    Promise.all([
      api<OverviewDto>("/api/overview").then(setOv),
      api<{ tasks: TaskDto[] }>("/api/tasks?mine=1&status=wait,doing,pause&limit=500").then((d) => setMyTasks(d.tasks)),
      api<MineEffort>(`/api/effort/mine?from=${today}&to=${today}`).then(setMineEffort),
      ...(user.lead ? [api<SummaryDto>("/api/effort/summary").then(setSummary)] : []),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user]);

  const projects = ov?.projects ?? [];

  const filtered = useMemo(() => {
    let list = projects;
    if (scope === "active") list = list.filter((p) => !["closed", "done", "finish"].includes(p.status));
    if (scope === "fav") list = list.filter((p) => favs.has(p.id));
    return [...list].sort(
      (a, b) => Number(favs.has(b.id)) - Number(favs.has(a.id)) || b.tasksTotal - a.tasksTotal,
    );
  }, [projects, scope, favs]);

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

  const dueSoon = useMemo(
    () =>
      myTasks
        .filter((t) => t.deadline && t.deadline >= todayStr() && t.deadline <= addDays(3))
        .sort((a, b) => a.deadline.localeCompare(b.deadline))
        .slice(0, 6),
    [myTasks],
  );

  function toggleFav(id: number) {
    const next = new Set(favs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFavs(next);
    localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
  }

  const todayHours = mineEffort?.total ?? 0;
  const dayGoal = 8;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">工作台</div>
          <div className="page-desc">项目全局进展与团队负载一览</div>
        </div>
        <Segmented
          value={scope}
          onChange={(v) => setScope(v as string)}
          options={[
            { value: "active", label: "进行中" },
            { value: "all", label: "全部" },
            { value: "fav", label: "★ 收藏" },
          ]}
        />
      </div>

      {/* KPI */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        {[
          { label: "进行中项目", value: stats.doingProjects, unit: `/ ${stats.totalProjects}`, color: undefined },
          { label: "活跃任务", value: stats.activeTasks, unit: "条", color: undefined },
          { label: "延期项目", value: stats.delayed, unit: "个", color: stats.delayed > 0 ? "var(--red)" : undefined },
          { label: "今日已记工时", value: todayHours, unit: "h", color: undefined },
        ].map((k) => (
          <div key={k.label} className="card kpi">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value" style={{ color: k.color }}>
              {loading ? <Skeleton.Node active style={{ width: 60, height: 24 }} /> : k.value}
              <span className="kpi-unit">{k.unit}</span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 16, alignItems: "start", marginTop: 16 }}>
        {/* 项目进展 */}
        <div>
          <div className="section-title" style={{ marginTop: 6 }}>
            <span>项目进展</span>
            <span style={{ fontSize: 12.5, fontWeight: 400, color: "var(--text-3)" }}>点击卡片查看任务</span>
          </div>
          {loading ? (
            <div className="card" style={{ padding: 40, textAlign: "center" }}><Skeleton active /></div>
          ) : filtered.length === 0 ? (
            <div className="card"><Empty style={{ padding: 30 }} description="暂无项目" /></div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 14 }}>
              {filtered.map((p) => (
                <div key={p.id} className="card card-hover proj-card" onClick={() => router.push(`/board?project=${p.id}`)}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      className={`fav-star${favs.has(p.id) ? " on" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFav(p.id);
                      }}
                    >
                      ★
                    </span>
                    <span className="proj-name" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                    </span>
                    <StatusPill status={p.status === "done" ? "done" : p.status === "closed" ? "closed" : p.status === "wait" ? "wait" : "doing"} />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <Progress percent={Math.min(Math.round(p.progress), 100)} size={["100%", 6]} strokeColor="var(--brand-500)" showInfo={false} />
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontSize: 11.5, color: "var(--text-3)" }}>
                      <span>{p.begin} ~ {p.end}</span>
                      <b style={{ color: "var(--text-2)" }}>{Math.round(p.progress)}%</b>
                    </div>
                  </div>
                  <div className="proj-meta">
                    <span>任务 {p.tasksTotal}</span>
                    <span>执行 {p.executions.length}</span>
                    {p.doingExecutions > 0 && <span style={{ color: "var(--green)" }}>进行 {p.doingExecutions}</span>}
                    {p.delayedExecutions > 0 && <span style={{ color: "var(--red)", fontWeight: 600 }}>延期 {p.delayedExecutions}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 团队负载（负责人） */}
          {user?.lead && summary && (
            <>
              <div className="section-title">
                <span>团队负载</span>
                <span style={{ fontSize: 12.5, fontWeight: 400, color: "var(--text-3)" }}>按剩余工时排序</span>
              </div>
              <div className="card" style={{ padding: "6px 18px 12px" }}>
                {summary.byPerson.slice(0, 10).map((r: PersonRow) => {
                  const pct = r.estimate > 0 ? Math.min(Math.round((r.left / r.estimate) * 100), 100) : 0;
                  return (
                    <div key={r.account} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: "1px solid #f4f4f8" }}>
                      <Avatar name={r.realname} size={28} />
                      <span style={{ width: 90, fontSize: 13, fontWeight: 500 }}>{r.realname}</span>
                      <span style={{ fontSize: 12, color: "var(--text-3)", width: 70 }}>{r.taskCount} 任务</span>
                      <div style={{ flex: 1 }}>
                        <Progress percent={pct} size={["100%", 6]} showInfo={false} strokeColor={pct > 70 ? "#d97706" : "var(--brand-500)"} />
                      </div>
                      <span style={{ width: 130, textAlign: "right", fontSize: 12, color: "var(--text-2)" }}>
                        余 <b style={{ color: "var(--text-1)" }}>{r.left}</b> / 耗 {r.consumed}h
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* 右栏：我的今日 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, position: "sticky", top: 0 }}>
          <div className="card" style={{ padding: "18px 20px" }}>
            <div className="kpi-label">我的今日工时</div>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12 }}>
              <Progress
                type="circle"
                size={72}
                percent={Math.min(Math.round((todayHours / dayGoal) * 100), 100)}
                strokeColor="var(--brand-500)"
                format={() => (
                  <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-1)" }}>
                    {todayHours}<span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 500 }}>/{dayGoal}h</span>
                  </span>
                )}
              />
              <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.8 }}>
                {todayHours >= dayGoal ? "今日目标已达成 🎉" : todayHours > 0 ? `还差 ${(dayGoal - todayHours).toFixed(1)}h 到达 8h 目标` : "今天还没登记工时"}
                <div>
                  <a onClick={() => router.push("/effort")} style={{ fontSize: 12.5, fontWeight: 600 }}>
                    去填报 →
                  </a>
                </div>
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: "16px 18px" }}>
            <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 10 }}>
              我的三日内到期
              <span style={{ float: "right", fontSize: 12, fontWeight: 400, color: "var(--text-3)" }}>{dueSoon.length} 项</span>
            </div>
            {dueSoon.length === 0 ? (
              <div className="empty-hint" style={{ padding: "18px 0" }}>近期没有到期任务</div>
            ) : (
              dueSoon.map((t) => (
                <Tooltip key={t.id} title={`${t.projectName} · ${t.executionName}`}>
                  <div
                    onClick={() => router.push(`/board?q=${encodeURIComponent(t.name.slice(0, 40))}`)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", cursor: "pointer", borderBottom: "1px solid #f4f4f8" }}
                  >
                    <ProjectDot name={t.projectName} />
                    <span style={{ flex: 1, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                    <span style={{ fontSize: 11.5, color: isOverdue(t) ? "var(--red)" : "var(--text-3)", flexShrink: 0 }}>{t.deadline.slice(5)}</span>
                  </div>
                </Tooltip>
              ))
            )}
            <div style={{ marginTop: 10 }}>
              <a onClick={() => router.push("/board?mine=1")} style={{ fontSize: 12.5, fontWeight: 600 }}>
                我的全部任务（{myTasks.length}） →
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function addDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

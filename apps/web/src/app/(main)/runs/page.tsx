"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Spin,
  Tag,
  InputNumber,
} from "antd";
import { api } from "@/lib/api";
import { useUser } from "@/lib/user";

interface AgentLite {
  id: number
  name: string
  role: string
  status: string
  ownerAccount: string
}

interface RunStep {
  seq: number
  kind: string
  title: string
  detail?: unknown
  createdAt: number
}

interface Run {
  id: string
  agentName: string
  goal: string
  status: "running" | "waiting_approval" | "done" | "failed" | "stopped"
  steps: number
  maxSteps: number
  error?: string | null
  summary?: string | null
  createdAt: number
  stepsList: RunStep[]
}

interface Draft {
  id: string
  source: string
  actor: string
  runId: string | null
  actions: Array<Record<string, unknown> & { type: string }>
  checks: Array<{ index: number; ok: boolean; message: string }>
  createdAt: number
}

const KIND_STYLE: Record<string, { label: string; color: string }> = {
  start: { label: "开始", color: "var(--brand-500)" },
  thought: { label: "思考", color: "var(--ink-2)" },
  tool: { label: "工具", color: "#7749c8" },
  result: { label: "结果", color: "var(--ink-3)" },
  decision: { label: "待决策", color: "var(--warn)" },
  draft: { label: "草案", color: "#0e7c6b" },
  done: { label: "完成", color: "var(--ok)" },
  stop: { label: "停止", color: "var(--warn)" },
  error: { label: "错误", color: "var(--bad)" },
  human: { label: "人类", color: "var(--bad)" },
  executed: { label: "已执行", color: "var(--ok)" },
};

const STATUS_TEXT: Record<string, { text: string; color: string }> = {
  running: { text: "运行中", color: "var(--brand-500)" },
  waiting_approval: { text: "等待决策", color: "var(--warn)" },
  done: { text: "已完成", color: "var(--ok)" },
  failed: { text: "失败", color: "var(--bad)" },
  stopped: { text: "已停止", color: "var(--ink-2)" },
};

export default function RunsPage() {
  const { message } = AntdApp.useApp();
  const user = useUser();
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [runs, setRuns] = useState<Array<Omit<Run, "stepsList">>>([]);
  const [current, setCurrent] = useState<Run | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [agentId, setAgentId] = useState<number>();
  const [goal, setGoal] = useState("");
  const [maxSteps, setMaxSteps] = useState(8);
  const [starting, setStarting] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [health, setHealth] = useState<{ llmConfigured: boolean; model: string | null } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const [a, h] = await Promise.all([
        api<{ agents: AgentLite[] }>("/api/admin/agents"),
        api<{ llmConfigured: boolean; model: string | null }>("/api/agent/health"),
      ]);
      setAgents(a.agents);
      setHealth(h);
      if (!agentId && a.agents[0]) setAgentId(a.agents[0].id);
    } catch {
      /* 非负责人进入时不显示 */
    }
  }, [agentId]);

  const loadRuns = useCallback(async () => {
    try {
      const [r, d] = await Promise.all([
        api<{ runs: Array<Omit<Run, "stepsList">> }>("/api/runs"),
        api<{ drafts: Draft[] }>("/api/drafts"),
      ]);
      setRuns(r.runs);
      setDrafts(d.drafts);
      if (current) {
        const fresh = await api<Run>(`/api/runs/${current.id}`);
        setCurrent(fresh);
      }
    } catch {
      /* 忽略轮询错误 */
    }
  }, [current]);

  useEffect(() => {
    loadAgents();
    loadRuns();
    timer.current = setInterval(loadRuns, 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    if (!agentId || !goal.trim()) {
      message.warning("请选择 Agent 并填写目标");
      return;
    }
    setStarting(true);
    try {
      const r = await api<{ runId: string }>("/api/runs", {
        method: "POST",
        body: { agentId, goal, maxSteps },
      });
      message.success("已启动");
      setGoal("");
      await loadRuns();
      const detail = await api<Run>(`/api/runs/${r.runId}`);
      setCurrent(detail);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function openRun(id: string) {
    try {
      setCurrent(await api<Run>(`/api/runs/${id}`));
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function submitAnswer() {
    if (!current) return;
    try {
      await api(`/api/runs/${current.id}/answer`, { method: "POST", body: { answer } });
      message.success("已回答，继续运行");
      setAnswerOpen(false);
      setAnswer("");
      await loadRuns();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function executeDraft(id: string) {
    try {
      const r = await api<{ summary: string }>(`/api/drafts/${id}/execute`, { method: "POST" });
      message.success(r.summary);
      await loadRuns();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  const decisionStep = current?.stepsList.find((s) => s.kind === "decision");
  const decisionOptions = (decisionStep?.detail as { options?: string[] } | undefined)?.options ?? [];
  const runDrafts = drafts.filter((d) => d.runId === current?.id);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Agent 运行</div>
          <div className="page-desc">给 Agent 一个目标，它自主循环取上下文、调工具、出草案；关键处停下等你决策</div>
        </div>
      </div>

      {health && !health.llmConfigured && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="未配置 LLM，Agent 无法运行"
          description="在服务端 .env 配置 TANDEM_LLM_BASE_URL / TANDEM_LLM_API_KEY / TANDEM_LLM_MODEL（OpenAI 兼容端点）后重启 API"
        />
      )}

      {/* 发起 */}
      <div className="card" style={{ padding: "16px 18px", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Select
            style={{ width: 200 }}
            placeholder="选择 Agent"
            value={agentId}
            onChange={setAgentId}
            options={agents.map((a) => ({ value: a.id, label: `${a.name} · ${a.role}` }))}
          />
          <Input
            style={{ flex: 1, minWidth: 280 }}
            placeholder="目标，例如：把登录页改版拆成任务建到 SCRM2.0 当前迭代，指派给张三，周五前"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onPressEnter={start}
          />
          <InputNumber min={1} max={20} value={maxSteps} onChange={(v) => setMaxSteps(v ?? 8)} style={{ width: 90 }} addonAfter="步" />
          <Button type="primary" loading={starting} onClick={start}>
            运行
          </Button>
        </div>
        {agents.length === 0 && (
          <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 8 }}>
            还没有 Agent，先去 Agents 页创建一个
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0,1fr)", gap: 14, alignItems: "start" }}>
        {/* 运行列表 */}
        <div className="card" style={{ padding: "10px 6px" }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-2)", padding: "4px 10px 8px" }}>
            最近运行
          </div>
          {runs.length === 0 && <div className="empty-hint">暂无运行</div>}
          {runs.map((r) => {
            const st = STATUS_TEXT[r.status] ?? STATUS_TEXT.running;
            const active = current?.id === r.id;
            return (
              <div
                key={r.id}
                onClick={() => openRun(r.id)}
                style={{
                  padding: "9px 10px",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: active ? "var(--brand-50)" : undefined,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.agentName}
                  </span>
                  <span style={{ fontSize: 11, color: st.color }}>{st.text}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.goal}
                </div>
              </div>
            );
          })}
        </div>

        {/* 运行详情 */}
        <div>
          {!current ? (
            <div className="card"><Empty description="选择左侧运行查看步骤，或在上方发起新目标" style={{ padding: 40 }} /></div>
          ) : (
            <>
              <div className="card" style={{ padding: "16px 18px", marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{current.agentName}</span>
                  <Tag style={{ borderRadius: 6 }}>
                    {STATUS_TEXT[current.status]?.text ?? current.status}
                  </Tag>
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    步 {current.steps}/{current.maxSteps}
                  </span>
                  {current.status === "waiting_approval" && (
                    <Button size="small" type="primary" onClick={() => setAnswerOpen(true)}>
                      回答并继续
                    </Button>
                  )}
                </div>
                <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 8 }}>目标：{current.goal}</div>
                {current.summary && (
                  <div style={{ fontSize: 13, marginTop: 8, padding: "10px 12px", background: "var(--bg)", borderRadius: 8, lineHeight: 1.7 }}>
                    {current.summary}
                  </div>
                )}
                {current.error && (
                  <div style={{ fontSize: 12.5, color: "var(--bad)", marginTop: 8 }}>{current.error}</div>
                )}
              </div>

              {/* 待审批草案 */}
              {runDrafts.map((d) => (
                <div key={d.id} className="card" style={{ padding: "14px 18px", marginBottom: 14, borderColor: "var(--brand-500)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 500 }}>草案 {d.id}</span>
                    <Tag style={{ borderRadius: 6, background: "var(--brand-50)", color: "var(--brand-500)", borderColor: "transparent" }}>
                      {d.actions.length} 项待确认
                    </Tag>
                    <div style={{ flex: 1 }} />
                    <Button size="small" onClick={() => api(`/api/drafts/${d.id}/discard`, { method: "POST" }).then(loadRuns)}>
                      放弃
                    </Button>
                    <Button size="small" type="primary" onClick={() => executeDraft(d.id)}>
                      批准执行
                    </Button>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    {d.checks.map((c) => (
                      <div key={c.index} style={{ fontSize: 12.5, color: c.ok ? "var(--ink)" : "var(--bad)", padding: "3px 0" }}>
                        {c.ok ? "✓" : "✗"} {c.message}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* 步骤流 */}
              <div className="card" style={{ padding: "14px 18px" }}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>运行步骤</div>
                <Spin spinning={current.status === "running"}>
                  {current.stepsList.map((s) => {
                    const st = KIND_STYLE[s.kind] ?? { label: s.kind, color: "var(--ink-2)" };
                    return (
                      <div key={s.seq} style={{ display: "flex", gap: 10, padding: "6px 0", borderBottom: "0.5px solid var(--layer-2)" }}>
                        <span style={{ width: 46, flexShrink: 0, fontSize: 11, color: st.color, fontWeight: 500 }}>
                          {st.label}
                        </span>
                        <span style={{ fontSize: 12.5, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {s.title}
                        </span>
                      </div>
                    );
                  })}
                  {current.stepsList.length === 0 && <div className="empty-hint">尚无步骤</div>}
                </Spin>
              </div>
            </>
          )}
        </div>
      </div>

      <Modal
        open={answerOpen}
        title="Agent 需要你的决策"
        onCancel={() => setAnswerOpen(false)}
        onOk={submitAnswer}
        okText="提交并继续"
      >
        <div style={{ fontSize: 13, marginBottom: 10, lineHeight: 1.7 }}>{decisionStep?.title}</div>
        {decisionOptions.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            {decisionOptions.map((o) => (
              <Button key={o} size="small" onClick={() => setAnswer(o)}>
                {o}
              </Button>
            ))}
          </div>
        )}
        <Input.TextArea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="你的决定/补充说明" />
      </Modal>
    </div>
  );
}

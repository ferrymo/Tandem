"use client";

import { useCallback, useEffect, useState } from "react";
import {
  App as AntdApp,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Spin,
  Switch,
  Tag,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api } from "@/lib/api";
import { useUser } from "@/lib/user";

interface AgentProfile {
  id: number
  name: string
  role: string
  description?: string
  capabilities: string[]
  skills: string[]
  ragEnabled: boolean
  ragCollections: string[]
  ownerAccount: string
  llmBaseUrl?: string
  llmModel?: string
  status: "idle" | "busy" | "paused" | "error"
  createdAt: number
}

const ROLE_OPTIONS = [
  { value: "planner", label: "规划 · 拆解需求为任务" },
  { value: "executor", label: "执行 · 编码/写文档" },
  { value: "tester", label: "测试 · 验证与质量" },
  { value: "recorder", label: "记录 · 工时/周报" },
  { value: "watcher", label: "守望 · 监控异常上报" },
  { value: "custom", label: "自定义" },
];

const STATUS_LABEL: Record<AgentProfile["status"], { text: string; color: string }> = {
  idle: { text: "空闲", color: "var(--ink-2)" },
  busy: { text: "忙碌", color: "var(--brand-500)" },
  paused: { text: "已暂停", color: "var(--warn)" },
  error: { text: "异常", color: "var(--bad)" },
};

interface FormState {
  name: string
  role: string
  description: string
  capabilities: string[]
  skills: string[]
  ragEnabled: boolean
  llmModel: string
  ownerAccount: string
}

const EMPTY: FormState = {
  name: "",
  role: "custom",
  description: "",
  capabilities: [],
  skills: [],
  ragEnabled: false,
  llmModel: "",
  ownerAccount: "",
};

export default function AgentsPage() {
  const { message } = AntdApp.useApp();
  const user = useUser();
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ agent?: AgentProfile } | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setAgents((await api<{ agents: AgentProfile[] }>("/api/admin/agents")).agents);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (user?.lead) reload();
  }, [user, reload]);

  async function act(fn: () => Promise<unknown>, tip: string) {
    try {
      await fn();
      message.success(tip);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  if (!user?.lead) {
    return (
      <div className="page">
        <div className="page-header"><div><div className="page-title">Agents</div></div></div>
        <div className="card"><Empty description="Agent 管理仅负责人可见" style={{ padding: 40 }} /></div>
      </div>
    );
  }

  function openCreate() {
    setForm({ ...EMPTY, ownerAccount: user?.account ?? "" });
    setModal({});
  }
  function openEdit(a: AgentProfile) {
    setForm({
      name: a.name,
      role: a.role,
      description: a.description ?? "",
      capabilities: a.capabilities,
      skills: a.skills,
      ragEnabled: a.ragEnabled,
      llmModel: a.llmModel ?? "",
      ownerAccount: a.ownerAccount,
    });
    setModal({ agent: a });
  }

  function save() {
    if (!form.name.trim()) {
      message.warning("请填写 Agent 名称");
      return;
    }
    const body = {
      name: form.name,
      role: form.role,
      description: form.description || undefined,
      capabilities: form.capabilities,
      skills: form.skills,
      ragEnabled: form.ragEnabled,
      llmModel: form.llmModel || undefined,
      ownerAccount: form.ownerAccount,
    };
    act(
      () => (modal?.agent ? api(`/api/admin/agents/${modal.agent.id}`, { method: "PUT", body }) : api("/api/admin/agents", { method: "POST", body })),
      "已保存",
    );
    setModal(null);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Agents</div>
          <div className="page-desc">维护你的 AI Agent 团队——能力、skills 与挂靠人（权限上界）</div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建 Agent
        </Button>
      </div>

      <Spin spinning={loading}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: 14 }}>
          {agents.map((a) => {
            const st = STATUS_LABEL[a.status];
            return (
              <div key={a.id} className="card card-hover" style={{ padding: "16px 18px" }} onClick={() => openEdit(a)}>
                <div className="flex items-center gap-2">
                  <span
                    style={{
                      width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                      background: "var(--brand-50)", color: "var(--brand-500)",
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 15, fontWeight: 500,
                    }}
                  >
                    ✦
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 500, flex: 1 }}>{a.name}</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: st.color }}>
                    <span style={{ width: 6, height: 6, borderRadius: 3, background: "currentColor" }} />
                    {st.text}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 8, lineHeight: 1.6 }}>
                  {a.description || ROLE_OPTIONS.find((r) => r.value === a.role)?.label || a.role}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                  {a.capabilities.slice(0, 5).map((c) => (
                    <Tag key={c} style={{ borderRadius: 6 }}>{c}</Tag>
                  ))}
                  {a.skills.slice(0, 3).map((s) => (
                    <Tag key={s} style={{ borderRadius: 6, background: "var(--brand-50)", color: "var(--brand-500)", borderColor: "transparent" }}>
                      {s}
                    </Tag>
                  ))}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 10 }}>
                  挂靠 {a.ownerAccount} · {a.ragEnabled ? "RAG 已启用" : "RAG 未启用"}
                </div>
              </div>
            );
          })}
        </div>
        {agents.length === 0 && !loading && (
          <div className="card">
            <Empty description="还没有 Agent——建一个试试，比如「规划一号」" style={{ padding: 40 }} />
          </div>
        )}
      </Spin>

      <Modal
        open={modal !== null}
        title={modal?.agent ? `编辑 ${modal.agent.name}` : "新建 Agent"}
        onCancel={() => setModal(null)}
        onOk={save}
        okText="保存"
        width={520}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
          <Input placeholder="名称（如：规划一号）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Select value={form.role} onChange={(v) => setForm({ ...form, role: v })} options={ROLE_OPTIONS} />
          <Input.TextArea rows={2} placeholder="职责描述（Agent 的自我定位）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Select
            mode="tags"
            placeholder="能力标签（如：前端、Python、测试用例）"
            value={form.capabilities}
            onChange={(v) => setForm({ ...form, capabilities: v })}
          />
          <Select
            mode="tags"
            placeholder="配备 skills（如：zentao、代码评审、周报生成）"
            value={form.skills}
            onChange={(v) => setForm({ ...form, skills: v })}
          />
          <Input placeholder="模型（选填，如 glm-4.7；留空用系统默认）" value={form.llmModel} onChange={(e) => setForm({ ...form, llmModel: e.target.value })} />
          <div className="flex items-center gap-2">
            <Switch size="small" checked={form.ragEnabled} onChange={(v) => setForm({ ...form, ragEnabled: v })} />
            <span style={{ fontSize: 13, color: form.ragEnabled ? "var(--ink)" : "var(--ink-3)" }}>
              RAG 2.0 知识库（v2.2 提供，先占位）
            </span>
          </div>
        </div>
      </Modal>
    </div>
  );
}

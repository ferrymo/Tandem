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
  Tag,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api } from "@/lib/api";
import { useUser } from "@/lib/user";
import { Avatar } from "@/components/ui";

interface Member {
  id: number
  teamId: number
  kind: "human" | "agent"
  refId: string
  displayName: string
  role: string
  joinedAt: number
}

interface Team {
  id: number
  name: string
  description?: string
  members: Member[]
}

interface AgentLite {
  id: number
  name: string
  role: string
}

interface UserLite {
  account: string
  realname: string
}

export default function TeamsPage() {
  const { message } = AntdApp.useApp();
  const user = useUser();
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [teamModal, setTeamModal] = useState<{ team?: Team } | null>(null);
  const [tName, setTName] = useState("");
  const [tDesc, setTDesc] = useState("");
  const [memberModal, setMemberModal] = useState<{ teamId: number } | null>(null);
  const [mKind, setMKind] = useState<"human" | "agent">("human");
  const [mRef, setMRef] = useState<string>();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [t, u, a] = await Promise.all([
        api<{ teams: Team[] }>("/api/admin/teams"),
        api<UserLite[]>("/api/users"),
        api<{ agents: AgentLite[] }>("/api/admin/agents"),
      ]);
      setTeams(t.teams);
      setUsers(u);
      setAgents(a.agents);
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
        <div className="page-header"><div><div className="page-title">团队</div></div></div>
        <div className="card"><Empty description="团队管理仅负责人可见" style={{ padding: 40 }} /></div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">团队</div>
          <div className="page-desc">成员可以是人和 Agent——他们在这里是平等的协作者</div>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setTName("");
            setTDesc("");
            setTeamModal({});
          }}
        >
          新建团队
        </Button>
      </div>

      <Spin spinning={loading}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))", gap: 14 }}>
          {teams.map((t) => (
            <div key={t.id} className="card" style={{ padding: "16px 18px" }}>
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 14, fontWeight: 500, flex: 1 }}>{t.name}</span>
                <Button
                  type="text"
                  size="small"
                  onClick={() => {
                    setTName(t.name);
                    setTDesc(t.description ?? "");
                    setTeamModal({ team: t });
                  }}
                >
                  编辑
                </Button>
                <Button
                  type="text"
                  size="small"
                  danger
                  onClick={() =>
                    Modal.confirm({
                      title: `删除团队「${t.name}」？`,
                      okButtonProps: { danger: true },
                      onOk: () => act(() => api(`/api/admin/teams/${t.id}`, { method: "DELETE" }), "已删除"),
                    })
                  }
                >
                  删除
                </Button>
              </div>
              {t.description && (
                <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 4 }}>{t.description}</div>
              )}
              <div style={{ marginTop: 12 }}>
                {t.members.length === 0 && (
                  <div className="empty-hint" style={{ padding: "14px 0" }}>暂无成员</div>
                )}
                {t.members.map((m) => (
                  <div key={m.id} className="flex items-center gap-2" style={{ padding: "6px 0" }}>
                    {m.kind === "agent" ? (
                      <span
                        style={{
                          width: 26, height: 26, borderRadius: 7, flexShrink: 0,
                          background: "var(--layer-2)", color: "var(--brand-500)",
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          fontSize: 13, fontWeight: 500,
                        }}
                        title="AI Agent"
                      >
                        ✦
                      </span>
                    ) : (
                      <Avatar name={m.displayName} size={26} />
                    )}
                    <span style={{ fontSize: 13, fontWeight: 400 }}>{m.displayName}</span>
                    {m.kind === "agent" && <Tag style={{ borderRadius: 6 }}>Agent</Tag>}
                    <span style={{ fontSize: 12, color: "var(--ink-3)", flex: 1 }}>{m.role}</span>
                    <Button
                      type="text"
                      size="small"
                      danger
                      onClick={() => act(() => api(`/api/admin/members/${m.id}`, { method: "DELETE" }), "已移出")}
                    >
                      移出
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                size="small"
                style={{ marginTop: 8 }}
                onClick={() => {
                  setMKind("human");
                  setMRef(undefined);
                  setMemberModal({ teamId: t.id });
                }}
              >
                + 添加成员（人 / Agent）
              </Button>
            </div>
          ))}
        </div>
        {teams.length === 0 && !loading && (
          <div className="card"><Empty description="还没有团队，建一个把人和 Agent 编进来" style={{ padding: 40 }} /></div>
        )}
      </Spin>

      {/* 团队编辑 */}
      <Modal
        open={teamModal !== null}
        title={teamModal?.team ? "编辑团队" : "新建团队"}
        onCancel={() => setTeamModal(null)}
        onOk={() => {
          if (!teamModal) return;
          const body = { name: tName, description: tDesc };
          act(
            () =>
              teamModal.team
                ? api(`/api/admin/teams/${teamModal.team.id}`, { method: "PUT", body })
                : api("/api/admin/teams", { method: "POST", body }),
            "已保存",
          );
          setTeamModal(null);
        }}
        okText="保存"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Input placeholder="团队名称" value={tName} onChange={(e) => setTName(e.target.value)} autoFocus />
          <Input placeholder="描述（选填）" value={tDesc} onChange={(e) => setTDesc(e.target.value)} />
        </div>
      </Modal>

      {/* 添加成员 */}
      <Modal
        open={memberModal !== null}
        title="添加成员"
        onCancel={() => setMemberModal(null)}
        onOk={() => {
          if (!memberModal || !mRef) {
            message.warning("请选择成员");
            return;
          }
          const isAgent = mKind === "agent";
          const found: string | undefined = isAgent
            ? agents.find((a) => String(a.id) === mRef)?.name
            : users.find((u) => u.account === mRef)?.realname;
            act(
              () =>
                api(`/api/admin/teams/${memberModal.teamId}/members`, {
                  method: "POST",
                  body: {
                    kind: mKind,
                    refId: mRef,
                    displayName: found ?? mRef,
                  },
                }),
              "已添加",
            );
          setMemberModal(null);
        }}
        okText="添加"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Select
            value={mKind}
            onChange={(v) => {
              setMKind(v);
              setMRef(undefined);
            }}
            options={[
              { value: "human", label: "人（协作系统账号）" },
              { value: "agent", label: "AI Agent" },
            ]}
          />
          <Select
            showSearch
            optionFilterProp="label"
            placeholder={mKind === "human" ? "选择人员" : "选择 Agent（需先在 Agents 页创建）"}
            value={mRef}
            onChange={setMRef}
            options={
              mKind === "human"
                ? users.map((u) => ({ value: u.account, label: `${u.realname}（${u.account}）` }))
                : agents.map((a) => ({ value: String(a.id), label: `${a.name} · ${a.role}` }))
            }
          />
        </div>
      </Modal>
    </div>
  );
}

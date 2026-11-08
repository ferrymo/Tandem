"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  App as AntdApp,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Spin,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { AppstoreOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { api, type OverviewDto, type TaskDto } from "@/lib/api";
import { Avatar, ProjectDot, StatusPill, isOverdue, todayStr } from "@/components/ui";

const COLUMNS = [
  { key: "wait", label: "未开始" },
  { key: "doing", label: "进行中" },
  { key: "done", label: "已完成" },
  { key: "closed", label: "已关闭" },
  { key: "other", label: "其他" },
];

const PRI_COLOR: Record<number, string> = { 1: "#dc2626", 2: "#d97706", 3: "#5b5bd6", 4: "#a0a0b0" };

function BoardInner() {
  const { message } = AntdApp.useApp();
  const searchParams = useSearchParams();
  const [view, setView] = useState<string>("board");
  const [groups, setGroups] = useState<Record<string, TaskDto[]>>({});
  const [allTasks, setAllTasks] = useState<TaskDto[]>([]);
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([]);
  const [users, setUsers] = useState<Array<{ account: string; realname: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState<number | undefined>(Number(searchParams.get("project")) || undefined);
  const [assignedTo, setAssignedTo] = useState<string | undefined>();
  const [mine, setMine] = useState(searchParams.get("mine") === "1");
  const [kw, setKw] = useState(searchParams.get("q") ?? "");
  const [current, setCurrent] = useState<TaskDto | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [acting, setActing] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [form] = Form.useForm();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (projectId) params.set("project", String(projectId));
      if (assignedTo) params.set("assignedTo", assignedTo);
      if (mine) params.set("mine", "1");
      if (kw) params.set("q", kw);
      params.set("limit", "2000");
      const data = await api<{ tasks: TaskDto[] }>(`/api/tasks?${params}`);
      const groupsMap: Record<string, TaskDto[]> = { wait: [], doing: [], done: [], closed: [], other: [] };
      for (const t of data.tasks) (groupsMap[t.status] ?? groupsMap.other).push(t);
      for (const k of Object.keys(groupsMap)) groupsMap[k].sort((a, b) => a.pri - b.pri || a.id - b.id);
      setGroups(groupsMap);
      setAllTasks(data.tasks);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, assignedTo, mine, kw, message]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    api<OverviewDto>("/api/overview")
      .then((d) => setProjects(d.projects.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => {});
    api<Array<{ account: string; realname: string }>>("/api/users").then(setUsers).catch(() => {});
  }, []);

  function openDetail(t: TaskDto) {
    setCurrent(t);
    form.setFieldsValue({ consumed: 1, left: t.left, comment: "" });
    setDrawer(true);
  }

  async function act(action: string) {
    if (!current) return;
    setActing(true);
    try {
      const body =
        action === "finish"
          ? { action, consumed: form.getFieldValue("consumed"), left: form.getFieldValue("left"), comment: form.getFieldValue("comment") }
          : { action };
      await api(`/api/tasks/${current.id}/action`, { method: "POST", body });
      message.success("已更新");
      setDrawer(false);
      setFinishOpen(false);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActing(false);
    }
  }

  const metaRow = (t: TaskDto) => (
    <div className="task-card-meta">
      <ProjectDot name={t.projectName} />
      <span style={{ color: "var(--text-2)" }}>{t.projectName}</span>
      {t.assignedTo && <Avatar name={t.assignedTo.realname} size={20} />}
      {t.deadline && (
        <span style={isOverdue(t) ? { color: "var(--red)", fontWeight: 600 } : undefined}>
          {isOverdue(t) ? "逾期 " : "截止 "}
          {t.deadline.slice(5)}
        </span>
      )}
      <span style={{ marginLeft: "auto" }}>
        {t.consumed}h<span style={{ color: "var(--border-strong)" }}> / </span>余{t.left}h
      </span>
    </div>
  );

  const taskCard = (t: TaskDto) => (
    <div key={t.id} className="task-card" onClick={() => openDetail(t)}>
      <div className="task-card-name">{t.name}</div>
      {metaRow(t)}
    </div>
  );

  const listColumns = [
    {
      title: "任务",
      dataIndex: "name",
      ellipsis: true,
      render: (_: unknown, t: TaskDto) => (
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ProjectDot name={t.projectName} />
          <span style={{ fontWeight: 500 }}>{t.name}</span>
        </span>
      ),
    },
    { title: "项目", dataIndex: "projectName", width: 120, ellipsis: true },
    {
      title: "状态",
      dataIndex: "status",
      width: 92,
      render: (s: string) => <StatusPill status={s} />,
    },
    {
      title: "负责人",
      dataIndex: "assignedTo",
      width: 110,
      render: (a: TaskDto["assignedTo"]) =>
        a ? (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Avatar name={a.realname} size={22} /> {a.realname}
          </span>
        ) : (
          <span style={{ color: "var(--text-3)" }}>未指派</span>
        ),
    },
    {
      title: "截止",
      dataIndex: "deadline",
      width: 110,
      render: (d: string, t: TaskDto) =>
        d ? <span style={isOverdue(t) ? { color: "var(--red)", fontWeight: 600 } : undefined}>{d}</span> : "-",
    },
    {
      title: "工时(耗/余)",
      key: "hours",
      width: 100,
      render: (_: unknown, t: TaskDto) => `${t.consumed} / ${t.left}h`,
    },
    {
      title: "优先级",
      dataIndex: "pri",
      width: 70,
      render: (p: number) => <Tag style={{ borderRadius: 6, fontWeight: 600, color: PRI_COLOR[p], borderColor: "transparent" }}>P{p}</Tag>,
    },
  ];

  const filters = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 16 }}>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="全部项目"
        style={{ width: 200 }}
        value={projectId}
        onChange={setProjectId}
        options={projects}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="全部人员"
        style={{ width: 150 }}
        value={assignedTo}
        onChange={setAssignedTo}
        options={users.map((u) => ({ value: u.account, label: u.realname }))}
      />
      <Checkbox checked={mine} onChange={(e) => setMine(e.target.checked)}>
        只看我的
      </Checkbox>
      <Input allowClear placeholder="搜索任务名" style={{ width: 190 }} value={kw} onChange={(e) => setKw(e.target.value)} />
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>{allTasks.length} 条</span>
      <Segmented
        value={view}
        onChange={(v) => setView(v as string)}
        options={[
          { value: "board", icon: <AppstoreOutlined />, label: "看板" },
          { value: "list", icon: <UnorderedListOutlined />, label: "列表" },
        ]}
      />
    </div>
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">任务</div>
          <div className="page-desc">跨项目任务看板与流转</div>
        </div>
        <Button onClick={() => reload()}>刷新</Button>
      </div>
      {filters}

      <Spin spinning={loading}>
        {view === "board" ? (
          <div className="board-row">
            {COLUMNS.map((col) => {
              const list = groups[col.key] ?? [];
              return (
                <div key={col.key} className="board-col">
                  <div className="board-col-head">
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 4,
                          background:
                            col.key === "doing" ? "#5b5bd6" : col.key === "done" ? "#16a34a" : col.key === "wait" ? "#d97706" : "#c3c3cf",
                        }}
                      />
                      {col.label}
                    </span>
                    <span style={{ color: "var(--text-3)" }}>{list.length}</span>
                  </div>
                  {list.slice(0, 120).map(taskCard)}
                  {list.length > 120 && <div className="empty-hint" style={{ padding: "8px 0" }}>仅显示前 120 条</div>}
                  {list.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: "16px 0" }} />}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="card" style={{ padding: "4px 16px 10px" }}>
            <Table<TaskDto>
              size="small"
              rowKey="id"
              columns={listColumns}
              dataSource={allTasks}
              pagination={{ pageSize: 20, showSizeChanger: false, size: "small" }}
              onRow={(t) => ({ onClick: () => openDetail(t), style: { cursor: "pointer" } })}
            />
          </div>
        )}
      </Spin>

      <Drawer
        title={current ? <span style={{ fontSize: 15 }}>任务 #{current.id}</span> : ""}
        width={480}
        open={drawer}
        onClose={() => setDrawer(false)}
      >
        {current && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <StatusPill status={current.status} />
              <Tag style={{ borderRadius: 6 }}>P{current.pri}</Tag>
              <Tag style={{ borderRadius: 6 }}>{current.projectName}</Tag>
            </div>
            <h3 style={{ marginTop: 0, fontSize: 16, lineHeight: 1.5 }}>{current.name}</h3>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="执行">{current.executionName}</Descriptions.Item>
              <Descriptions.Item label="指派给">{current.assignedTo?.realname ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="截止">{current.deadline || "-"}</Descriptions.Item>
              <Descriptions.Item label="开始日期">{current.estStarted || "-"}</Descriptions.Item>
              <Descriptions.Item label="预计">{current.estimate}h</Descriptions.Item>
              <Descriptions.Item label="消耗/剩余">{current.consumed}h / {current.left}h</Descriptions.Item>
            </Descriptions>
            <div style={{ marginTop: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {current.status === "wait" && (
                <Button type="primary" loading={acting} onClick={() => act("start")}>开始</Button>
              )}
              {current.status === "doing" && <Button loading={acting} onClick={() => act("pause")}>暂停</Button>}
              {current.status === "pause" && (
                <Button type="primary" loading={acting} onClick={() => act("restart")}>继续</Button>
              )}
              {["wait", "doing", "pause"].includes(current.status) && (
                <Button type="primary" danger ghost onClick={() => setFinishOpen(true)}>
                  完成并记工时
                </Button>
              )}
              {current.status === "done" && <Button loading={acting} onClick={() => act("close")}>关闭</Button>}
              {["done", "closed"].includes(current.status) && (
                <Button loading={acting} onClick={() => act("restart")}>重新激活</Button>
              )}
            </div>
          </>
        )}
      </Drawer>

      <Modal
        title="完成并记录工时"
        open={finishOpen}
        onCancel={() => setFinishOpen(false)}
        onOk={() => act("finish")}
        confirmLoading={acting}
        okText="确认完成"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="consumed" label="消耗工时(h)" rules={[{ required: true }]}>
            <InputNumber min={0.5} step={0.5} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="left" label="完成后剩余(h)" tooltip="完成任务通常为 0">
            <InputNumber min={0} step={0.5} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="comment" label="工作内容（选填）">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default function BoardPage() {
  return (
    <Suspense fallback={<div style={{ display: "flex", justifyContent: "center", padding: 80 }}><Spin size="large" /></div>}>
      <BoardInner />
    </Suspense>
  );
}

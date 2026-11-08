"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Spin,
  Tag,
  Tooltip,
} from "antd";
import { api, PRI_COLOR, STATUS_LABEL, type OverviewDto, type TaskDto } from "@/lib/api";

const COLUMNS = [
  { key: "wait", label: "未开始", color: "#8c8c8c" },
  { key: "doing", label: "进行中", color: "#1677ff" },
  { key: "done", label: "已完成", color: "#52c41a" },
  { key: "closed", label: "已关闭", color: "#bfbfbf" },
  { key: "other", label: "其他", color: "#722ed1" },
] as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function BoardInner() {
  const { message } = AntdApp.useApp();
  const searchParams = useSearchParams();
  const [groups, setGroups] = useState<Record<string, TaskDto[]>>({});
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([]);
  const [users, setUsers] = useState<Array<{ account: string; realname: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState<number | undefined>(
    Number(searchParams.get("project")) || undefined,
  );
  const [assignedTo, setAssignedTo] = useState<string | undefined>();
  const [mine, setMine] = useState(false);
  const [kw, setKw] = useState("");
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
      setGroups(await api<Record<string, TaskDto[]>>(`/api/board?${params}`));
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
    api<Array<{ account: string; realname: string }>>("/api/users")
      .then(setUsers)
      .catch(() => {});
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
          ? {
              action,
              consumed: form.getFieldValue("consumed"),
              left: form.getFieldValue("left"),
              comment: form.getFieldValue("comment"),
            }
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

  function isOverdue(t: TaskDto): boolean {
    return Boolean(t.deadline) && ["wait", "doing", "pause"].includes(t.status) && t.deadline < today();
  }

  return (
    <div style={{ padding: 16 }}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="全部项目"
          style={{ width: 220 }}
          value={projectId}
          onChange={setProjectId}
          options={projects}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="全部人员"
          style={{ width: 160 }}
          value={assignedTo}
          onChange={setAssignedTo}
          options={users.map((u) => ({ value: u.account, label: u.realname }))}
        />
        <Checkbox checked={mine} onChange={(e) => setMine(e.target.checked)}>
          只看我的
        </Checkbox>
        <Input
          allowClear
          placeholder="搜索任务名"
          style={{ width: 200 }}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
        <div className="flex-1" />
        <Button onClick={() => reload()}>刷新</Button>
      </div>

      <Spin spinning={loading}>
        <div className="kanban-row">
          {COLUMNS.map((col) => {
            const list = groups[col.key] ?? [];
            return (
              <div key={col.key} className="kanban-col">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span style={{ fontWeight: 600 }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        background: col.color,
                        marginRight: 6,
                      }}
                    />
                    {col.label}
                  </span>
                  <Tag style={{ borderRadius: 10 }}>{list.length}</Tag>
                </div>
                {list.slice(0, 120).map((t) => (
                  <div key={t.id} className="task-card" onClick={() => openDetail(t)}>
                    <div className="task-name">{t.name}</div>
                    <div className="task-meta">
                      <Tag style={{ fontSize: 11 }}>{t.projectName}</Tag>
                      <Tag color={PRI_COLOR[t.pri] ?? "default"} style={{ fontSize: 11 }}>
                        P{t.pri}
                      </Tag>
                      <span>{t.assignedTo?.realname ?? "未指派"}</span>
                      {t.deadline && (
                        <span style={isOverdue(t) ? { color: "#ff4d4f", fontWeight: 600 } : undefined}>
                          截止 {t.deadline}
                          {isOverdue(t) ? " ⚠" : ""}
                        </span>
                      )}
                      <span>
                        耗{t.consumed}h 余{t.left}h
                      </span>
                    </div>
                  </div>
                ))}
                {list.length > 120 && (
                  <div className="text-center text-xs text-gray-400">仅显示前 120 条</div>
                )}
                {list.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
              </div>
            );
          })}
        </div>
      </Spin>

      <Drawer
        title={current ? `任务 #${current.id}` : ""}
        width={520}
        open={drawer}
        onClose={() => setDrawer(false)}
      >
        {current && (
          <>
            <h3>{current.name}</h3>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="项目">{current.projectName}</Descriptions.Item>
              <Descriptions.Item label="执行">{current.executionName}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag>{STATUS_LABEL[current.status] ?? current.status}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="优先级">P{current.pri}</Descriptions.Item>
              <Descriptions.Item label="指派给">
                {current.assignedTo?.realname ?? "-"}
              </Descriptions.Item>
              <Descriptions.Item label="截止">{current.deadline || "-"}</Descriptions.Item>
              <Descriptions.Item label="预计工时">{current.estimate}h</Descriptions.Item>
              <Descriptions.Item label="消耗/剩余">
                {current.consumed}h / {current.left}h
              </Descriptions.Item>
            </Descriptions>
            <div className="mt-4 flex flex-wrap gap-2">
              {current.status === "wait" && (
                <Button type="primary" loading={acting} onClick={() => act("start")}>
                  开始
                </Button>
              )}
              {current.status === "doing" && (
                <Button loading={acting} onClick={() => act("pause")}>
                  暂停
                </Button>
              )}
              {current.status === "pause" && (
                <Button type="primary" loading={acting} onClick={() => act("restart")}>
                  继续
                </Button>
              )}
              {["wait", "doing", "pause"].includes(current.status) && (
                <Button type="primary" danger ghost onClick={() => setFinishOpen(true)}>
                  完成并记工时
                </Button>
              )}
              {current.status === "done" && (
                <Button loading={acting} onClick={() => act("close")}>
                  关闭
                </Button>
              )}
              {["done", "closed"].includes(current.status) && (
                <Button loading={acting} onClick={() => act("restart")}>
                  重新激活
                </Button>
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
          <Form.Item name="left" label="完成后剩余(h)" tooltip="完成任务的剩余通常为 0">
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
    <Suspense fallback={<div className="flex justify-center py-20"><Spin size="large" /></div>}>
      <BoardInner />
    </Suspense>
  );
}

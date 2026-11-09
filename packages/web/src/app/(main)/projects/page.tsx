"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App as AntdApp,
  Button,
  Dropdown,
  Empty,
  Input,
  Modal,
  Select,
  Spin,
  Switch,
  Tag,
} from "antd";
import { DownOutlined, PlusOutlined } from "@ant-design/icons";
import { api, type OverviewDto, type ProjectDto } from "@/lib/api";
import { useUser } from "@/lib/user";
import { ProjectDot } from "@/components/ui";

interface GroupNode {
  id: number
  parentId: number | null
  name: string
  sortOrder: number
  children: GroupNode[]
  projectRefs: number[]
}

interface Mapping {
  id: number
  sourceProjectId: number
  sourceType: string
  groupId: number | null
  enabled: boolean
}

/** 递归渲染分组树（含分组内项目 + 未分组区） */
function GroupBranch({
  node,
  depth,
  projectsById,
  onAddSub,
  onRename,
  onMove,
  onDelete,
  onAssign,
}: {
  node: GroupNode
  depth: number
  projectsById: Map<number, ProjectDto>
  onAddSub: (parentId: number) => void
  onRename: (g: GroupNode) => void
  onMove: (g: GroupNode) => void
  onDelete: (g: GroupNode) => void
  onAssign: (projectId: number, groupId: number | null) => void
}) {
  const inGroup = node.projectRefs.map((id) => projectsById.get(id)).filter(Boolean) as ProjectDto[]
  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div className="flex items-center gap-2" style={{ padding: "7px 0" }}>
        <DownOutlined style={{ fontSize: 9, color: "var(--ink-3)" }} />
        <span style={{ fontSize: 13.5, fontWeight: 500 }}>{node.name}</span>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {node.projectRefs.length} 项目
        </span>
        <div style={{ flex: 1 }} />
        <Button type="text" size="small" onClick={() => onAddSub(node.id)}>
          子分组
        </Button>
        <Dropdown
          menu={{
            items: [
              { key: "rename", label: "重命名" },
              { key: "move", label: "移动到…" },
              { key: "delete", label: "删除分组", danger: true },
            ],
            onClick: ({ key }) => {
              if (key === "rename") onRename(node)
              else if (key === "move") onMove(node)
              else if (key === "delete") onDelete(node)
            },
          }}
        >
          <Button type="text" size="small">⋯</Button>
        </Dropdown>
      </div>
      {inGroup.map((p) => (
        <ProjectRow key={p.id} project={p} depth={depth + 1} onAssign={onAssign} />
      ))}
      {node.children.map((c) => (
        <GroupBranch
          key={c.id}
          node={c}
          depth={depth + 1}
          projectsById={projectsById}
          onAddSub={onAddSub}
          onRename={onRename}
          onMove={onMove}
          onDelete={onDelete}
          onAssign={onAssign}
        />
      ))}
    </div>
  )
}

function ProjectRow({
  project,
  depth,
  onAssign,
}: {
  project: ProjectDto
  depth: number
  onAssign: (projectId: number, groupId: number | null) => void
}) {
  return (
    <div
      className="flex items-center gap-2"
      style={{ marginLeft: depth * 16 + 18, padding: "5px 0" }}
    >
      <ProjectDot name={project.name} />
      <span style={{ fontSize: 13 }}>{project.name}</span>
      <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
        {project.executions.length} 执行 · {project.tasksTotal} 任务
      </span>
    </div>
  )
}

export default function ProjectsPage() {
  const { message } = AntdApp.useApp();
  const user = useUser();
  const [tree, setTree] = useState<GroupNode[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [ov, setOv] = useState<OverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [nameModal, setNameModal] = useState<{ mode: "create" | "rename" | "move"; target?: GroupNode; parentId?: number | null } | null>(null);
  const [inputName, setInputName] = useState("");
  const [moveTarget, setMoveTarget] = useState<number | undefined>();

  const isLead = Boolean(user?.lead);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [t, m, o] = await Promise.all([
        api<{ tree: GroupNode[] }>("/api/admin/groups"),
        api<{ mappings: Mapping[] }>("/api/admin/mappings"),
        api<OverviewDto>("/api/overview"),
      ]);
      setTree(t.tree);
      setMappings(m.mappings);
      setOv(o);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (user?.lead) reload();
  }, [user, reload]);

  const projectsById = useMemo(() => {
    const m = new Map<number, ProjectDto>();
    for (const p of ov?.projects ?? []) m.set(p.id, p);
    return m;
  }, [ov]);

  const groupedIds = useMemo(() => {
    const s = new Set<number>();
    const walk = (nodes: GroupNode[]) => {
      for (const n of nodes) {
        n.projectRefs.forEach((id) => s.add(id));
        walk(n.children);
      }
    };
    walk(tree);
    return s;
  }, [tree]);

  const ungrouped = (ov?.projects ?? []).filter((p) => !groupedIds.has(p.id));
  const disabledIds = new Set(mappings.filter((m) => !m.enabled).map((m) => m.sourceProjectId));

  const flatGroups = useMemo(() => {
    const out: Array<{ id: number; name: string }> = [];
    const walk = (nodes: GroupNode[], prefix: string) => {
      for (const n of nodes) {
        out.push({ id: n.id, name: prefix + n.name });
        walk(n.children, prefix + n.name + " / ");
      }
    };
    walk(tree, "");
    return out;
  }, [tree]);

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
        <div className="page-header"><div><div className="page-title">项目</div></div></div>
        <div className="card"><Empty description="项目管理仅负责人可见" style={{ padding: 40 }} /></div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">项目</div>
          <div className="page-desc">分组树组织全部项目；分组即数据权限边界</div>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setInputName("");
            setNameModal({ mode: "create", parentId: null });
          }}
        >
          新建分组
        </Button>
      </div>

      <Spin spinning={loading}>
        <div className="card" style={{ padding: "12px 18px 18px" }}>
          {tree.length === 0 && !loading && (
            <Empty description="还没有分组，先建一个（如：交付一组 / 交付二组）" style={{ padding: 30 }} />
          )}
          {tree.map((g) => (
            <GroupBranch
              key={g.id}
              node={g}
              depth={0}
              projectsById={projectsById}
              onAddSub={(parentId) => {
                setInputName("");
                setNameModal({ mode: "create", parentId });
              }}
              onRename={(g2) => {
                setInputName(g2.name);
                setNameModal({ mode: "rename", target: g2 });
              }}
              onMove={(g2) => {
                setMoveTarget(undefined);
                setNameModal({ mode: "move", target: g2 });
              }}
              onDelete={(g2) =>
                Modal.confirm({
                  title: `删除分组「${g2.name}」？`,
                  content: "子分组将一并删除，组内项目退回未分组。",
                  okButtonProps: { danger: true },
                  onOk: () => act(() => api(`/api/admin/groups/${g2.id}`, { method: "DELETE" }), "已删除"),
                })
              }
              onAssign={(projectId, groupId) =>
                act(
                  () => api(`/api/admin/mappings/${projectId}`, { method: "PUT", body: { groupId } }),
                  "已调整分组",
                )
              }
            />
          ))}

          <div className="section-title" style={{ marginTop: 18 }}>未分组（{ungrouped.length}）</div>
          {ungrouped.map((p) => (
            <div key={p.id} className="flex items-center gap-2" style={{ padding: "5px 0" }}>
              <ProjectDot name={p.name} />
              <span style={{ fontSize: 13, flex: 1 }}>{p.name}</span>
              {disabledIds.has(p.id) && <Tag style={{ borderRadius: 6 }}>已隐藏</Tag>}
              <Switch
                size="small"
                checked={!disabledIds.has(p.id)}
                onChange={(v) =>
                  act(
                    () => api(`/api/admin/mappings/${p.id}`, { method: "PUT", body: { enabled: v } }),
                    v ? "已纳入" : "已隐藏",
                  )
                }
              />
              <Select
                size="small"
                placeholder="移入分组"
                style={{ width: 150 }}
                value={null}
                onChange={(gid: number) =>
                  act(
                    () => api(`/api/admin/mappings/${p.id}`, { method: "PUT", body: { groupId: gid } }),
                    "已移入分组",
                  )
                }
                options={flatGroups}
              />
            </div>
          ))}
        </div>
      </Spin>

      <Modal
        open={nameModal !== null}
        title={
          nameModal?.mode === "create" ? "新建分组" : nameModal?.mode === "rename" ? "重命名分组" : "移动分组"
        }
        onCancel={() => setNameModal(null)}
        onOk={() => {
          if (!nameModal) return;
          if (nameModal.mode === "create") {
            act(
              () => api("/api/admin/groups", { method: "POST", body: { name: inputName, parentId: nameModal.parentId ?? null } }),
              "已创建",
            );
          } else if (nameModal.mode === "rename" && nameModal.target) {
            act(() => api(`/api/admin/groups/${nameModal.target!.id}`, { method: "PUT", body: { name: inputName } }), "已重命名");
          } else if (nameModal.mode === "move" && nameModal.target) {
            act(
              () => api(`/api/admin/groups/${nameModal.target!.id}`, { method: "PUT", body: { parentId: moveTarget ?? null } }),
              "已移动",
            );
          }
          setNameModal(null);
        }}
        okText="保存"
      >
        {nameModal?.mode === "move" ? (
        <Select
            style={{ width: "100%" }}
            placeholder="移到顶层（留空）或选择父分组"
            allowClear
            value={moveTarget}
            onChange={setMoveTarget}
            options={flatGroups.filter((g) => g.id !== nameModal.target?.id)}
          />
        ) : (
          <Input
            placeholder="分组名称"
            value={inputName}
            onChange={(e) => setInputName(e.target.value)}
            autoFocus
          />
        )}
      </Modal>
    </div>
  );
}

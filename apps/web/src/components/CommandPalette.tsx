"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Spin } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { api, type OverviewDto, type TaskDto } from "@/lib/api";
import { Avatar, ProjectDot, StatusPill } from "./ui";

interface Item {
  key: string;
  kind: "project" | "task";
  id: number;
  title: string;
  sub?: string;
  goto: string;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [kw, setKw] = useState("");
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([]);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && projects.length === 0) {
      setLoading(true);
      Promise.all([
        api<OverviewDto>("/api/overview").then((d) => setProjects(d.projects.map((p) => ({ id: p.id, name: p.name })))),
        api<{ tasks: TaskDto[] }>("/api/tasks?limit=2000").then((d) => setTasks(d.tasks)),
      ])
        .catch(() => {})
        .finally(() => setLoading(false));
    }
    if (open) {
      setKw("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, projects.length]);

  const items = useMemo<Item[]>(() => {
    const k = kw.trim().toLowerCase();
    const p: Item[] = projects
      .filter((x) => !k || x.name.toLowerCase().includes(k))
      .slice(0, 6)
      .map((x) => ({ key: `p${x.id}`, kind: "project", id: x.id, title: x.name, sub: "项目", goto: `/board?project=${x.id}` }));
    const t: Item[] = (k
      ? tasks.filter((x) => x.name.toLowerCase().includes(k))
      : tasks.filter((x) => ["wait", "doing", "pause"].includes(x.status))
    )
      .slice(0, 12)
      .map((x) => ({
        key: `t${x.id}`,
        kind: "task",
        id: x.id,
        title: x.name,
        sub: `${x.projectName} · ${x.assignedTo?.realname ?? "未指派"}`,
        goto: `/board?q=${encodeURIComponent(x.name.slice(0, 40))}`,
      }));
    return [...p, ...t];
  }, [kw, projects, tasks]);

  function go(item: Item) {
    onClose();
    router.push(item.goto);
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={560}
      styles={{ body: { padding: 0, borderRadius: 14, overflow: "hidden" } }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
        <SearchOutlined style={{ color: "var(--text-3)", fontSize: 15 }} />
        <input
          ref={inputRef}
          value={kw}
          onChange={(e) => {
            setKw(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && items[active]) go(items[active]);
          }}
          placeholder="搜索项目、任务…"
          style={{ flex: 1, border: "none", outline: "none", fontSize: 14.5, background: "transparent", color: "var(--text-1)" }}
        />
        <span className="kbd">Esc</span>
      </div>
      <div style={{ maxHeight: 380, overflowY: "auto", padding: "6px 8px 10px" }}>
        {loading && <div style={{ padding: "30px 0", textAlign: "center" }}><Spin /></div>}
        {!loading && items.length === 0 && <div className="empty-hint">没有匹配的结果</div>}
        {items.map((item, i) => (
          <div
            key={item.key}
            onMouseEnter={() => setActive(i)}
            onClick={() => go(item)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 10px",
              borderRadius: 9,
              cursor: "pointer",
              background: i === active ? "var(--accent-weak)" : undefined,
            }}
          >
            {item.kind === "project" ? (
              <span style={{ width: 26, display: "flex", justifyContent: "center" }}><ProjectDot name={item.title} /></span>
            ) : (
              <span style={{ width: 26, display: "flex", justifyContent: "center" }}><Avatar name={item.sub?.split(" · ")[1] ?? "?"} size={22} /></span>
            )}
            <span style={{ flex: 1, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.title}
            </span>
            {item.kind === "task" && <StatusPill status={tasks.find((t) => t.id === item.id)?.status ?? "wait"} />}
            <span style={{ fontSize: 12, color: "var(--text-3)", flexShrink: 0 }}>{item.sub}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

"use client";

import type { TaskDto } from "@/lib/api";

const AVATAR_COLORS = [
  "#4d6bfe", "#0ea5e9", "#16a34a", "#d97706", "#db2777",
  "#7c3aed", "#0891b2", "#ca8a04", "#dc2626", "#4f46e5",
];

export function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** 项目配色（甘特条/圆点，按名称稳定散列，低饱和高级色板） */
const PROJECT_PALETTE = [
  "#4d6bfe", "#0e9488", "#d97706", "#db2777", "#7c3aed",
  "#0284c7", "#65a30d", "#e11d48", "#9333ea", "#b45309",
  "#0d9488", "#4f46e5",
];

export function projectColor(name: string): string {
  return PROJECT_PALETTE[hashCode(name) % PROJECT_PALETTE.length];
}
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function Avatar({ name, size = 26 }: { name: string; size?: number }) {
  const text = (name || "?").slice(0, 1);
  return (
    <span
      title={name}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: hashColor(name),
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.44,
        fontWeight: 600,
        flexShrink: 0,
        lineHeight: 1,
      }}
    >
      {text}
    </span>
  );
}

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  wait: { label: "未开始", cls: "pill-wait" },
  doing: { label: "进行中", cls: "pill-doing" },
  done: { label: "已完成", cls: "pill-done" },
  closed: { label: "已关闭", cls: "pill-closed" },
  pause: { label: "已暂停", cls: "pill-pause" },
  cancel: { label: "已取消", cls: "pill-cancel" },
};

export function StatusPill({ status }: { status: string }) {
  const s = STATUS_MAP[status] ?? { label: status, cls: "pill-closed" };
  return <span className={`pill ${s.cls}`}>{s.label}</span>;
}

export function ProjectDot({ name }: { name: string }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 3,
        background: projectColor(name),
        display: "inline-block",
        flexShrink: 0,
      }}
      title={name}
    />
  );
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isOverdue(t: Pick<TaskDto, "deadline" | "status">): boolean {
  return Boolean(t.deadline) && ["wait", "doing", "pause"].includes(t.status) && t.deadline < todayStr();
}

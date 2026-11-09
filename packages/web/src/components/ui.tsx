"use client";

import type { TaskDto } from "@/lib/api";

/**
 * 头像配色（dsh 弱底色方案）：低饱和底 + 深同色系文字，
 * 同一姓名稳定取色；与全局"无大面积高饱和"原则一致
 */
const AVATAR_TONES: Array<{ bg: string; fg: string }> = [
  { bg: "#E4EDFD", fg: "#4176E6" }, // brand
  { bg: "#E6F4F1", fg: "#0E7C6B" }, // teal
  { bg: "#FBF0E2", fg: "#B0731E" }, // amber
  { bg: "#F3EAFB", fg: "#7749C8" }, // violet
  { bg: "#FDEBEC", fg: "#C43D44" }, // rose
  { bg: "#E8F0FB", fg: "#33608F" }, // steel blue
  { bg: "#EDF3E3", fg: "#5C7A1E" }, // olive
  { bg: "#F6EAF4", fg: "#9B4F92" }, // plum
  { bg: "#E9F1F4", fg: "#3C748A" }, // cyan slate
  { bg: "#F0ECE8", fg: "#7A6A56" }, // warm gray
];

export function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 项目配色（甘特条/圆点，按名称稳定散列，低饱和高级色板） */
const PROJECT_PALETTE = [
  "#4176e6", "#0e9488", "#d97706", "#db2777", "#7c3aed",
  "#0284c7", "#65a30d", "#e11d48", "#9333ea", "#b45309",
  "#0d9488", "#4f46e5",
];

export function projectColor(name: string): string {
  return PROJECT_PALETTE[hashCode(name) % PROJECT_PALETTE.length];
}

export function Avatar({ name, size = 26 }: { name: string; size?: number }) {
  const text = (name || "?").slice(0, 1);
  const tone = AVATAR_TONES[hashCode(name) % AVATAR_TONES.length];
  return (
    <span
      title={name}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: tone.bg,
        color: tone.fg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.44,
        fontWeight: 500,
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

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

/**
 * 项目配色：与头像同源的弱底 tone 体系（低饱和底 + 深同色系），
 * 甘特条/项目点/项目标签统一使用；同一项目名稳定取色
 */
const PROJECT_TONES: Array<{ bg: string; fg: string }> = [
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

export function projectTone(name: string): { bg: string; fg: string } {
  return PROJECT_TONES[hashCode(name) % PROJECT_TONES.length];
}

/** 兼容旧调用（只需一个颜色时取深色） */
export function projectColor(name: string): string {
  return projectTone(name).fg;
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
  const tone = projectTone(name);
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 3,
        background: tone.bg,
        boxShadow: `inset 0 0 0 1.5px ${tone.fg}`,
        display: "inline-block",
        flexShrink: 0,
      }}
      title={name}
    />
  );
}

/** 项目弱底标签：tone 底 + 深字 + 同色细边，任务卡/列表通用 */
export function ProjectTag({ name }: { name: string }) {
  const tone = projectTone(name);
  return (
    <span
      style={{
        background: tone.bg,
        color: tone.fg,
        boxShadow: `inset 0 0 0 1px ${tone.fg}33`,
        borderRadius: 5,
        fontSize: 11,
        fontWeight: 400,
        lineHeight: "18px",
        padding: "0 6px",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {name}
    </span>
  );
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isOverdue(t: Pick<TaskDto, "deadline" | "status">): boolean {
  return Boolean(t.deadline) && ["wait", "doing", "pause"].includes(t.status) && t.deadline < todayStr();
}

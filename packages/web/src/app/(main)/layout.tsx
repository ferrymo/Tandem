"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  AppstoreOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  LogoutOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { App as AntdApp, Button, Dropdown, Spin } from "antd";
import { CommandPalette } from "@/components/CommandPalette";
import { Avatar as UserAvatar } from "@/components/ui";
import { api } from "@/lib/api";
import { fetchMe, resetMe } from "@/lib/user";
import type { UserInfo } from "@/lib/api";

const NAV = [
  { key: "/", icon: <ThunderboltOutlined />, label: "工作台" },
  { key: "/board", icon: <AppstoreOutlined />, label: "任务" },
  { key: "/effort", icon: <ClockCircleOutlined />, label: "工时" },
  { key: "/plan", icon: <CalendarOutlined />, label: "排期" },
];

const TITLE: Record<string, { title: string; desc: string }> = {
  "/": { title: "工作台", desc: "项目全局进展与团队负载一览" },
  "/board": { title: "任务", desc: "跨项目任务看板与流转" },
  "/effort": { title: "工时", desc: "填报、时间轴与统计分析" },
  "/plan": { title: "排期", desc: "成员任务排期与空档规划" },
};

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { message } = AntdApp.useApp();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u) {
        router.replace("/login");
        return;
      }
      setUser(u);
      setChecking(false);
    });
    const onUserUpdated = () => {
      fetchMe(true).then((u) => u && setUser(u));
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("ztp:user-updated", onUserUpdated);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("ztp:user-updated", onUserUpdated);
    };
  }, [router]);

  if (checking || !user) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Spin size="large" />
      </div>
    );
  }

  const meta = TITLE[pathname] ?? { title: "Tandem", desc: "" };

  async function logout() {
    try {
      await api("/api/logout", { method: "POST" });
    } catch {
      /* 忽略 */
    }
    resetMe();
    message.success("已退出");
    router.replace("/login");
  }

  async function refreshBridge() {
    setRefreshing(true);
    try {
      const u = await api<UserInfo>("/api/refresh-bridge", { method: "POST" });
      setUser(u);
      if (!u.passwordChangeRequired) message.success("网页会话已恢复，工时功能可用");
      else message.info("禅道侧仍要求修改密码，请先在禅道完成修改");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      {/* 侧边栏 */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">🚲</div>
          <div className="brand-name">Tandem</div>
        </div>
        <div className="nav-group">工作空间</div>
        {NAV.map((n) => (
          <div
            key={n.key}
            className={`nav-item${pathname === n.key ? " active" : ""}`}
            onClick={() => router.push(n.key)}
          >
            <span style={{ fontSize: 15 }}>{n.icon}</span>
            {n.label}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        {user.passwordChangeRequired && (
          <div style={{ margin: "0 12px 8px", padding: "10px 12px", background: "var(--amber-weak)", borderRadius: 10, fontSize: 12, color: "#92400e", lineHeight: 1.6 }}>
            禅道要求先修改密码，记工时暂不可用。
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <a href={(user.ztUrl ?? "") + "/index.php?m=my&f=changePassword"} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                去修改
              </a>
              <a onClick={refreshBridge} style={{ fontWeight: 600, cursor: "pointer" }}>
                {refreshing ? "检测中…" : "重新检测"}
              </a>
            </div>
          </div>
        )}
        <div style={{ padding: "10px 12px 14px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 9 }}>
          <UserAvatar name={user.realname} size={30} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.realname}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{user.lead ? "交付负责人" : "成员"}</div>
          </div>
          <Button type="text" size="small" icon={<LogoutOutlined />} onClick={logout} title="退出登录" />
        </div>
      </aside>

      {/* 右侧主体 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header className="topbar">
          <div className="search-trigger" onClick={() => setPaletteOpen(true)}>
            <SearchOutlined style={{ fontSize: 13 }} />
            搜索项目、任务…
            <span className="kbd">⌘K</span>
          </div>
          <div style={{ flex: 1 }} />
        </header>
        <main style={{ flex: 1, overflow: "auto" }}>{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

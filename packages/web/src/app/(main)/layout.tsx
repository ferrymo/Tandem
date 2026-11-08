"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  AppstoreOutlined,
  DashboardOutlined,
  FieldTimeOutlined,
  LogoutOutlined,
  PartitionOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { App as AntdApp, Avatar, Button, ConfigProvider, Dropdown, Layout, Menu, Spin, theme } from "antd";
import { api } from "@/lib/api";
import { fetchMe, resetMe } from "@/lib/user";
import type { UserInfo } from "@/lib/api";

const TITLE: Record<string, string> = {
  "/": "指挥台",
  "/board": "任务看板",
  "/effort": "工时中心",
  "/timeline": "工时时间轴",
  "/plan": "资源排期",
};

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { message } = AntdApp.useApp();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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
    window.addEventListener("ztp:user-updated", onUserUpdated);
    return () => window.removeEventListener("ztp:user-updated", onUserUpdated);
  }, [router]);

  if (checking || !user) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spin size="large" tip="加载中…" />
      </div>
    );
  }

  const menuItems = [
    { key: "/", icon: <DashboardOutlined />, label: "指挥台" },
    { key: "/board", icon: <AppstoreOutlined />, label: "任务看板" },
    { key: "/effort", icon: <FieldTimeOutlined />, label: "工时中心" },
    { key: "/timeline", icon: <PartitionOutlined />, label: "工时时间轴" },
    ...(user.lead ? [{ key: "/plan", icon: <TeamOutlined />, label: "资源排期" }] : []),
  ];

  async function logout() {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      /* 忽略 */
    }
    resetMe();
    message.success("已退出");
    router.replace("/login");
  }

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        components: { Menu: { darkItemBg: "transparent" } },
      }}
    >
      <Layout style={{ height: "100vh" }}>
        <Layout.Sider width={208} style={{ background: "#001529" }}>
          <div
            className="flex items-center gap-2 px-5 text-white"
            style={{ height: 56, fontSize: 16, fontWeight: 700 }}
          >
            <span>🧭</span>
            <span>禅道指挥台</span>
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[pathname]}
            items={menuItems}
            onClick={({ key }) => router.push(key)}
            style={{ borderInlineEnd: "none", background: "transparent" }}
          />
        </Layout.Sider>
        <Layout>
          <Layout.Header
            style={{
              background: "#fff",
              borderBottom: "1px solid #e8e8e8",
              display: "flex",
              alignItems: "center",
              padding: "0 20px",
              height: 56,
              lineHeight: "56px",
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 600 }}>{TITLE[pathname] ?? "禅道指挥台"}</span>
            <div className="flex-1" />
            {user.passwordChangeRequired && (
              <span className="flex items-center gap-1">
                <Button
                  type="link"
                  danger
                  size="small"
                  href={(user.ztUrl ?? "") + "/index.php?m=my&f=changePassword"}
                  target="_blank"
                >
                  ⚠️ 禅道要求修改密码（记工时暂不可用），点击去修改
                </Button>
                <Button
                  type="link"
                  size="small"
                  loading={refreshing}
                  onClick={async () => {
                    setRefreshing(true)
                    try {
                      const u = await api<UserInfo>("/api/refresh-bridge", { method: "POST" })
                      setUser(u)
                      if (!u.passwordChangeRequired) message.success("网页会话已恢复，工时功能可用")
                      else message.info("禅道侧仍要求修改密码，请先在禅道完成修改")
                    } finally {
                      setRefreshing(false)
                    }
                  }}
                >
                  重新检测
                </Button>
              </span>
            )}
            <Dropdown
              menu={{
                items: [{ key: "logout", icon: <LogoutOutlined />, label: "退出登录" }],
                onClick: ({ key }) => key === "logout" && logout(),
              }}
            >
              <span className="flex cursor-pointer items-center gap-2">
                <Avatar style={{ background: "#1677ff" }} size={30}>
                  {(user.realname ?? user.account).slice(0, 1)}
                </Avatar>
                <span style={{ color: "#333" }}>{user.realname}</span>
                {user.lead && (
                  <span
                    style={{
                      fontSize: 12,
                      color: "#fa8c16",
                      border: "1px solid #ffd591",
                      borderRadius: 4,
                      padding: "0 4px",
                    }}
                  >
                    负责人
                  </span>
                )}
              </span>
            </Dropdown>
          </Layout.Header>
          <Layout.Content style={{ overflow: "auto", background: "#f5f7fa" }}>{children}</Layout.Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}

import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import "./globals.css";

dayjs.locale("zh-cn");

export const metadata: Metadata = {
  title: "Tandem",
  description: "人与 AI Agent 共同交付的协作平台",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <ConfigProvider
            locale={zhCN}
            theme={{
              token: {
                // 与 globals.css 设计令牌同步（docs/03-设计规范.md）
                colorPrimary: "#4176e6",
                colorInfo: "#4176e6",
                colorLink: "#4176e6",
                colorBgLayout: "#f9fafb",
                colorBgContainer: "#ffffff",
                colorBorder: "#cfd5e0",
                colorBorderSecondary: "#e1e5ee",
                colorText: "#0f1115",
                colorTextSecondary: "#979da6",
                colorTextTertiary: "#adaeb2",
                borderRadius: 8,
                controlHeight: 32,
                fontSize: 13.5,
                boxShadowSecondary: "0 0 0 0.5px rgb(15 17 21 / 8%), 0 8px 32px rgb(15 17 21 / 12%)",
              },
              components: {
                Button: { fontWeight: 500, primaryShadow: "none", defaultShadow: "none" },
                Card: { paddingLG: 20 },
                Table: { headerBg: "transparent", rowHoverBg: "#f9fafb" },
                Modal: { contentBg: "#ffffff" },
              },
            }}
          >
            <App>{children}</App>
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}

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
                colorPrimary: "#4d6bfe",
                colorInfo: "#4d6bfe",
                colorLink: "#4d6bfe",
                colorBgLayout: "#f6f6f8",
                colorBgContainer: "#ffffff",
                colorBorder: "#e0e0e8",
                colorBorderSecondary: "#e9e9f0",
                colorText: "#1c1c28",
                colorTextSecondary: "#6e6e80",
                colorTextTertiary: "#a0a0b0",
                borderRadius: 9,
                controlHeight: 32,
                fontSize: 13.5,
              },
              components: {
                Button: { fontWeight: 500 },
                Card: { paddingLG: 20 },
                Table: { headerBg: "transparent", rowHoverBg: "#f8f8fb" },
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

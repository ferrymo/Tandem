import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import "./globals.css";

dayjs.locale("zh-cn");

export const metadata: Metadata = {
  title: "禅道指挥台",
  description: "多项目进展 · 工时协同 · 资源排期",
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
                colorPrimary: "#5b5bd6",
                colorInfo: "#5b5bd6",
                colorLink: "#5b5bd6",
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

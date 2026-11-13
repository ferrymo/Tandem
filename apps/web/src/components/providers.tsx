'use client';
import { useEffect, useState } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ThemeConfig } from 'antd';
export function Providers({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeConfig>({ token: { motion: false } });
  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const value = (name: string) => css.getPropertyValue(name).trim();
    setTheme({
      token: {
        colorPrimary: value('--color-primary'),
        colorPrimaryBorder: value('--color-primary'),
        lineWidthFocus: 2,
        colorText: value('--color-text'),
        colorTextSecondary: value('--color-text-secondary'),
        colorBgContainer: value('--color-surface'),
        colorBorder: value('--color-control-border'),
        colorSplit: value('--color-divider'),
        colorSuccess: value('--color-success-text'),
        colorWarning: value('--color-warning-text'),
        colorError: value('--color-danger-text'),
        fontFamily: value('--font-body'),
        fontSize: parseInt(value('--font-size-body')),
        borderRadius: parseInt(value('--radius-control')),
        controlHeight: parseInt(value('--control-height')),
        boxShadow: 'none',
        boxShadowSecondary: 'none',
        motion: false,
      },
    });
  }, []);
  return (
    <ConfigProvider
      locale={zhCN}
      theme={theme}
      button={{ autoInsertSpace: false }}
    >
      {children}
    </ConfigProvider>
  );
}

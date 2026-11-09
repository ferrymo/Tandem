"use client";

import { useState } from "react";
import { Button, Input } from "antd";
import { useRouter } from "next/navigation";
import { Logo } from "@/components/Logo";

export default function LoginPage() {
  const router = useRouter();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [tip, setTip] = useState("");

  async function submit() {
    if (!account || !password) {
      setTip("请输入账号和密码");
      return;
    }
    setLoading(true);
    setTip("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, password }),
        credentials: "same-origin",
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error((data.message as string) ?? `登录失败(${res.status})`);
      router.replace("/");
      router.refresh();
    } catch (e) {
      setTip((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center" style={{ background: "var(--bg)" }}>
      <div style={{ width: 340 }}>
        <div className="mb-8 flex flex-col items-center gap-3">
          <Logo size={28} />
          <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
            人与 AI Agent 共同交付的协作平台
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <Input
            size="large"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="协作系统账号"
            autoFocus
          />
          <Input.Password
            size="large"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
          />
          <Button type="primary" size="large" htmlType="submit" loading={loading} block>
            登录
          </Button>
        </form>
        {tip && (
          <div style={{ marginTop: 12, fontSize: 13, color: "var(--bad)" }}>{tip}</div>
        )}
        <div style={{ marginTop: 20, fontSize: 12, color: "var(--ink-3)", textAlign: "center" }}>
          身份与权限继承你的协作系统账号
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Button, Card, Form, Input, Typography } from "antd";
import { useRouter } from "next/navigation";

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
    <div
      className="flex h-screen items-center justify-center"
      style={{ background: "linear-gradient(135deg, #e6f0ff 0%, #f5f7fa 55%, #e8f7f0 100%)" }}
    >
      <Card style={{ width: 400, boxShadow: "0 8px 32px rgba(0,0,0,0.08)" }}>
        <div className="mb-6 text-center">
          <div style={{ fontSize: 34 }}>🚲</div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            Tandem
          </Typography.Title>
          <Typography.Text type="secondary">
            人与 AI Agent 共同交付的开源协作平台
          </Typography.Text>
        </div>
        <Form layout="vertical" onFinish={submit}>
          <Form.Item label="禅道账号">
            <Input
              size="large"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="与禅道登录一致"
              autoFocus
            />
          </Form.Item>
          <Form.Item label="密码">
            <Input.Password
              size="large"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="禅道密码"
            />
          </Form.Item>
          <Button type="primary" size="large" block htmlType="submit" loading={loading}>
            登录
          </Button>
        </Form>
        {tip && (
          <Typography.Text type="danger" style={{ display: "block", marginTop: 12 }}>
            {tip}
          </Typography.Text>
        )}
        <Typography.Text type="secondary" style={{ display: "block", marginTop: 12, fontSize: 12 }}>
          使用禅道账号登录，权限与禅道完全一致；凭证仅用于登录。
        </Typography.Text>
      </Card>
    </div>
  );
}

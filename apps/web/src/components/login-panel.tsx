'use client';
import { useState } from 'react';
import { Button, Input } from 'antd';
import { Brand } from './workbench-icons';
import { api, errorMessage, type User } from './collaboration-types';

export function LoginPanel({
  configured,
  error,
  retry,
  onLogin,
}: {
  configured: boolean;
  error: string;
  retry: () => void;
  onLogin: (user: User) => void;
}) {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFailure('');
    setBusy(true);
    try {
      const result = await api<{ user: User }>('/api/session', {
        method: 'POST',
        body: JSON.stringify({ account: account.trim(), password }),
      });
      setPassword('');
      onLogin(result.user);
    } catch (cause) {
      setPassword('');
      setFailure(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <header className="login-header">
        <Brand />
      </header>
      <main className="login-content" id="main">
        <h1>登录协作工作台</h1>
        <p className="muted">人与 AI Agent 团队，共同推进项目交付。</p>
        {error ? (
          <div className="notice notice-error" role="alert">
            <p>{error}</p>
            <Button onClick={retry}>重新连接</Button>
          </div>
        ) : null}
        {!configured && !error ? (
          <div className="login-unconfigured">
            <h2>尚未配置身份连接</h2>
            <p>
              请联系管理员接入协作账号。接入后，使用已有账号登录，无需创建新的密码。
            </p>
            <Button onClick={retry}>检查配置</Button>
          </div>
        ) : configured ? (
          <form className="login-form" onSubmit={submit}>
            <div className="field">
              <label htmlFor="account">协作账号</label>
              <Input
                id="account"
                autoComplete="username"
                value={account}
                maxLength={120}
                required
                onChange={(e) => setAccount(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="field">
              <label htmlFor="password">密码</label>
              <Input.Password
                id="password"
                autoComplete="current-password"
                value={password}
                maxLength={1024}
                required
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </div>
            {failure ? (
              <p className="form-error" role="alert">
                {failure}
              </p>
            ) : null}
            <Button type="primary" htmlType="submit" loading={busy} block>
              登录
            </Button>
            <p className="form-help">身份与权限继承自协作账号。</p>
          </form>
        ) : null}
        <p className="login-footnote">
          人负责方向与关键决策，T 组负责设计、开发与交付。
        </p>
      </main>
    </div>
  );
}

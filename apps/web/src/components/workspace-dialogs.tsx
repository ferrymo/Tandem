'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Select } from 'antd';
import {
  api,
  errorMessage,
  roleNames,
  type Member,
  type User,
  type Workspace,
} from './collaboration-types';

export function CreateWorkspaceDialog({
  open,
  close,
  created,
  onError,
}: {
  open: boolean;
  close: () => void;
  created: (workspace: Workspace) => void;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef({ name: '', id: '' });
  useEffect(() => {
    if (open) {
      setName('');
      setError('');
      request.current = { name: '', id: '' };
    }
  }, [open]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = name.trim();
    if (!value) {
      setError('请输入工作空间名称。');
      return;
    }
    if (request.current.name !== value)
      request.current = { name: value, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const data = await api<{ workspace: Workspace }>('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: value, requestId: request.current.id }),
      });
      created(data.workspace);
    } catch (cause) {
      setError(errorMessage(cause));
      onError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="创建工作空间"
      open={open}
      onCancel={close}
      footer={null}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
      destroyOnHidden
    >
      <form className="dialog-form" onSubmit={submit}>
        <p className="muted">
          工作空间用于划分团队成员与协作配置。创建时会建立 T 组和三个 Agent。
        </p>
        <div className="field">
          <label htmlFor="workspace-name">工作空间名称</label>
          <Input
            id="workspace-name"
            autoFocus
            value={name}
            maxLength={120}
            required
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <p className="form-help">
          创建空间不会自动授予项目访问权限或启动运行。
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <Button onClick={close} disabled={busy}>
            取消
          </Button>
          <Button type="primary" htmlType="submit" loading={busy}>
            创建工作空间
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function MembersDialog({
  workspace,
  user,
  open,
  close,
  onError,
}: {
  workspace: Workspace;
  user: User;
  open: boolean;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [identityId, setIdentityId] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<Member | null>(null);
  const cancelRemoval = useRef<HTMLButtonElement>(null);
  const [revision, setRevision] = useState(0);
  const canManage = workspace.role !== 'member';
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setMembers(null);
    setError('');
    setSuccess('');
    setIdentityId('');
    setRole('member');
    setPendingRemoval(null);
    api<{ members: Member[] }>(`/api/workspaces/${workspace.id}/members`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setMembers(data.members);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause));
          onError(cause);
        }
      });
    return () => controller.abort();
  }, [open, workspace.id, revision, onError]);
  useEffect(() => {
    if (pendingRemoval) cancelRemoval.current?.focus();
  }, [pendingRemoval]);
  async function refresh() {
    const result = await api<{ members: Member[] }>(
      `/api/workspaces/${workspace.id}/members`,
    );
    setMembers(result.members);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await api(`/api/workspaces/${workspace.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ identityId: identityId.trim(), role }),
      });
      await refresh();
      setIdentityId('');
      setSuccess('成员权限已保存。');
    } catch (cause) {
      setError(errorMessage(cause));
      onError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function remove(member: Member) {
    if (busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await api(
        `/api/workspaces/${workspace.id}/members/${member.identityId}`,
        { method: 'DELETE' },
      );
      await refresh();
      setPendingRemoval(null);
      setSuccess('成员已移出当前工作空间。');
    } catch (cause) {
      setError(errorMessage(cause));
      onError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`空间成员 · ${workspace.name}`}
      open={open}
      onCancel={close}
      footer={<Button onClick={close}>关闭</Button>}
      width={640}
      destroyOnHidden
    >
      <p className="muted">
        空间成员关系只授权本空间的协作资产，项目访问仍须单独校验。
      </p>
      {error ? (
        <div className="notice notice-error" role="alert">
          <p>{error}</p>
          {!members ? (
            <Button onClick={() => setRevision((n) => n + 1)}>重新读取</Button>
          ) : null}
        </div>
      ) : null}
      {!members && !error ? (
        <LoadingRows />
      ) : members ? (
        <ul className="member-list">
          {members.map((member) => (
            <li key={member.identityId}>
              <div>
                <strong>{member.displayName}</strong>
                {member.identityId === user.id ? (
                  <span className="muted">（你）</span>
                ) : null}
                <span className="member-role">{roleNames[member.role]}</span>
              </div>
              {canManage &&
              member.role !== 'owner' &&
              (workspace.role === 'owner' || member.role === 'member') ? (
                <Button
                  danger
                  type="text"
                  disabled={busy}
                  onClick={() => setPendingRemoval(member)}
                  aria-label={`移除 ${member.displayName}`}
                >
                  移除
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {pendingRemoval ? (
        <div className="member-removal" role="group" aria-label="确认移出成员">
          <p>
            将“{pendingRemoval.displayName}”移出“{workspace.name}
            ”后，该成员将失去此空间的访问权限。已有协作资产保留。
          </p>
          <div className="dialog-actions">
            <Button
              ref={cancelRemoval}
              disabled={busy}
              onClick={() => setPendingRemoval(null)}
            >
              保留成员
            </Button>
            <Button
              danger
              loading={busy}
              onClick={() => void remove(pendingRemoval)}
            >
              移出空间
            </Button>
          </div>
        </div>
      ) : null}
      {canManage ? (
        <form className="member-form" onSubmit={submit}>
          <h2>添加或调整成员</h2>
          <p className="form-help">
            请对方先登录，再从“我的账号”复制成员 ID。再次添加可更新该成员角色。
          </p>
          <div className="field">
            <label htmlFor="member-id">成员 ID</label>
            <Input
              id="member-id"
              value={identityId}
              maxLength={36}
              required
              disabled={busy}
              onChange={(e) => setIdentityId(e.target.value)}
            />
          </div>
          {workspace.role === 'owner' ? (
            <div className="field">
              <label htmlFor="member-role">空间角色</label>
              <Select
                id="member-role"
                value={role}
                onChange={setRole}
                disabled={busy}
                options={[
                  { value: 'member', label: '成员' },
                  { value: 'admin', label: '管理员' },
                ]}
              />
            </div>
          ) : (
            <p className="form-help">
              管理员可以管理成员；管理员角色由空间创建人设置。
            </p>
          )}
          <Button htmlType="submit" type="primary" loading={busy}>
            保存成员权限
          </Button>
        </form>
      ) : null}
      {success ? (
        <p role="status" className="success-message">
          {success}
        </p>
      ) : null}
    </Modal>
  );
}

export function LoadingRows() {
  return (
    <div className="loading-rows" role="status" aria-label="正在读取">
      <span />
      <span />
      <span />
    </div>
  );
}

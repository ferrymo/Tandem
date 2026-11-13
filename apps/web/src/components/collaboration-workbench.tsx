'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button, Modal } from 'antd';
import { LoginPanel } from './login-panel';
import {
  CreateWorkspaceDialog,
  LoadingRows,
  MembersDialog,
} from './workspace-dialogs';
import { Brand, NavIcon } from './workbench-icons';
import {
  ApiError,
  api,
  errorMessage,
  navigation,
  roleNames,
  type Overview,
  type User,
  type View,
  type Workspace,
} from './collaboration-types';

type Session = {
  user: User | null;
  login: { configured: boolean; label: string };
};

function readView(): View {
  const value = new URLSearchParams(window.location.search).get('view');
  return navigation.find((item) => item.view === value)?.view ?? 'focus';
}
function locationFor(view: View, workspaceId: string) {
  const query = new URLSearchParams({ view });
  if (workspaceId) query.set('workspace', workspaceId);
  return '/?' + query.toString();
}

export function CollaborationWorkbench() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [sessionRevision, setSessionRevision] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [scopeError, setScopeError] = useState('');
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [view, setView] = useState<View>('focus');
  const [menuOpen, setMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [copied, setCopied] = useState(false);
  const user = session?.user;

  useEffect(() => {
    const sync = () => {
      setView(readView());
      setWorkspaceId(
        new URLSearchParams(window.location.search).get('workspace') ?? '',
      );
      setOverview(null);
      setMembersOpen(false);
      setMenuOpen(false);
    };
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSessionError('');
    api<Session>('/api/session', { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setSession((current) =>
          current?.user &&
          data.user &&
          current.user.id === data.user.id &&
          current.user.displayName === data.user.displayName &&
          current.user.canCreateWorkspace === data.user.canCreateWorkspace
            ? { ...data, user: current.user }
            : data,
        );
        if (!data.user) {
          setWorkspaces(null);
          setOverview(null);
          setWorkspaceId('');
          setMembersOpen(false);
          setCreateOpen(false);
          setAccountOpen(false);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setSession(null);
          setSessionError(errorMessage(cause));
          setWorkspaces(null);
          setOverview(null);
          setWorkspaceId('');
          setMembersOpen(false);
          setCreateOpen(false);
          setAccountOpen(false);
        }
      });
    return () => controller.abort();
  }, [sessionRevision]);

  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      if (document.visibilityState === 'visible')
        setSessionRevision((value) => value + 1);
    };
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 60000);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(timer);
    };
  }, [Boolean(user)]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        document.getElementById('navigation-toggle')?.focus();
      }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [menuOpen]);

  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) {
      setSession((current) => (current ? { ...current, user: null } : null));
      setWorkspaces(null);
      setOverview(null);
      setWorkspaceId('');
      setScopeError('');
      setMembersOpen(false);
      setCreateOpen(false);
      setAccountOpen(false);
      setSessionError(cause.message);
      window.history.replaceState(null, '', '/');
    } else if (cause instanceof ApiError && cause.status === 403) {
      setOverview(null);
      setWorkspaces(null);
      setWorkspaceId('');
      setMembersOpen(false);
      setWorkspaceRevision((value) => value + 1);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setScopeError('');
    api<{ workspaces: Workspace[] }>('/api/workspaces', {
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        setWorkspaces(data.workspaces);
        setWorkspaceId((current) =>
          data.workspaces.some((space) => space.id === current)
            ? current
            : (data.workspaces[0]?.id ?? ''),
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setScopeError(errorMessage(cause));
          handleError(cause);
        }
      });
    return () => controller.abort();
  }, [user, workspaceRevision, handleError]);

  useEffect(() => {
    if (!user || !workspaceId) return;
    const controller = new AbortController();
    setOverview(null);
    setScopeError('');
    window.history.replaceState(null, '', locationFor(readView(), workspaceId));
    api<Overview>(`/api/workspaces/${workspaceId}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setOverview(data);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setScopeError(errorMessage(cause));
          handleError(cause);
        }
      });
    return () => controller.abort();
  }, [user, workspaceId, detailRevision, handleError]);

  function navigate(next: View) {
    setView(next);
    setMenuOpen(false);
    window.history.pushState(null, '', locationFor(next, workspaceId));
    window.requestAnimationFrame(() =>
      document.getElementById('main')?.focus(),
    );
  }
  function selectWorkspace(next: string) {
    setWorkspaceId(next);
    setOverview(null);
    setScopeError('');
    setMembersOpen(false);
    window.history.pushState(null, '', locationFor(view, next));
  }
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setAccountError('');
    try {
      await api('/api/session', { method: 'DELETE' });
      setSession((current) => (current ? { ...current, user: null } : null));
      setWorkspaces(null);
      setWorkspaceId('');
      setOverview(null);
      setAccountOpen(false);
      setScopeError('');
      window.history.replaceState(null, '', '/');
    } catch (cause) {
      setAccountError(errorMessage(cause));
      handleError(cause);
    } finally {
      setLoggingOut(false);
    }
  }
  async function copyIdentity() {
    if (!user) return;
    try {
      await navigator.clipboard.writeText(user.id);
      setCopied(true);
      setAccountError('');
    } catch {
      setAccountError('复制未完成，请选中成员 ID 手动复制。');
    }
  }

  if (!session && !sessionError)
    return (
      <main className="standalone-page">
        <Brand />
        <LoadingRows />
      </main>
    );
  if (!user)
    return (
      <LoginPanel
        configured={session?.login.configured ?? false}
        error={sessionError}
        retry={() => setSessionRevision((n) => n + 1)}
        onLogin={(next) => {
          setSession({
            user: next,
            login: session?.login ?? { configured: true, label: '协作账号' },
          });
          setSessionError('');
        }}
      />
    );

  const workspace =
    overview?.workspace ??
    workspaces?.find((space) => space.id === workspaceId);
  const title = navigation.find((item) => item.view === view)?.label ?? '关注';
  return (
    <div className="workbench">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <aside
        className={`workbench-sidebar${menuOpen ? ' is-open' : ''}`}
        id="workspace-navigation"
      >
        <div className="sidebar-brand">
          <Brand />
        </div>
        <nav aria-label="主要导航">
          {navigation.map((item) => (
            <a
              key={item.view}
              href={locationFor(item.view, workspaceId)}
              aria-current={view === item.view ? 'page' : undefined}
              onClick={(event) => {
                if (
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey &&
                  event.button === 0
                ) {
                  event.preventDefault();
                  navigate(item.view);
                }
              }}
            >
              <NavIcon view={item.view} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>人与 Agent 协作</span>
          <a href="/health">基础服务状态</a>
        </div>
      </aside>
      <div className="workbench-body">
        <header className="workbench-topbar">
          <Button
            className="mobile-menu"
            id="navigation-toggle"
            type="text"
            aria-label={menuOpen ? '收起导航' : '展开导航'}
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            onClick={() => setMenuOpen((value) => !value)}
            icon={<NavIcon view="menu" />}
          />
          <div className="workspace-picker">
            <label htmlFor="workspace-selector">工作空间</label>
            <select
              id="workspace-selector"
              value={workspaceId}
              onChange={(event) => selectWorkspace(event.target.value)}
              disabled={!workspaces?.length}
            >
              <option value="" disabled>
                {workspaces?.length ? '选择工作空间' : '尚未加入空间'}
              </option>
              {workspaces?.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name}
                </option>
              ))}
            </select>
          </div>
          <div className="topbar-actions">
            {user.canCreateWorkspace ? (
              <Button
                className="create-workspace-trigger"
                type="text"
                onClick={() => setCreateOpen(true)}
              >
                新建空间
              </Button>
            ) : null}
            <Button
              type="text"
              onClick={() => {
                setAccountOpen(true);
                setAccountError('');
                setCopied(false);
              }}
              aria-label={`我的账号，${user.displayName}`}
            >
              {user.displayName}
            </Button>
          </div>
        </header>
        <main className="workbench-main" id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <h1>{title}</h1>
              <p className="muted">
                {workspace
                  ? `${workspace.name} · ${roleNames[workspace.role]}`
                  : '建立团队的协作空间'}
              </p>
            </div>
            {workspace ? (
              <Button onClick={() => setMembersOpen(true)}>空间成员</Button>
            ) : null}
          </div>
          {scopeError ? (
            <div className="notice notice-error" role="alert">
              <p>{scopeError}</p>
              <Button
                onClick={() => {
                  setWorkspaceRevision((value) => value + 1);
                  setDetailRevision((value) => value + 1);
                }}
              >
                重新读取
              </Button>
            </div>
          ) : null}
          {!workspaces && !scopeError ? (
            <LoadingRows />
          ) : !workspaceId && !scopeError ? (
            <div className="workspace-empty">
              <h2>
                {user.canCreateWorkspace
                  ? '创建你的第一个工作空间'
                  : '尚未加入工作空间'}
              </h2>
              <p className="muted">
                {user.canCreateWorkspace
                  ? 'T 组将在创建时自动建立。成员、配置和协作资产按空间隔离。'
                  : '请将“我的账号”中的成员 ID 发给空间创建人，由其添加成员权限。'}
              </p>
              {user.canCreateWorkspace ? (
                <Button type="primary" onClick={() => setCreateOpen(true)}>
                  创建工作空间
                </Button>
              ) : (
                <Button onClick={() => setAccountOpen(true)}>
                  查看我的成员 ID
                </Button>
              )}
            </div>
          ) : !overview && !scopeError ? (
            <LoadingRows />
          ) : overview ? (
            <WorkspaceContent
              view={view}
              overview={overview}
              navigate={navigate}
              onError={handleError}
            />
          ) : null}
        </main>
      </div>
      <CreateWorkspaceDialog
        open={createOpen}
        close={() => setCreateOpen(false)}
        onError={handleError}
        created={(space) => {
          setWorkspaces((current) => [
            ...(current ?? []).filter((item) => item.id !== space.id),
            space,
          ]);
          selectWorkspace(space.id);
          setCreateOpen(false);
        }}
      />
      {workspace ? (
        <MembersDialog
          key={workspace.id}
          workspace={workspace}
          user={user}
          open={membersOpen}
          close={() => setMembersOpen(false)}
          onError={handleError}
        />
      ) : null}
      <Modal
        title="我的账号"
        open={accountOpen}
        onCancel={() => setAccountOpen(false)}
        footer={null}
      >
        <dl className="account-details">
          <div>
            <dt>姓名</dt>
            <dd>{user.displayName}</dd>
          </div>
          <div>
            <dt>成员 ID</dt>
            <dd>
              <code className="identity-id">{user.id}</code>
            </dd>
          </div>
        </dl>
        <p className="form-help">
          邀请加入空间时，只需提供成员 ID，无需提供密码。
        </p>
        {accountError ? (
          <p className="form-error" role="alert">
            {accountError}
          </p>
        ) : null}
        {copied ? (
          <p role="status" className="success-message">
            成员 ID 已复制。
          </p>
        ) : null}
        {user.canCreateWorkspace ? (
          <p className="account-create">
            <Button
              onClick={() => {
                setAccountOpen(false);
                setCreateOpen(true);
              }}
            >
              创建工作空间
            </Button>
          </p>
        ) : null}
        <div className="dialog-actions account-actions">
          <Button onClick={() => void copyIdentity()}>复制成员 ID</Button>
          <Button danger loading={loggingOut} onClick={() => void logout()}>
            退出登录
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function WorkspaceContent({
  view,
  overview,
  navigate,
  onError,
}: {
  view: View;
  overview: Overview;
  navigate: (view: View) => void;
  onError: (error: unknown) => void;
}) {
  const team = overview.team;
  if (view === 'connect') return <ConnectionPanel onError={onError} />;
  if (view === 'tasks')
    return (
      <div className="content-panel empty-content">
        <h2>任务读取尚未开放</h2>
        <p className="muted">
          这里将显示你有权访问的项目任务。业务事实由连接系统提供，工作空间不会生成另一套任务数据。
        </p>
        <Button onClick={() => navigate('connect')}>查看当前连接</Button>
      </div>
    );
  if (view === 'observe')
    return (
      <div className="content-panel empty-content">
        <h2>还没有可用于评估的运行记录</h2>
        <p className="muted">
          T 组尚未开始执行。负载、可用容量与期限压力暂时无法评估。
        </p>
        <p className="muted">
          运行与项目读取接入后，这里将显示有来源的工作量和执行记录。
        </p>
        <Button onClick={() => navigate('agents')}>查看 T 组</Button>
      </div>
    );
  if (view === 'capabilities')
    return (
      <div className="content-panel empty-content">
        <h2>Skills 与 MCP Server</h2>
        <p className="muted">
          技能安装与工具服务管理尚未开放。启用和绑定能力后，T
          组才能在授权范围内使用。
        </p>
        <p className="muted">当前没有已安装的技能或已接入的工具服务。</p>
      </div>
    );
  return (
    <>
      {view === 'focus' ? (
        <section className="content-panel setup-panel">
          <div className="section-heading">
            <div>
              <h2>先完成 T 组配置</h2>
              <p className="muted">团队已建立，执行条件尚未就绪。</p>
            </div>
            <Button type="primary" onClick={() => navigate('agents')}>
              查看 T 组
            </Button>
          </div>
          <ul className="setup-list">
            <li>
              <span className="state-marker" />
              <div>
                <strong>模型与执行环境待配置</strong>
                <p className="muted">
                  三个成员尚未绑定模型，代码、测试与预览也需要隔离执行环境。
                </p>
              </div>
            </li>
            <li>
              <span className="state-marker" />
              <div>
                <strong>项目上下文待授权</strong>
                <p className="muted">
                  创建团队不会扩大项目权限；派活前须明确项目范围与实际执行身份。
                </p>
              </div>
            </li>
          </ul>
        </section>
      ) : null}
      <section className="content-panel team-panel">
        <div className="section-heading">
          <div>
            <h2>{team.name}</h2>
            <p className="muted">
              挂靠人：{team.ownerDisplayName} · 模板版本 {team.templateVersion}
            </p>
          </div>
          <span className="state-label">
            <span className="state-marker" />
            待配置
          </span>
        </div>
        <ul className="agent-list">
          {team.agents.map((agent) => (
            <li key={agent.id}>
              <span className="agent-avatar" aria-hidden="true">
                <NavIcon view="agents" />
              </span>
              <div className="agent-description">
                <h3>
                  {agent.name}
                  <span className="agent-kind">Agent</span>
                </h3>
                <p>{agent.description}</p>
              </div>
              <span className="state-label">
                <span className="state-marker" />
                待配置
              </span>
            </li>
          ))}
        </ul>
        {view === 'agents' ? (
          <div className="team-requirements">
            <h3>开始执行前</h3>
            <p className="muted">
              模型、项目上下文及执行环境均待配置。配置与可恢复运行将在后续开发中接入；当前不会启动
              Agent 执行。
            </p>
          </div>
        ) : null}
      </section>
      {view === 'agents' ? (
        <section className="content-panel empty-content">
          <h2>运行与交付物</h2>
          <p className="muted">
            尚未开始运行。目标、阶段、待决策事项与交付证据将在实际执行后显示。
          </p>
        </section>
      ) : null}
    </>
  );
}

function ConnectionPanel({ onError }: { onError: (error: unknown) => void }) {
  const [data, setData] = useState<{
    connection: {
      id: string;
      label: string;
      kind: string;
      configured: boolean;
    };
    authorization: { status: string; displayName: string };
  } | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    api<NonNullable<typeof data>>('/api/connection', {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause));
          onError(cause);
        }
      });
    return () => controller.abort();
  }, [revision, onError]);
  return (
    <section className="content-panel">
      <div className="section-heading">
        <div>
          <h2>当前身份连接</h2>
          <p className="muted">账号授权与业务读取能力分别校验。</p>
        </div>
        <Button onClick={() => setRevision((value) => value + 1)}>
          重新检查
        </Button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : !data ? (
        <LoadingRows />
      ) : (
        <>
          <dl className="connection-details">
            <div>
              <dt>连接名称</dt>
              <dd>{data.connection.label}</dd>
            </div>
            <div>
              <dt>系统类型</dt>
              <dd>
                {data.connection.kind === 'zentao'
                  ? '禅道'
                  : data.connection.kind}
              </dd>
            </div>
            <div>
              <dt>当前账号</dt>
              <dd>{data.authorization.displayName}</dd>
            </div>
            <div>
              <dt>账号授权</dt>
              <dd className="state-label">
                <span className="state-marker is-success" />
                {data.authorization.status === 'authorized'
                  ? '已验证'
                  : '待验证'}
              </dd>
            </div>
            <div>
              <dt>项目与任务读取</dt>
              <dd>尚未开放</dd>
            </div>
          </dl>
          <p className="form-help">
            账号验证通过不代表拥有全部项目权限。连接配置由部署管理员管理。
          </p>
        </>
      )}
    </section>
  );
}

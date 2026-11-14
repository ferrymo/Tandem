'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal } from 'antd';
import { LoginPanel } from './login-panel';
import { WorkManagement } from './work-management';
import {
  CreateWorkspaceDialog,
  LoadingRows,
  MembersDialog,
} from './workspace-dialogs';
import { Brand, NavIcon } from './workbench-icons';
import type { WorkMenu } from './work-management-types';
import {
  guardUnsavedNavigation,
  hasUnsavedChanges,
} from './use-unsaved-changes';
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
  const aliases: Record<string, View> = {
    focus: 'projects',
    observe: 'analysis',
    connect: 'connectors',
    capabilities: 'agents',
  };
  return (
    navigation.find((item) => item.view === value)?.view ??
    aliases[value ?? ''] ??
    'projects'
  );
}
function locationFor(view: View, workspaceId: string) {
  const query = new URLSearchParams({ view });
  if (workspaceId) query.set('workspace', workspaceId);
  return '/?' + query.toString();
}
function nativeHistoryIndex() {
  const index = (
    window as Window & {
      navigation?: { currentEntry?: { index?: number } };
    }
  ).navigation?.currentEntry?.index;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0
    ? index
    : null;
}
function indexedState(index: number, historyId: string) {
  const state = window.history.state;
  return {
    ...(state && typeof state === 'object' ? state : {}),
    tandemIndex: index,
    tandemHistoryId: historyId,
  };
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
  const [view, setView] = useState<View>('projects');
  const [menuOpen, setMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [copied, setCopied] = useState(false);
  const [navigationNotice, setNavigationNotice] = useState('');
  const [menuSettings, setMenuSettings] = useState<{
    workspaceId: string;
    menus: WorkMenu[];
  } | null>(null);
  const onMenus = useCallback(
    (workspaceId: string, menus: WorkMenu[]) =>
      setMenuSettings({ workspaceId, menus }),
    [],
  );
  const currentIndex = useRef(0);
  const historyId = useRef('');
  const currentUrl = useRef('');
  const restoring = useRef<{ from: number; to: number; delta: number } | null>(
    null,
  );
  const acceptedTraversal = useRef<number | null>(null);
  const user = session?.user;

  function replaceLocation(url: string) {
    window.history.replaceState(
      indexedState(currentIndex.current, historyId.current),
      '',
      url,
    );
    currentUrl.current = window.location.href;
  }
  function pushLocation(url: string) {
    if (currentUrl.current !== window.location.href) {
      // An unindexed legacy traversal has no safe offset on older browsers.
      // Start a new segment rather than guessing an offset into the old one.
      historyId.current = crypto.randomUUID();
      currentIndex.current = nativeHistoryIndex() ?? 0;
      window.history.replaceState(
        indexedState(currentIndex.current, historyId.current),
        '',
      );
    }
    currentIndex.current += 1;
    window.history.pushState(
      indexedState(currentIndex.current, historyId.current),
      '',
      url,
    );
    const nativeIndex = nativeHistoryIndex();
    if (nativeIndex !== null) {
      // Browsers may evict old entries once their history limit is reached.
      currentIndex.current = nativeIndex;
      window.history.replaceState(
        indexedState(nativeIndex, historyId.current),
        '',
      );
    }
    currentUrl.current = window.location.href;
    setNavigationNotice('');
  }

  useEffect(() => {
    const sync = () => {
      setView(readView());
      const nextWorkspace =
        new URLSearchParams(window.location.search).get('workspace') ?? '';
      setWorkspaceId(nextWorkspace);
      setOverview((current) =>
        current?.workspace.id === nextWorkspace ? current : null,
      );
      setMembersOpen(false);
      setMenuOpen(false);
    };
    const state = window.history.state;
    historyId.current =
      typeof state?.tandemHistoryId === 'string'
        ? state.tandemHistoryId
        : crypto.randomUUID();
    currentIndex.current =
      nativeHistoryIndex() ??
      (Number.isInteger(state?.tandemIndex) ? state.tandemIndex : 0);
    window.history.replaceState(
      indexedState(currentIndex.current, historyId.current),
      '',
    );
    currentUrl.current = window.location.href;
    const onPop = (event: PopStateEvent) => {
      const state = event.state;
      const index =
        nativeHistoryIndex() ??
        (state?.tandemHistoryId === historyId.current &&
        Number.isInteger(state?.tandemIndex)
          ? (state.tandemIndex as number)
          : null);
      if (index === null) {
        if (hasUnsavedChanges()) {
          setNavigationNotice(
            '浏览器无法安全恢复此历史位置，当前输入仍保留。地址栏暂显示目标地址，请先保存或关闭编辑器，再使用页面导航。',
          );
          return;
        }
        historyId.current = crypto.randomUUID();
        currentIndex.current = 0;
        window.history.replaceState(indexedState(0, historyId.current), '');
        currentUrl.current = window.location.href;
        setNavigationNotice('');
        sync();
        return;
      }
      if (acceptedTraversal.current === index) {
        acceptedTraversal.current = null;
        restoring.current = null;
      } else {
        acceptedTraversal.current = null;
        const pending = restoring.current;
        if (pending) {
          if (index !== pending.from) {
            window.history.go(pending.from - index);
            return;
          }
          restoring.current = null;
          guardUnsavedNavigation(() => {
            acceptedTraversal.current = pending.to;
            window.history.go(pending.delta);
          });
          return;
        }
        if (hasUnsavedChanges()) {
          const delta = index - currentIndex.current;
          if (delta === 0) return;
          restoring.current = { from: currentIndex.current, to: index, delta };
          window.history.go(-delta);
          return;
        }
      }
      currentIndex.current = index;
      currentUrl.current = window.location.href;
      window.history.replaceState(indexedState(index, historyId.current), '');
      setNavigationNotice('');
      sync();
    };
    sync();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
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
      window.history.replaceState(
        indexedState(currentIndex.current, historyId.current),
        '',
        '/',
      );
      currentUrl.current = window.location.href;
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
        setWorkspaceId((current) => {
          const requested =
            current ||
            new URLSearchParams(window.location.search).get('workspace') ||
            '';
          return data.workspaces.some((space) => space.id === requested)
            ? requested
            : (data.workspaces[0]?.id ?? '');
        });
        if (!data.workspaces.length)
          replaceLocation(locationFor(readView(), ''));
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
    if (
      !user ||
      !workspaceId ||
      !workspaces?.some((space) => space.id === workspaceId)
    )
      return;
    const controller = new AbortController();
    setOverview(null);
    setScopeError('');
    replaceLocation(locationFor(readView(), workspaceId));
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
  }, [user, workspaceId, workspaces, detailRevision, handleError]);

  function navigate(next: View) {
    if (restoring.current) return;
    if (next === view) return setMenuOpen(false);
    guardUnsavedNavigation(() => {
      setView(next);
      setMenuOpen(false);
      pushLocation(locationFor(next, workspaceId));
      window.requestAnimationFrame(() =>
        document.getElementById('main')?.focus(),
      );
    });
  }
  function selectWorkspace(next: string) {
    if (restoring.current || next === workspaceId) return;
    guardUnsavedNavigation(() => {
      setWorkspaceId(next);
      setOverview(null);
      setScopeError('');
      setMembersOpen(false);
      pushLocation(locationFor(view, next));
    });
  }
  function logout() {
    if (loggingOut) return;
    guardUnsavedNavigation(() => void performLogout());
  }
  async function performLogout() {
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
      replaceLocation('/');
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
  const scopedMenus =
    menuSettings?.workspaceId === workspaceId ? menuSettings.menus : [];
  const visibleNavigation = navigation
    .map((item, index) => {
      const override = scopedMenus.find((m) => m.key === item.view);
      return {
        ...item,
        label: override?.label ?? item.label,
        visible: override?.visible ?? true,
        order: override?.sortOrder ?? index * 10,
      };
    })
    .filter((item) => item.visible || item.view === 'admin')
    .sort((a, b) => a.order - b.order);
  const title =
    visibleNavigation.find((item) => item.view === view)?.label ??
    navigation.find((item) => item.view === view)?.label ??
    '项目';
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
          {visibleNavigation.map((item) => (
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
          <span>让团队的工作井然有序</span>
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
                  ? ({
                      projects: '从立项到交付，把每个项目放在心里。',
                      documents: '知识有归属，协作有上下文。',
                      tasks: '明确下一步，让工作持续向前。',
                      analysis: '看清计划与投入，合理安排团队的每一天。',
                      agents: '把合适的能力，交给合适的 Agent。',
                      connectors: '连接团队正在使用的工具。',
                      admin: '维护团队、权限与工作空间设置。',
                    }[view as string] ??
                    `${workspace.name} · ${roleNames[workspace.role]}`)
                  : '建立团队的协作空间'}
              </p>
            </div>
            {workspace ? (
              <Button onClick={() => setMembersOpen(true)}>空间成员</Button>
            ) : null}
          </div>
          {navigationNotice ? (
            <div className="notice" role="alert">
              <p>{navigationNotice}</p>
            </div>
          ) : null}
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
            <WorkManagement
              key={overview.workspace.id}
              view={view}
              overview={overview}
              navigate={navigate}
              onError={handleError}
              onMenus={onMenus}
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

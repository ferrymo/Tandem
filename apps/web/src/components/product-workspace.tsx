'use client';
import { useEffect, useMemo, useState } from 'react';
import { Button, Input } from 'antd';
import { errorMessage, type Overview, type View } from './collaboration-types';
import {
  actProduct,
  Empty,
  ErrorText,
  ResourceState,
  useProductResource,
  type ProductClient,
  type ProjectItem,
} from './product-api';
import { TasksPanel } from './tasks-panel';
import { DeliveryPanel } from './delivery-panel';
import { CapabilitiesPanel } from './capabilities-panel';
import { guardUnsavedNavigation } from './use-unsaved-changes';

export function ProductWorkspace({
  view,
  overview,
  navigate,
  onError,
}: {
  view: View;
  overview: Overview;
  navigate: (view: View) => void;
  onError: (cause: unknown) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [projectId, setProjectId] = useState('');
  const client = useMemo<ProductClient>(
    () => ({
      workspace: overview.workspace,
      team: overview.team,
      projectId,
      revision,
      refresh: () => setRevision((n) => n + 1),
      onError,
    }),
    [overview, projectId, revision, onError],
  );
  const projects = useProductResource<{ projects: ProjectItem[] }>(
    client,
    'projects',
  );
  useEffect(() => {
    if (!projects.data) return;
    setProjectId((current) =>
      projects.data!.projects.some((p) => p.id === current)
        ? current
        : (projects.data!.projects[0]?.id ?? ''),
    );
  }, [projects.data]);
  return (
    <>
      <div className="product-toolbar">
        <label htmlFor="project-scope">项目范围</label>
        <select
          id="project-scope"
          value={projectId}
          disabled={!projects.data?.projects.length}
          onChange={(e) => {
            const next = e.target.value;
            guardUnsavedNavigation(() => setProjectId(next));
          }}
        >
          <option value="" disabled>
            尚无已授权项目
          </option>
          {projects.data?.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <Button onClick={client.refresh} loading={projects.loading}>
          刷新
        </Button>
        {view !== 'connect' ? (
          <Button type="link" onClick={() => navigate('connect')}>
            管理项目范围
          </Button>
        ) : null}
      </div>
      {projects.error ? (
        <ResourceState
          error={projects.error}
          loading={false}
          retry={projects.reload}
        />
      ) : null}
      {view === 'connect' ? (
        <ProjectConnections
          client={client}
          projects={projects.data?.projects ?? []}
        />
      ) : view === 'capabilities' ? (
        <CapabilitiesPanel key={overview.workspace.id} client={client} />
      ) : !projectId && (view === 'tasks' || view === 'observe') ? (
        <section className="content-panel">
          <Empty title="先连接一个项目">
            T 组、任务和交付都在明确的项目授权范围内工作。
          </Empty>
          <Button onClick={() => navigate('connect')}>连接项目</Button>
        </section>
      ) : view === 'tasks' ? (
        <TasksPanel key={projectId} client={client} />
      ) : (
        <DeliveryPanel
          key={projectId}
          client={client}
          view={view}
          navigate={navigate}
        />
      )}
    </>
  );
}

export function ProjectConnections({
  client,
  projects,
}: {
  client: ProductClient;
  projects: ProjectItem[];
}) {
  const connection = useProductResource<{
    connection: { label: string; kind: string };
    authorization: { displayName: string; status: string };
  }>(client, 'connection');
  const available = useProductResource<{
    projects: { id: string; name: string; status: string }[];
  }>(client, 'available-projects');
  const [choice, setChoice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [member, setMember] = useState('');
  const [write, setWrite] = useState(false);
  const [grantProject, setGrantProject] = useState('');
  const [message, setMessage] = useState('');
  const grants = useProductResource<{
    grants: { identityId: string; displayName: string; canWrite: boolean }[];
  }>(client, 'project-grants', { project: grantProject || client.projectId });
  const manager = client.workspace.role !== 'member';
  async function act(command: string, input: Record<string, unknown>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await actProduct(client, command, input);
      setMessage('项目授权已更新。');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="content-panel">
        <div className="section-heading">
          <div>
            <h2>业务连接</h2>
            <p className="muted">按当前账号读取，项目与任务以连接系统为准。</p>
          </div>
        </div>
        <ResourceState {...connection} retry={connection.reload}>
          {connection.data ? (
            <dl className="connection-details">
              <div>
                <dt>连接名称</dt>
                <dd>{connection.data.connection.label}</dd>
              </div>
              <div>
                <dt>系统类型</dt>
                <dd>
                  {connection.data.connection.kind === 'zentao'
                    ? '禅道'
                    : connection.data.connection.kind}
                </dd>
              </div>
              <div>
                <dt>执行账号</dt>
                <dd>{connection.data.authorization.displayName}</dd>
              </div>
              <div>
                <dt>身份授权</dt>
                <dd>已验证</dd>
              </div>
            </dl>
          ) : null}
        </ResourceState>
      </section>
      <section className="content-panel">
        <h2>已连接项目</h2>
        {projects.length ? (
          <ul className="product-rows">
            {projects.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>{p.name}</strong>
                  <p className="muted">
                    {p.status} · {p.canWrite ? '可读取和提交草案' : '只读授权'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="还没有连接项目">从当前账号有权访问的项目中选择。</Empty>
        )}
        {manager ? (
          <ResourceState {...available} retry={available.reload}>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act('bind-project', { externalId: choice });
              }}
            >
              <label className="field grow">
                连接项目
                <select
                  required
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                  disabled={busy}
                >
                  <option value="">选择已有项目</option>
                  {available.data?.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                htmlType="submit"
                type="primary"
                loading={busy}
                disabled={!choice}
              >
                连接到空间
              </Button>
            </form>
          </ResourceState>
        ) : null}
      </section>
      {manager && projects.length ? (
        <section className="content-panel">
          <h2>项目成员授权</h2>
          <p className="muted">
            空间成员仍需项目授权；此处授权不会扩大其外部账号权限。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act('grant-project', {
                projectId: grantProject || client.projectId,
                identityId: member,
                canWrite: write,
              });
            }}
          >
            <div className="form-grid">
              <label className="field">
                项目
                <select
                  value={grantProject || client.projectId}
                  onChange={(e) => setGrantProject(e.target.value)}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                成员 ID
                <Input
                  value={member}
                  onChange={(e) => setMember(e.target.value)}
                  required
                  placeholder="空间内的成员 ID"
                />
              </label>
            </div>
            <label className="check-field">
              <input
                type="checkbox"
                checked={write}
                onChange={(e) => setWrite(e.target.checked)}
              />
              允许提交写入草案
            </label>
            <Button htmlType="submit" loading={busy} disabled={!member.trim()}>
              保存项目授权
            </Button>
          </form>
          <ResourceState {...grants} retry={grants.reload}>
            <ul className="product-rows">
              {grants.data?.grants.map((g) => (
                <li key={g.identityId}>
                  <div>
                    <strong>{g.displayName}</strong>
                    <p className="muted">
                      {g.canWrite ? '读写' : '只读'} · {g.identityId}
                    </p>
                  </div>
                  <Button
                    danger
                    disabled={busy}
                    onClick={() =>
                      void act('revoke-project', {
                        projectId: grantProject || client.projectId,
                        identityId: g.identityId,
                      })
                    }
                  >
                    撤销授权
                  </Button>
                </li>
              ))}
            </ul>
          </ResourceState>
        </section>
      ) : null}
      <ErrorText value={error} />
      {message ? (
        <p role="status" className="success-message">
          {message}
        </p>
      ) : null}
    </>
  );
}

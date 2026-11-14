'use client';
import { useState } from 'react';
import { Button, Input, Modal, Tabs } from 'antd';
import type {
  CapabilityUsage,
  InstalledSkill,
  McpServer,
  McpToolGrant,
  SkillBinding,
  SkillBundle,
  SkillVersion,
} from '@tandem/core';
import { errorMessage } from './collaboration-types';
import { useUnsavedChanges } from './use-unsaved-changes';
import {
  actProduct,
  Empty,
  ErrorText,
  ResourceState,
  Timestamp,
  useProductResource,
  type ProductClient,
} from './product-api';

type Overview = { skills: InstalledSkill[]; servers: McpServer[] };
const roles = [
  ['team', 'T 组全部成员'],
  ['designer', '产品设计师'],
  ['architect', '技术架构师'],
  ['engineer', '研发工程师'],
];
export function CapabilitiesPanel({ client }: { client: ProductClient }) {
  const overview = useProductResource<Overview>(client, 'capabilities');
  const bindings = useProductResource<{
    skills: SkillBinding[];
    tools: McpToolGrant[];
  }>(client, 'capability-bindings', { project: client.projectId });
  const usage = useProductResource<{ usage: CapabilityUsage[] }>(
    client,
    'capability-usage',
    { project: client.projectId },
  );
  const [installing, setInstalling] = useState(false);
  const [serverEditor, setServerEditor] = useState<McpServer | 'new' | null>(
    null,
  );
  const manager = client.workspace.role !== 'member';
  return (
    <section className="content-panel">
      <div className="section-heading">
        <div>
          <h2>团队能力</h2>
          <p className="muted">
            安装与连接后仍需逐项目授权；已有运行固定版本，停用和撤权阻止后续使用。
          </p>
        </div>
      </div>
      <ResourceState
        error={overview.error}
        loading={!overview.data && overview.loading}
        retry={overview.reload}
      >
        <Tabs
          items={[
            {
              key: 'skills',
              label: `Skills${overview.data ? ` (${overview.data.skills.length})` : ''}`,
              children: (
                <>
                  <div className="section-heading">
                    <p className="muted">
                      工作方法、说明和文本资源组成不可变技能包。
                    </p>
                    {manager ? (
                      <Button
                        type="primary"
                        onClick={() => setInstalling(true)}
                      >
                        安装技能 / 新版本
                      </Button>
                    ) : null}
                  </div>
                  {overview.data?.skills.length ? (
                    <ul className="capability-list">
                      {overview.data.skills.map((skill) => (
                        <SkillRow
                          key={skill.id}
                          client={client}
                          skill={skill}
                          bindings={
                            bindings.data?.skills.filter(
                              (b) => b.skillId === skill.id,
                            ) ?? []
                          }
                        />
                      ))}
                    </ul>
                  ) : (
                    <Empty title="尚未安装技能">
                      先安装技能包，启用后绑定到项目与成员。
                    </Empty>
                  )}
                </>
              ),
            },
            {
              key: 'mcp',
              label: `MCP Server${overview.data ? ` (${overview.data.servers.length})` : ''}`,
              children: (
                <>
                  <div className="section-heading">
                    <p className="muted">
                      测试仅验证连接并发现工具，不执行工具或自动授予权限。
                    </p>
                    {manager ? (
                      <Button
                        type="primary"
                        onClick={() => setServerEditor('new')}
                      >
                        添加 MCP Server
                      </Button>
                    ) : null}
                  </div>
                  {overview.data?.servers.length ? (
                    <ul className="capability-list">
                      {overview.data.servers.map((server) => (
                        <ServerRow
                          key={server.id}
                          client={client}
                          server={server}
                          grants={
                            bindings.data?.tools.filter(
                              (g) => g.serverId === server.id,
                            ) ?? []
                          }
                          edit={() => setServerEditor(server)}
                        />
                      ))}
                    </ul>
                  ) : (
                    <Empty title="尚未添加工具服务">
                      支持远程 HTTP 服务与受控容器中的 stdio 服务。
                    </Empty>
                  )}
                </>
              ),
            },
            {
              key: 'usage',
              label: '当前项目使用记录',
              children: !client.projectId ? (
                <Empty title="先选择项目" />
              ) : (
                <ResourceState
                  error={usage.error}
                  loading={usage.loading}
                  retry={usage.reload}
                >
                  {usage.data?.usage.length ? (
                    <ul className="product-rows">
                      {usage.data.usage.map((item) => (
                        <li key={item.id}>
                          <div>
                            <strong>
                              {item.kind === 'skill' ? '技能' : '工具'} ·{' '}
                              {item.summary}
                            </strong>
                            <p className="muted">
                              {item.status === 'succeeded'
                                ? '成功'
                                : item.status === 'unknown'
                                  ? '结果未知'
                                  : '失败'}{' '}
                              · <Timestamp value={item.createdAt} />
                            </p>
                            <p className="muted">
                              固定版本：<code>{item.version}</code>
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty title="还没有能力调用记录" />
                  )}
                </ResourceState>
              ),
            },
          ]}
        />
      </ResourceState>
      {bindings.error && client.projectId ? (
        <ErrorText value={bindings.error} />
      ) : null}
      {installing ? (
        <SkillInstaller client={client} close={() => setInstalling(false)} />
      ) : null}
      {serverEditor ? (
        <ServerEditor
          client={client}
          server={serverEditor === 'new' ? undefined : serverEditor}
          close={() => setServerEditor(null)}
        />
      ) : null}
    </section>
  );
}
function SkillRow({
  client,
  skill,
  bindings,
}: {
  client: ProductClient;
  skill: InstalledSkill;
  bindings: SkillBinding[];
}) {
  const [versionId, setVersionId] = useState(
    skill.activeVersionId ?? skill.versions[0]?.id ?? '',
  );
  const [role, setRole] = useState('team');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState('');
  const version = skill.versions.find((v) => v.id === versionId);
  const manager = client.workspace.role !== 'member';
  async function act(command: string, input: Record<string, unknown>) {
    setBusy(command);
    setError('');
    setMessage('');
    try {
      await actProduct(client, command, { skillId: skill.id, ...input });
      setMessage('技能设置已保存。');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  return (
    <li>
      <details>
        <summary>
          <span>
            <strong>{skill.name}</strong>
            <span className="muted">
              {' '}
              · {skill.enabled ? '已启用' : '已停用'} ·{' '}
              {skill.versions.find((v) => v.id === skill.activeVersionId)
                ?.version ?? '未选择生效版本'}
            </span>
          </span>
        </summary>
        <p>{skill.description}</p>
        <div className="inline-form">
          <label className="field grow">
            查看版本
            <select
              value={versionId}
              onChange={(e) => {
                setVersionId(e.target.value);
                setPermissions([]);
              }}
            >
              {skill.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.version}
                  {v.id === skill.activeVersionId ? ' · 当前生效' : ''}
                </option>
              ))}
            </select>
          </label>
          {manager ? (
            <>
              <Button
                disabled={!!busy || !versionId}
                onClick={() => void act('activate-skill', { versionId })}
              >
                切换生效版本
              </Button>
              <Button
                disabled={!!busy}
                onClick={() =>
                  void act('toggle-skill', { enabled: !skill.enabled })
                }
              >
                {skill.enabled ? '停用技能' : '启用技能'}
              </Button>
            </>
          ) : null}
        </div>
        {version ? <SkillVersionDetail version={version} /> : null}
        {manager && version ? (
          <form
            className="binding-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act('bind-skill', {
                versionId,
                projectId: client.projectId,
                teamId: client.team.id,
                agentRole: role === 'team' ? null : role,
                permissions,
                enabled: true,
              });
            }}
          >
            <h3>授权当前版本</h3>
            <p className="form-help">
              绑定到当前项目。声明的权限需逐项批准，依赖仍须满足。
            </p>
            <label className="field">
              成员范围
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {roles.map(([v, n]) => (
                  <option value={v} key={v}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {version.permissions.length ? (
              version.permissions.map((p) => (
                <label className="check-field" key={p}>
                  <input
                    type="checkbox"
                    checked={permissions.includes(p)}
                    onChange={(e) =>
                      setPermissions((current) =>
                        e.target.checked
                          ? [...current, p]
                          : current.filter((v) => v !== p),
                      )
                    }
                  />
                  {p}
                </label>
              ))
            ) : (
              <p className="muted">此版本未声明额外权限。</p>
            )}
            <Button
              htmlType="submit"
              disabled={
                !!busy ||
                !client.projectId ||
                !skill.enabled ||
                version.permissions.some((p) => !permissions.includes(p))
              }
            >
              绑定到当前项目
            </Button>
          </form>
        ) : null}
        {bindings.length ? (
          <ul className="product-rows">
            {bindings.map((binding) => (
              <li key={binding.id}>
                <div>
                  <strong>
                    {binding.agentRole
                      ? roles.find(([r]) => r === binding.agentRole)?.[1]
                      : 'T 组全部成员'}
                  </strong>
                  <p className="muted">
                    {binding.enabled ? '绑定有效' : '绑定已撤销'} · 版本{' '}
                    {skill.versions.find((v) => v.id === binding.versionId)
                      ?.version ?? binding.versionId}
                  </p>
                </div>
                {manager && binding.enabled ? (
                  <Button
                    disabled={!!busy}
                    onClick={() =>
                      void act('bind-skill', { ...binding, enabled: false })
                    }
                  >
                    撤销绑定
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {manager ? (
          <div className="row-actions">
            {confirm ? (
              <>
                <span>卸载将阻止后续加载，保留版本和审计记录。</span>
                <Button disabled={!!busy} onClick={() => setConfirm(false)}>
                  保留技能
                </Button>
                <Button
                  danger
                  disabled={!!busy}
                  onClick={() => void act('uninstall-skill', {})}
                >
                  确认卸载
                </Button>
              </>
            ) : (
              <Button danger disabled={!!busy} onClick={() => setConfirm(true)}>
                卸载技能
              </Button>
            )}
          </div>
        ) : null}
        <ErrorText value={error} />
        {message ? (
          <p role="status" className="success-message">
            {message}
          </p>
        ) : null}
      </details>
    </li>
  );
}
function SkillVersionDetail({ version }: { version: SkillVersion }) {
  return (
    <>
      <dl className="compact-details">
        <div>
          <dt>来源</dt>
          <dd>
            {version.source.kind === 'git'
              ? `${version.source.repository} · ${version.source.commit} · ${version.source.path}`
              : version.source.label}
          </dd>
        </div>
        <div>
          <dt>内容摘要</dt>
          <dd>
            <code>{version.contentHash}</code>
          </dd>
        </div>
        <div>
          <dt>依赖</dt>
          <dd>{version.dependencies.join('、') || '无额外依赖'}</dd>
        </div>
      </dl>
      <details className="document-version">
        <summary>
          说明与资源（{Object.keys(version.files).length} 个文件）
        </summary>
        {Object.entries(version.files).map(([path, content]) => (
          <details key={path}>
            <summary>{path}</summary>
            <pre className="document-content">{content}</pre>
          </details>
        ))}
      </details>
    </>
  );
}
function SkillInstaller({
  client,
  close,
}: {
  client: ProductClient;
  close: () => void;
}) {
  const [bundle, setBundle] = useState<SkillBundle>({
    name: '',
    version: '1.0.0',
    description: '',
    source: { kind: 'upload', label: '本地技能包' },
    permissions: [],
    dependencies: [],
    files: { 'SKILL.md': '' },
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { requestClose, confirmation } = useUnsavedChanges(bundle, close, busy);
  async function importFile(file: File | undefined) {
    if (!file) return;
    setError('');
    try {
      if (file.size > 1100000) throw new Error('技能包不得超过 1 MiB。');
      const value = JSON.parse(await file.text());
      if (
        !value ||
        typeof value.name !== 'string' ||
        !value.files ||
        !value.source
      )
        throw new Error('请选择完整技能包 JSON。');
      setBundle(value);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function install() {
    setBusy(true);
    setError('');
    try {
      await actProduct(client, 'install-skill', { bundle });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        title="安装技能 / 新版本"
        open
        onCancel={requestClose}
        footer={null}
        width={760}
      >
        <p className="muted">
          技能包包含 SKILL.md、版本、来源、权限和资源。安装不执行脚本。
        </p>
        <p>
          <a href="/examples/quality-review.skill.json" download>
            下载技能包模板
          </a>
        </p>
        <label className="field">
          导入完整技能包
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void install();
          }}
        >
          <div className="form-grid">
            <label className="field">
              技能名称
              <Input
                required
                maxLength={80}
                value={bundle.name}
                onChange={(e) =>
                  setBundle((v) => ({ ...v, name: e.target.value }))
                }
              />
            </label>
            <label className="field">
              版本
              <Input
                required
                maxLength={80}
                value={bundle.version}
                onChange={(e) =>
                  setBundle((v) => ({ ...v, version: e.target.value }))
                }
              />
            </label>
          </div>
          <label className="field">
            用途说明
            <Input
              required
              value={bundle.description}
              maxLength={2000}
              onChange={(e) =>
                setBundle((v) => ({ ...v, description: e.target.value }))
              }
            />
          </label>
          <label className="field">
            安装来源
            <select
              value={bundle.source.kind}
              onChange={(e) =>
                setBundle((v) => ({
                  ...v,
                  source:
                    e.target.value === 'git'
                      ? { kind: 'git', repository: '', commit: '', path: '' }
                      : { kind: 'upload', label: '本地技能包' },
                }))
              }
            >
              <option value="upload">本地技能包</option>
              <option value="git">固定提交的 Git 仓库</option>
            </select>
          </label>
          {bundle.source.kind === 'git' ? (
            <div>
              {(['repository', 'commit', 'path'] as const).map((key) => (
                <label className="field" key={key}>
                  {
                    {
                      repository: 'HTTPS 仓库地址',
                      commit: '完整提交 SHA（40 位）',
                      path: '技能相对目录',
                    }[key]
                  }
                  <Input
                    value={
                      bundle.source.kind === 'git' ? bundle.source[key] : ''
                    }
                    required={key !== 'path'}
                    onChange={(e) =>
                      setBundle((v) =>
                        v.source.kind === 'git'
                          ? {
                              ...v,
                              source: { ...v.source, [key]: e.target.value },
                            }
                          : v,
                      )
                    }
                  />
                </label>
              ))}
            </div>
          ) : (
            <label className="field">
              来源说明
              <Input
                required
                value={bundle.source.label}
                onChange={(e) =>
                  setBundle((v) =>
                    v.source.kind === 'upload'
                      ? {
                          ...v,
                          source: { kind: 'upload', label: e.target.value },
                        }
                      : v,
                  )
                }
              />
            </label>
          )}
          <label className="field">
            SKILL.md
            <Input.TextArea
              rows={8}
              required
              value={bundle.files['SKILL.md'] ?? ''}
              onChange={(e) =>
                setBundle((v) => ({
                  ...v,
                  files: { ...v.files, 'SKILL.md': e.target.value },
                }))
              }
            />
          </label>
          <p className="form-help">
            包含 name、description 的 YAML
            元信息。导入包中的其他资源会一并保存；仓库安装将验证并读取固定提交的文件。
          </p>
          <p className="muted">
            声明权限：{bundle.permissions.join('、') || '无'} · 依赖：
            {bundle.dependencies.join('、') || '无'} ·{' '}
            {Object.keys(bundle.files).length} 个文件
          </p>
          <ErrorText value={error} />
          <div className="dialog-actions">
            <Button disabled={busy} onClick={requestClose}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" loading={busy}>
              验证并安装
            </Button>
          </div>
        </form>
      </Modal>
      {confirmation}
    </>
  );
}
function ServerEditor({
  client,
  server,
  close,
}: {
  client: ProductClient;
  server: McpServer | undefined;
  close: () => void;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [type, setType] = useState(server?.connection.type ?? 'http');
  const [url, setUrl] = useState(
    server?.connection.type === 'http' ? server.connection.url : '',
  );
  const [image, setImage] = useState(
    server?.connection.type === 'stdio' ? server.connection.image : '',
  );
  const [command, setCommand] = useState(
    server?.connection.type === 'stdio'
      ? JSON.stringify(server.connection.command)
      : '["node", "server.js"]',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { requestClose, confirmation } = useUnsavedChanges(
    { name, type, url, image, command },
    close,
    busy,
  );
  async function save() {
    setBusy(true);
    setError('');
    try {
      const connection =
        type === 'http'
          ? { type: 'http', url }
          : { type: 'stdio', image, command: JSON.parse(command) };
      await actProduct(client, 'save-server', {
        name,
        connection,
        ...(server ? { id: server.id, expectedRevision: server.revision } : {}),
      });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        title={server ? '编辑 MCP Server' : '添加 MCP Server'}
        open
        onCancel={requestClose}
        footer={null}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field">
            服务名称
            <Input
              required
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            连接方式
            <select
              value={type}
              onChange={(e) => setType(e.target.value as 'http' | 'stdio')}
            >
              <option value="http">远程 HTTP</option>
              <option value="stdio">受控容器 stdio</option>
            </select>
          </label>
          {type === 'http' ? (
            <label className="field">
              服务地址
              <Input
                required
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://tools.example.com/mcp"
              />
            </label>
          ) : (
            <>
              <label className="field">
                允许的容器镜像
                <Input
                  required
                  value={image}
                  onChange={(e) => setImage(e.target.value)}
                />
              </label>
              <label className="field">
                容器内命令（JSON 数组）
                <Input.TextArea
                  required
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  rows={3}
                />
              </label>
              <p className="form-help">
                镜像须在部署配置允许范围内。以无宿主挂载、限资源容器运行。
              </p>
            </>
          )}
          <p className="form-help">
            凭证在保存后按本人账号单独配置，不会继承注册者凭证。编辑连接将使旧工具授权失效，须重新测试和授权。
          </p>
          <ErrorText value={error} />
          <div className="dialog-actions">
            <Button onClick={requestClose} disabled={busy}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" loading={busy}>
              保存服务
            </Button>
          </div>
        </form>
      </Modal>
      {confirmation}
    </>
  );
}
function ServerRow({
  client,
  server,
  grants,
  edit,
}: {
  client: ProductClient;
  server: McpServer;
  grants: McpToolGrant[];
  edit: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [credential, setCredential] = useState('');
  const [role, setRole] = useState('team');
  const [effects, setEffects] = useState<Record<string, string>>({});
  const [tool, setTool] = useState('');
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState('');
  const [remove, setRemove] = useState(false);
  const manager = client.workspace.role !== 'member';
  async function act(
    command: string,
    input: Record<string, unknown> = {},
    success = '设置已更新。',
  ) {
    setBusy(command);
    setError('');
    setMessage('');
    try {
      const value = await actProduct<unknown>(client, command, {
        serverId: server.id,
        ...input,
      });
      setMessage(success);
      if (command === 'call-tool') setResult(JSON.stringify(value, null, 2));
      if (command === 'server-credential') setCredential('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  return (
    <li>
      <details>
        <summary>
          <span>
            <strong>{server.name}</strong>
            <span className="muted">
              {' '}
              · {server.enabled ? '已启用' : '已停用'} ·{' '}
              {
                {
                  untested: '尚未测试',
                  ready: '连接正常',
                  unavailable: '连接失败',
                  changed: '工具定义已变化',
                }[server.status]
              }
            </span>
          </span>
        </summary>
        <p className="muted">
          {server.connection.type === 'http'
            ? server.connection.url
            : `容器 ${server.connection.image}`}{' '}
          · 配置版本 {server.revision}
        </p>
        <p className="muted">
          最近检查：
          <Timestamp value={server.checkedAt} />
        </p>
        {manager ? (
          <div className="row-actions">
            <Button
              disabled={!!busy}
              loading={busy === 'test-server'}
              onClick={() =>
                void act(
                  'test-server',
                  {},
                  '连接与工具发现已完成；未执行工具。',
                )
              }
            >
              测试连接
            </Button>
            <Button disabled={!!busy} onClick={edit}>
              编辑连接
            </Button>
            <Button
              disabled={!!busy}
              onClick={() =>
                void act('toggle-server', { enabled: !server.enabled })
              }
            >
              {server.enabled ? '停用服务' : '启用服务'}
            </Button>
            <Button
              danger
              disabled={!!busy}
              onClick={() => setRemove((v) => !v)}
            >
              移除服务
            </Button>
          </div>
        ) : null}
        {remove ? (
          <div className="member-removal">
            <p>移除后将撤销此服务的后续调用。保留历史记录。</p>
            <div className="row-actions">
              <Button onClick={() => setRemove(false)}>保留服务</Button>
              <Button
                danger
                disabled={!!busy}
                onClick={() => void act('remove-server')}
              >
                确认移除
              </Button>
            </div>
          </div>
        ) : null}
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'server-credential',
              { credential },
              '本人凭证已加密保存。',
            );
          }}
        >
          <label className="field grow">
            本人访问凭证（{server.credentialConfigured ? '已配置' : '未配置'}）
            <Input.Password
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete="new-password"
              placeholder="可选；只保存为本人凭证"
              disabled={!!busy}
            />
          </label>
          <Button htmlType="submit" disabled={!!busy || !credential.trim()}>
            保存本人凭证
          </Button>
          {server.credentialConfigured ? (
            <Button
              disabled={!!busy}
              onClick={() =>
                void act('server-credential', { credential: null })
              }
            >
              清除本人凭证
            </Button>
          ) : null}
        </form>
        {server.tools.length ? (
          <>
            <h3 className="subsection-heading">可用工具与当前项目授权</h3>
            {manager ? (
              <label className="field">
                授权成员范围
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  {roles.map(([v, n]) => (
                    <option value={v} key={v}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <ul className="product-rows tool-list">
              {server.tools.map((t) => (
                <li key={t.name}>
                  <div className="grow">
                    <strong>{t.name}</strong>
                    <p>{t.description}</p>
                    <details>
                      <summary>参数定义与版本</summary>
                      <pre>{JSON.stringify(t.inputSchema, null, 2)}</pre>
                      <p>
                        <code>{t.schemaHash}</code>
                      </p>
                    </details>
                    <p className="muted">
                      {grants
                        .filter((g) => g.toolName === t.name && g.enabled)
                        .map(
                          (g) =>
                            `${g.agentRole ?? '整组'} · ${g.effect === 'read' ? '只读' : g.effect === 'write' ? '写入须审批' : '未分类'}${g.revision !== server.revision || g.schemaHash !== t.schemaHash ? ' · 定义已变化，授权失效' : ''}`,
                        )
                        .join('；') || '当前项目未授权'}
                    </p>
                    {manager ? (
                      <div className="row-actions">
                        <select
                          aria-label={`${t.name} 副作用分类`}
                          value={effects[t.name] ?? 'unknown'}
                          onChange={(e) =>
                            setEffects((v) => ({
                              ...v,
                              [t.name]: e.target.value,
                            }))
                          }
                        >
                          <option value="unknown">未分类 · 禁用</option>
                          <option value="read">只读</option>
                          <option value="write">写入 · 必须审批</option>
                        </select>
                        <Button
                          disabled={
                            !!busy || !client.projectId || !server.enabled
                          }
                          onClick={() =>
                            void act('grant-tool', {
                              projectId: client.projectId,
                              teamId: client.team.id,
                              agentRole: role === 'team' ? null : role,
                              toolName: t.name,
                              effect: effects[t.name] ?? 'unknown',
                              enabled: true,
                            })
                          }
                        >
                          保存工具授权
                        </Button>
                        {grants
                          .filter((g) => g.toolName === t.name && g.enabled)
                          .map((g) => (
                            <Button
                              key={g.id}
                              disabled={!!busy}
                              onClick={() =>
                                void act('grant-tool', { ...g, enabled: false })
                              }
                            >
                              撤销 {g.agentRole ?? '整组'} 授权
                            </Button>
                          ))}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                try {
                  const argumentsValue = JSON.parse(args);
                  void act(
                    'call-tool',
                    {
                      projectId: client.projectId,
                      teamId: client.team.id,
                      agentRole: role === 'team' ? 'engineer' : role,
                      toolName: tool,
                      arguments: argumentsValue,
                      requestId: crypto.randomUUID(),
                    },
                    '请求已处理；写工具请到 Agents → 运行与执行记录，选择对应禅道项目后审阅草案。',
                  );
                } catch {
                  setError('工具参数须为有效 JSON 对象。');
                }
              }}
            >
              <h3 className="subsection-heading">按授权试用工具</h3>
              <div className="form-grid">
                <label className="field">
                  工具
                  <select
                    value={tool}
                    onChange={(e) => setTool(e.target.value)}
                    required
                  >
                    <option value="">选择工具</option>
                    {server.tools.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  执行角色
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    {roles
                      .filter(([r]) => r !== 'team')
                      .map(([v, n]) => (
                        <option key={v} value={v}>
                          {n}
                        </option>
                      ))}
                    <option value="team">研发工程师（整组授权）</option>
                  </select>
                </label>
              </div>
              <label className="field">
                工具参数（JSON 对象）
                <Input.TextArea
                  rows={3}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </label>
              <div className="row-actions">
                <Button
                  htmlType="submit"
                  disabled={!!busy || !tool || !client.projectId}
                  loading={busy === 'call-tool'}
                >
                  提交调用
                </Button>
              </div>
            </form>
            {result ? <pre className="tool-result">{result}</pre> : null}
          </>
        ) : (
          <p className="muted">测试连接后显示工具；工具默认未分类、未授权。</p>
        )}
        <ErrorText value={error} />
        {message ? (
          <p role="status" className="success-message">
            {message}
          </p>
        ) : null}
      </details>
    </li>
  );
}

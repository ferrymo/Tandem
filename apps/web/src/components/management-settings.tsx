'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Button, Drawer, Input, Modal, Select, Tabs } from 'antd';
import type {
  ConnectorReadResult,
  ConnectorTestResult,
  InstalledSkill,
  McpServer,
  WorkAgent,
  WorkConnector,
  WorkMenu,
  WorkModelChannel,
  WorkPlugin,
  WorkRole,
  WorkSandbox,
  WorkSnapshot,
  WorkTeam,
} from '@tandem/core';
import {
  api,
  errorMessage,
  roleNames,
  type Member,
  type User,
} from './collaboration-types';
import {
  actProduct,
  Empty,
  ErrorText,
  ResourceState,
  Timestamp,
  useProductResource,
  type ProductClient,
  type ProjectItem,
} from './product-api';
import { CapabilitiesPanel } from './capabilities-panel';
import { DeliveryPanel } from './delivery-panel';
import { MembersDialog } from './workspace-dialogs';
import {
  guardUnsavedNavigation,
  useUnsavedChanges,
} from './use-unsaved-changes';

type Command = (
  command: string,
  input: Record<string, unknown>,
) => Promise<unknown>;
type SettingsProps = {
  section: 'agents' | 'connectors' | 'admin';
  client: ProductClient;
  data: WorkSnapshot;
  onCommand: Command;
};
type ConfigKind =
  | 'agent'
  | 'sandbox'
  | 'model-channel'
  | 'role'
  | 'menu'
  | 'plugin'
  | 'connector'
  | 'team';
type ConfigRecord =
  | WorkAgent
  | WorkSandbox
  | WorkModelChannel
  | WorkRole
  | WorkMenu
  | WorkPlugin
  | WorkConnector
  | WorkTeam;
type Choice = { value: string; label: string };
type Field = {
  key: string;
  label: string;
  type?:
    'text' | 'textarea' | 'number' | 'select' | 'multiple' | 'lines' | 'check';
  required?: boolean;
  help?: string;
  options?: Choice[];
  min?: number;
  step?: number;
  maxLength?: number;
  disabled?: boolean;
};
type EditorState = { kind: ConfigKind; record?: ConfigRecord };
type ConnectorEvidence = {
  id: string;
  version: number;
  actorId: string;
  credentialUpdatedAt: string;
};

const kindNames: Record<ConfigKind, string> = {
  agent: 'Agent Bot',
  sandbox: '沙箱环境',
  'model-channel': '模型渠道',
  role: '角色',
  menu: '菜单',
  plugin: '插件',
  connector: '禅道连接器',
  team: 'Bot Team',
};
const protocolOptions: Choice[] = [
  { value: 'openai', label: 'OpenAI 兼容协议' },
  { value: 'anthropic', label: 'Anthropic 协议' },
  { value: 'ollama', label: 'Ollama 协议' },
];
const menuOptions = [
  ['projects', '项目'],
  ['documents', '文档'],
  ['tasks', '任务'],
  ['analysis', '分析'],
  ['agents', 'Agents'],
  ['connectors', '连接器'],
  ['admin', '后台管理'],
].map(([value, label]) => ({ value: value!, label: label! }));
const protocolName = (value: string) =>
  protocolOptions.find((item) => item.value === value)?.label ?? value;
const externalTaskStatuses: Record<string, string> = {
  wait: '未开始',
  doing: '进行中',
  done: '已完成',
  pause: '已暂停',
  cancel: '已取消',
  closed: '已结束',
};
const permissionOptions: Choice[] = [
  { value: 'project.create', label: '创建项目' },
  { value: 'project.manage', label: '维护项目及成员' },
  { value: 'document.manage', label: '维护共享文档' },
  { value: 'team.manage', label: '维护协作团队' },
  { value: 'agent.manage', label: '维护 Agent Bots' },
  { value: 'config.manage', label: '维护连接器与模型配置' },
];
function canManage(data: WorkSnapshot, permission: string) {
  return (
    data.canAdmin ||
    (data as WorkSnapshot & { permissions?: string[] }).permissions?.includes(
      permission,
    ) === true
  );
}
function hasCredential(data: WorkSnapshot, kind: string, id: string) {
  return (
    (
      data as WorkSnapshot & {
        secretStates?: { kind: string; id: string; configured: boolean }[];
      }
    ).secretStates?.some(
      (item) => item.kind === kind && item.id === id && item.configured,
    ) ?? false
  );
}
function connectorCredentialStamp(data: WorkSnapshot, id: string) {
  return (
    (
      data as WorkSnapshot & {
        secretStates?: { kind: string; id: string; updatedAt?: string }[];
      }
    ).secretStates?.find((item) => item.kind === 'connector' && item.id === id)
      ?.updatedAt ?? ''
  );
}
function isCurrentConnectorEvidence(
  data: WorkSnapshot,
  evidence: ConnectorEvidence,
) {
  return (
    evidence.actorId === data.actorId &&
    evidence.credentialUpdatedAt ===
      connectorCredentialStamp(data, evidence.id) &&
    data.connectors.some(
      (connector) =>
        connector.id === evidence.id &&
        connector.enabled &&
        connector.version === evidence.version,
    )
  );
}

function BotAvatar({ value, name }: { value: string; name: string }) {
  const [failed, setFailed] = useState('');
  const image = /^https?:\/\//i.test(value) && failed !== value;
  return (
    <span className="management-avatar" aria-hidden="true">
      {image ? (
        <img
          src={value}
          alt=""
          referrerPolicy="no-referrer"
          width={40}
          height={40}
          onError={() => setFailed(value)}
        />
      ) : /^https?:\/\//i.test(value) ? (
        name.slice(0, 1)
      ) : (
        value || name.slice(0, 1)
      )}
    </span>
  );
}

export function ManagementSettings(props: SettingsProps) {
  return props.section === 'agents' ? (
    <AgentManagement {...props} />
  ) : props.section === 'connectors' ? (
    <ConnectorManagement {...props} />
  ) : (
    <Administration {...props} />
  );
}

function AgentManagement({ client, data, onCommand }: SettingsProps) {
  const [tab, setTab] = useState('bots');
  const [query, setQuery] = useState('');
  const [enabledFilter, setEnabledFilter] = useState('all');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [success, setSuccess] = useState('');
  const capabilities = useProductResource<{
    skills: InstalledSkill[];
    servers: McpServer[];
  }>(client, 'capabilities');
  const fieldOptions = {
    skills:
      capabilities.data?.skills.map((item) => ({
        value: item.id,
        label: item.name,
      })) ?? [],
    servers:
      capabilities.data?.servers.map((item) => ({
        value: item.id,
        label: item.name,
      })) ?? [],
  };
  const agents = data.agents.filter(
    (agent) =>
      `${agent.name} ${agent.description}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (enabledFilter === 'all' ||
        agent.enabled === (enabledFilter === 'enabled')),
  );
  return (
    <div className="management-settings">
      <Tabs
        activeKey={tab}
        onChange={(next) => guardUnsavedNavigation(() => setTab(next))}
        items={[
          { key: 'bots', label: 'Agent Bots' },
          { key: 'teams', label: 'Bot Teams' },
          { key: 'capabilities', label: 'Skills / MCP / Tools' },
          { key: 'sandboxes', label: '沙箱环境' },
          { key: 'activity', label: '运行与执行记录' },
        ]}
      />
      {success ? (
        <p role="status" className="success-message">
          {success}
        </p>
      ) : null}
      {tab === 'bots' ? (
        <section className="management-section">
          <SectionHeader
            title="Agent Bots"
            description="为项目选择合适的 AI 协作者，集中维护模型与能力配置。"
            action={
              canManage(data, 'agent.manage') ? (
                <Button
                  type="primary"
                  onClick={() => setEditor({ kind: 'agent' })}
                >
                  新建 Agent
                </Button>
              ) : undefined
            }
          />
          <p className="management-note">
            这里维护 Bot 注册配置；当前可执行的 T
            组及其真实配置在“运行与执行记录”中管理。
          </p>
          <div className="list-toolbar">
            <Input
              aria-label="搜索 Agent"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称或职责"
              allowClear
            />
            <Select
              aria-label="Agent 配置状态"
              value={enabledFilter}
              onChange={setEnabledFilter}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'enabled', label: '配置已启用' },
                { value: 'disabled', label: '配置已停用' },
              ]}
            />
          </div>
          {agents.length ? (
            <div className="management-agent-grid">
              {agents.map((agent) => (
                <article className="management-agent-card" key={agent.id}>
                  <div className="management-card-header">
                    <BotAvatar value={agent.avatar} name={agent.name} />
                    <div className="grow">
                      <h3>{agent.name}</h3>
                      <span className="muted">
                        {agent.enabled ? '配置已启用' : '配置已停用'}
                      </span>
                    </div>
                    {canManage(data, 'agent.manage') ? (
                      <Button
                        size="small"
                        onClick={() =>
                          setEditor({ kind: 'agent', record: agent })
                        }
                      >
                        配置
                      </Button>
                    ) : null}
                  </div>
                  <p>{agent.description || '尚未填写介绍'}</p>
                  <dl className="management-facts">
                    <div>
                      <dt>模型</dt>
                      <dd>
                        {agent.model || '未配置'} ·{' '}
                        {protocolName(agent.protocol)}
                      </dd>
                    </div>
                    <div>
                      <dt>渠道</dt>
                      <dd>
                        {data.modelChannels.find(
                          (item) => item.id === agent.modelChannelId,
                        )?.name || '未选择'}
                      </dd>
                    </div>
                    <div>
                      <dt>Bot Team</dt>
                      <dd>
                        {data.teams.find((item) => item.id === agent.teamId)
                          ?.name || '未分组'}
                      </dd>
                    </div>
                    <div>
                      <dt>沙箱</dt>
                      <dd>
                        {data.sandboxes.find(
                          (item) => item.id === agent.sandboxId,
                        )?.name || '未配置'}
                      </dd>
                    </div>
                    <div>
                      <dt>Skills</dt>
                      <dd>
                        {agent.skillIds.length
                          ? agent.skillIds
                              .map(
                                (id) =>
                                  fieldOptions.skills.find(
                                    (item) => item.value === id,
                                  )?.label || '不可用技能',
                              )
                              .join('、')
                          : '未绑定'}
                      </dd>
                    </div>
                    <div>
                      <dt>MCP Server</dt>
                      <dd>
                        {agent.mcpServerIds.length
                          ? agent.mcpServerIds
                              .map(
                                (id) =>
                                  fieldOptions.servers.find(
                                    (item) => item.value === id,
                                  )?.label || '不可用服务',
                              )
                              .join('、')
                          : '未绑定'}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          ) : data.agents.length ? (
            <Empty title="没有匹配的 Agent">
              调整名称或状态筛选，再查看其他 Agent。
            </Empty>
          ) : (
            <Empty title="添加第一个 Agent Bot">
              设置名称、职责与模型，再选择它使用的技能、工具和环境。
            </Empty>
          )}
          {capabilities.error ? (
            <ErrorText
              value={`技能与工具列表读取失败：${capabilities.error}`}
            />
          ) : null}
        </section>
      ) : tab === 'teams' ? (
        <ConfigurationList
          kind="team"
          title="Bot Teams"
          description="按交付职责组织协作成员，也可用于团队文档的可见范围。"
          records={data.teams}
          canAdmin={canManage(data, 'team.manage')}
          canEditRecord={(record) =>
            data.canAdmin || (record as WorkTeam).ownerId === data.actorId
          }
          edit={setEditor}
          render={(item) => {
            const team = item as WorkTeam;
            return (
              <>
                <strong>{team.name}</strong>
                <p className="muted">{team.description || '尚未填写说明'}</p>
                <p>
                  {team.memberIds
                    .map(
                      (id) =>
                        data.participants.find((member) => member.id === id)
                          ?.name || '不可用成员',
                    )
                    .join('、') || '尚未选择成员'}
                </p>
              </>
            );
          }}
        />
      ) : tab === 'capabilities' ? (
        <ExternalProjectPanel client={client} mode="capabilities" />
      ) : tab === 'sandboxes' ? (
        <ConfigurationList
          kind="sandbox"
          title="沙箱环境"
          description="维护隔离执行环境的配置。环境配置保存后，仍需执行器接入与验证。"
          records={data.sandboxes}
          canAdmin={canManage(data, 'config.manage')}
          edit={setEditor}
          render={(item) => {
            const sandbox = item as WorkSandbox;
            return (
              <>
                <strong>{sandbox.name}</strong>
                <p className="muted">
                  {sandbox.image || '未填写镜像'} · {sandbox.cpu} CPU ·{' '}
                  {sandbox.memoryMb} MiB
                </p>
                <p>
                  {sandbox.networkPolicy === 'none' ? '禁止网络' : '受限网络'} ·{' '}
                  {sandbox.enabled ? '配置已启用' : '配置已停用'} ·
                  尚未验证实例运行
                </p>
              </>
            );
          }}
        />
      ) : (
        <ExternalProjectPanel
          client={client}
          mode="runs"
          onCapabilities={() => setTab('capabilities')}
        />
      )}
      {editor ? (
        <ConfigurationEditor
          key={`${editor.kind}:${editor.record?.id || 'new'}`}
          state={editor}
          data={data}
          options={fieldOptions}
          onCommand={onCommand}
          close={() => setEditor(null)}
          saved={() => {
            setSuccess(`${kindNames[editor.kind]}配置已保存。`);
            setEditor(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ConnectorManagement({ client, data, onCommand }: SettingsProps) {
  const [tab, setTab] = useState('configuration');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [checked, setChecked] = useState<
    (ConnectorEvidence & { result: ConnectorTestResult }) | null
  >(null);
  const [read, setRead] = useState<
    (ConnectorEvidence & { result: ConnectorReadResult }) | null
  >(null);
  const [project, setProject] = useState('');
  const activeChecked =
    checked && isCurrentConnectorEvidence(data, checked) ? checked : null;
  const activeRead =
    read && isCurrentConnectorEvidence(data, read) ? read : null;
  useEffect(() => {
    if (!read) return;
    const delay = Date.parse(read.result.expiresAt) - Date.now();
    const timer = window.setTimeout(
      () => {
        setRead(null);
        setMessage('上次读取已过期，请重新读取禅道数据。');
      },
      Math.max(0, delay),
    );
    return () => window.clearTimeout(timer);
  }, [read]);
  async function inspect(
    connector: WorkConnector,
    mode: 'test' | 'read',
    projectId = '',
  ) {
    if (busy) return;
    setBusy(`${connector.id}:${mode}`);
    setError('');
    setMessage('');
    const evidence: ConnectorEvidence = {
      id: connector.id,
      version: connector.version,
      actorId: data.actorId,
      credentialUpdatedAt: connectorCredentialStamp(data, connector.id),
    };
    if (mode === 'read') setRead(null);
    else setChecked(null);
    try {
      if (mode === 'test') {
        const result = (await onCommand('test-connector', {
          id: connector.id,
        })) as ConnectorTestResult;
        if (!result.ok || !result.database?.readOnly)
          throw new Error('服务未确认只读连接验证结果，请重试。');
        setChecked({ ...evidence, result });
      } else {
        const result = (await onCommand('read-connector', {
          id: connector.id,
          limit: 100,
          ...(projectId ? { projectId } : {}),
        })) as ConnectorReadResult;
        if (
          result.kind !== 'external-read' ||
          result.connectorId !== connector.id ||
          !Array.isArray(result.projects) ||
          !Array.isArray(result.tasks) ||
          !Number.isFinite(Date.parse(result.expiresAt))
        )
          throw new Error('读取结果不完整，请重试。');
        setRead({ ...evidence, result });
        setProject(projectId);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="management-settings">
      <Tabs
        activeKey={tab}
        onChange={(next) => guardUnsavedNavigation(() => setTab(next))}
        items={[
          { key: 'configuration', label: '连接器配置' },
          { key: 'projects', label: '禅道项目连接' },
        ]}
      />
      {tab === 'configuration' ? (
        <>
          <ConfigurationList
            kind="connector"
            title="业务连接器"
            description="禅道为首个协作系统，其他工具可在后续接入。"
            records={data.connectors}
            canAdmin={canManage(data, 'config.manage')}
            edit={setEditor}
            extraAction={(item) =>
              data.canAdmin ? (
                <div className="row-actions">
                  <Button
                    disabled={!!busy || !(item as WorkConnector).enabled}
                    loading={busy === `${item.id}:test`}
                    onClick={() => void inspect(item as WorkConnector, 'test')}
                  >
                    测试只读连接
                  </Button>
                  <Button
                    disabled={!!busy || !(item as WorkConnector).enabled}
                    loading={busy === `${item.id}:read`}
                    onClick={() => void inspect(item as WorkConnector, 'read')}
                  >
                    读取禅道数据
                  </Button>
                </div>
              ) : null
            }
            render={(item) => {
              const connector = item as WorkConnector;
              return (
                <>
                  <strong>{connector.name}</strong>
                  <p>{connector.baseUrl}</p>
                  <p className="muted">
                    只读数据库：{connector.databaseHost || '未配置'}
                    {connector.databaseHost ? `:${connector.databasePort}` : ''}
                    {connector.databaseName
                      ? ` / ${connector.databaseName}`
                      : ''}{' '}
                    · {connector.databaseUser || '未填写账号'}
                  </p>
                  <p className="muted">
                    {connector.enabled ? '配置已启用' : '配置已停用'} ·
                    {activeChecked?.id === connector.id ? (
                      <>
                        只读连接已验证 ·{' '}
                        <Timestamp value={activeChecked.result.checkedAt} />
                      </>
                    ) : (
                      '只读连接待验证'
                    )}
                  </p>
                </>
              );
            }}
          />
          <p className="management-note">
            在编辑中保存本人禅道账号、密码与只读数据库密码，再测试连接或按需读取。读取结果保留来源和过期时间，项目任务仍以禅道为事实源。
          </p>
          <ErrorText value={error} />
          {message || activeChecked ? (
            <p role="status" className="success-message">
              {message || '个人账号与只读数据库连接已验证。'}
            </p>
          ) : null}
          {activeRead ? (
            <section className="management-section">
              <SectionHeader
                title="禅道读取结果"
                description={`来源：禅道 · ${data.connectors.find((connector) => connector.id === activeRead.id)?.name || '连接器'}`}
                action={
                  <Button onClick={() => setRead(null)}>收起读取结果</Button>
                }
              />
              <p className="muted">
                读取于 <Timestamp value={activeRead.result.checkedAt} /> ·
                有效至 <Timestamp value={activeRead.result.expiresAt} />
              </p>
              <div className="management-scope">
                <label className="field">
                  读取项目
                  <select
                    value={project}
                    onChange={(event) => setProject(event.target.value)}
                  >
                    <option value="">全部可见项目</option>
                    {activeRead.result.projects.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  disabled={!!busy}
                  onClick={() => {
                    const connector = data.connectors.find(
                      (item) => item.id === activeRead.id,
                    );
                    if (connector) void inspect(connector, 'read', project);
                  }}
                >
                  重新读取
                </Button>
              </div>
              {activeRead.result.truncated ? (
                <p className="management-note">
                  本次结果已达到数量上限，请选择具体项目后重新读取。
                </p>
              ) : null}
              {activeRead.result.tasks.length ? (
                <div className="table-scroll">
                  <table className="management-table">
                    <thead>
                      <tr>
                        <th>任务</th>
                        <th>项目</th>
                        <th>状态</th>
                        <th>执行人</th>
                        <th>计划工时</th>
                        <th>实际工时</th>
                        <th>剩余工时</th>
                        <th>截止日期</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeRead.result.tasks.map((task) => (
                        <tr key={`${task.projectId}:${task.id}`}>
                          <td>
                            {task.name}
                            <span className="cell-secondary">
                              禅道 #{task.id}
                              {task.moduleId ? ` · 模块 #${task.moduleId}` : ''}
                            </span>
                          </td>
                          <td>
                            {activeRead.result.projects.find(
                              (item) => item.id === task.projectId,
                            )?.name || `项目 #${task.projectId}`}
                          </td>
                          <td>
                            {externalTaskStatuses[task.status] || task.status}
                          </td>
                          <td>{task.assignee || '未分配'}</td>
                          <td>{externalHours(task.estimatedHours)}</td>
                          <td>{externalHours(task.consumedHours)}</td>
                          <td>{externalHours(task.remainingHours)}</td>
                          <td>{task.deadline || '未提供'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title={
                    !activeRead.result.tasksLoaded
                      ? '选择项目以读取任务'
                      : activeRead.result.projects.length
                        ? '本次未返回任务'
                        : '当前账号没有可读取的项目'
                  }
                >
                  选择具体项目后重新读取；此处不会以空结果推断项目已完成。
                </Empty>
              )}
            </section>
          ) : null}
        </>
      ) : (
        <ZentaoProjectConnections
          client={client}
          canAdmin={data.canAdmin}
          data={data}
        />
      )}
      {editor ? (
        <ConfigurationEditor
          key={editor.record?.id || 'new'}
          state={editor}
          data={data}
          onCommand={onCommand}
          close={() => setEditor(null)}
          saved={() => {
            setEditor(null);
            setChecked(null);
            setRead(null);
            setMessage('');
            setError('');
          }}
        />
      ) : null}
    </div>
  );
}
function externalHours(value: number | null) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value} h`
    : '未提供';
}

function Administration({ client, data, onCommand }: SettingsProps) {
  const [tab, setTab] = useState(data.canAdmin ? 'people' : 'models');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [testing, setTesting] = useState('');
  const [testResult, setTestResult] = useState('');
  const [testError, setTestError] = useState('');
  async function testModel(channel: WorkModelChannel) {
    setTesting(channel.id);
    setTestResult('');
    setTestError('');
    try {
      await onCommand('test-model-channel', {
        id: channel.id,
        ...(channel.models[0] ? { model: channel.models[0] } : {}),
      });
      setTestResult(`${channel.name} 已完成真实模型调用验证。`);
    } catch (cause) {
      setTestError(errorMessage(cause));
    } finally {
      setTesting('');
    }
  }
  if (!canManage(data, 'config.manage'))
    return (
      <Empty title="后台管理仅对空间管理员开放">
        如需调整团队配置，请联系空间管理员分配权限。
      </Empty>
    );
  const activeTab =
    data.canAdmin || ['models', 'plugins'].includes(tab) ? tab : 'models';
  return (
    <div className="management-settings">
      <Tabs
        activeKey={activeTab}
        onChange={(next) => guardUnsavedNavigation(() => setTab(next))}
        items={[
          ...(data.canAdmin
            ? [
                { key: 'people', label: '人员' },
                { key: 'roles', label: '角色' },
                { key: 'menus', label: '菜单' },
              ]
            : []),
          { key: 'models', label: '大模型' },
          { key: 'plugins', label: '插件' },
        ]}
      />
      {activeTab === 'people' ? (
        <PeopleManagement client={client} data={data} />
      ) : activeTab === 'roles' ? (
        <>
          <ConfigurationList
            kind="role"
            title="自定义角色"
            description="为成员分配常用职责及操作权限。"
            records={data.roles}
            canAdmin
            edit={setEditor}
            render={(item) => {
              const role = item as WorkRole;
              return (
                <>
                  <strong>{role.name}</strong>
                  <p>{role.description || '尚未填写说明'}</p>
                  <p className="muted">
                    {role.permissions.join('、') || '未设置权限项'} ·{' '}
                    {role.enabled ? '配置已启用' : '配置已停用'}
                  </p>
                  <p className="muted">
                    成员：
                    {role.memberIds
                      .map(
                        (id) =>
                          data.participants.find(
                            (participant) => participant.id === id,
                          )?.name || '不可用成员',
                      )
                      .join('、') || '未分配'}
                  </p>
                </>
              );
            }}
          />
          <p className="management-note">
            未分配自定义角色的成员保留默认协作权限；分配后使用所有启用角色的权限并集，角色停用不会恢复默认权限。权限始终受已有项目授权约束，不能授予空间管理员身份。
          </p>
        </>
      ) : activeTab === 'menus' ? (
        <ConfigurationList
          kind="menu"
          title="菜单设置"
          description="配置入口名称、显示顺序及可见状态。菜单可见性不会授予资源访问权限。"
          records={[...data.menus].sort((a, b) => a.sortOrder - b.sortOrder)}
          canAdmin
          edit={setEditor}
          render={(item) => {
            const menu = item as WorkMenu;
            return (
              <>
                <strong>{menu.label}</strong>
                <p className="muted">
                  {menuOptions.find((option) => option.value === menu.key)
                    ?.label || menu.key}{' '}
                  · 排序 {menu.sortOrder} ·{' '}
                  {menu.visible ? '显示入口' : '隐藏入口'}
                </p>
              </>
            );
          }}
        />
      ) : activeTab === 'models' ? (
        <>
          <ConfigurationList
            kind="model-channel"
            title="模型渠道"
            description="配置模型服务地址、协议、可用模型与 API Key。"
            records={data.modelChannels}
            canAdmin
            edit={setEditor}
            extraAction={(item) =>
              data.canAdmin ? (
                <Button
                  disabled={!!testing}
                  loading={testing === item.id}
                  onClick={() => void testModel(item as WorkModelChannel)}
                >
                  测试调用
                </Button>
              ) : null
            }
            render={(item) => {
              const channel = item as WorkModelChannel;
              return (
                <>
                  <strong>{channel.name}</strong>
                  <p>{channel.baseUrl}</p>
                  <p className="muted">
                    {protocolName(channel.protocol)} ·{' '}
                    {channel.models.join('、') || '未填写模型'} ·{' '}
                    {channel.enabled ? '配置已启用' : '配置已停用'}
                  </p>
                  <p className="muted">
                    API Key：
                    {hasCredential(data, 'model-channel', channel.id)
                      ? '已加密保存'
                      : channel.credentialRef
                        ? `环境变量 ${channel.credentialRef}`
                        : '未配置引用'}
                  </p>
                </>
              );
            }}
          />
          <p className="management-note">
            “测试调用”使用已保存的 API Key 发起一次少量 Token 的真实请求。可在
            Agents 的运行配置中为 T 组三角色选择渠道与模型。
          </p>
          {testResult ? (
            <p role="status" className="success-message">
              {testResult}
            </p>
          ) : null}
          <ErrorText value={testError} />
        </>
      ) : (
        <>
          <ConfigurationList
            kind="plugin"
            title="插件登记"
            description="记录扩展来源、固定版本与启用意向，为后续开放能力保留清晰的配置。"
            records={data.plugins}
            canAdmin
            edit={setEditor}
            render={(item) => {
              const plugin = item as WorkPlugin;
              return (
                <>
                  <strong>{plugin.name}</strong>
                  <p>{plugin.description || '尚未填写说明'}</p>
                  <p className="muted">
                    {plugin.source} · {plugin.pinnedVersion || '未固定版本'} ·{' '}
                    {plugin.enabled ? '配置已启用' : '配置已停用'}
                  </p>
                </>
              );
            }}
          />
          <p className="management-note">
            目前仅维护插件登记信息，插件代码尚不会被安装或执行。
          </p>
        </>
      )}
      {editor ? (
        <ConfigurationEditor
          key={`${editor.kind}:${editor.record?.id || 'new'}`}
          state={editor}
          data={data}
          onCommand={onCommand}
          close={() => setEditor(null)}
          saved={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

function ConfigurationList({
  kind,
  title,
  description,
  records,
  canAdmin,
  edit,
  render,
  extraAction,
  canEditRecord,
}: {
  kind: ConfigKind;
  title: string;
  description: string;
  records: ConfigRecord[];
  canAdmin: boolean;
  edit: (state: EditorState) => void;
  render: (record: ConfigRecord) => React.ReactNode;
  extraAction?: (record: ConfigRecord) => React.ReactNode;
  canEditRecord?: (record: ConfigRecord) => boolean;
}) {
  return (
    <section className="management-section">
      <SectionHeader
        title={title}
        description={description}
        action={
          canAdmin ? (
            <Button type="primary" onClick={() => edit({ kind })}>
              添加{kindNames[kind]}
            </Button>
          ) : undefined
        }
      />
      {records.length ? (
        <ul className="product-rows management-config-list">
          {records.map((record) => (
            <li key={record.id}>
              <div className="grow">{render(record)}</div>
              {extraAction?.(record)}
              {canAdmin && (!canEditRecord || canEditRecord(record)) ? (
                <Button onClick={() => edit({ kind, record })}>编辑</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <Empty title={`尚未添加${kindNames[kind]}`}>
          {canAdmin
            ? `点击右上角添加${kindNames[kind]}，配置会保存在当前空间。`
            : '空间管理员尚未添加配置。'}
        </Empty>
      )}
    </section>
  );
}

function PeopleManagement({
  client,
  data,
}: {
  client: ProductClient;
  data: WorkSnapshot;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    Promise.all([
      api<{ members: Member[] }>(
        `/api/workspaces/${client.workspace.id}/members`,
        { signal: controller.signal },
      ),
      api<{ user: User | null }>('/api/session', { signal: controller.signal }),
    ])
      .then(([result, session]) => {
        if (!controller.signal.aborted) {
          setMembers(result.members);
          setUser(session.user);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause));
          client.onError(cause);
        }
      });
    return () => controller.abort();
  }, [client.workspace.id, client.onError, revision]);
  return (
    <section className="management-section">
      <SectionHeader
        title="空间成员"
        description="成员通过协作账号加入，人员身份与项目授权分别维护。"
        action={
          <Button type="primary" disabled={!user} onClick={() => setOpen(true)}>
            管理成员
          </Button>
        }
      />
      <ResourceState
        error={error}
        loading={!members && !error}
        retry={() => setRevision((value) => value + 1)}
      >
        {members?.length ? (
          <div className="table-scroll">
            <table className="management-table">
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>空间角色</th>
                  <th>自定义角色</th>
                  <th>身份 ID</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.identityId}>
                    <td>{member.displayName}</td>
                    <td>{roleNames[member.role]}</td>
                    <td>
                      {data.roles
                        .filter((role) =>
                          (
                            role as WorkRole & { memberIds?: string[] }
                          ).memberIds?.includes(member.identityId),
                        )
                        .map(
                          (role) =>
                            `${role.name}${role.enabled ? '' : '（已停用）'}`,
                        )
                        .join('、') || '未分配'}
                    </td>
                    <td className="muted">{member.identityId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="尚无成员记录" />
        )}
      </ResourceState>
      {user && open ? (
        <MembersDialog
          workspace={client.workspace}
          user={user}
          open
          close={() => {
            setOpen(false);
            setRevision((value) => value + 1);
            client.refresh();
          }}
          onError={client.onError}
        />
      ) : null}
    </section>
  );
}

function ExternalProjectPanel({
  client,
  mode,
  onCapabilities,
}: {
  client: ProductClient;
  mode: 'capabilities' | 'runs';
  onCapabilities?: () => void;
}) {
  const projects = useProductResource<{ projects: ProjectItem[] }>(
    client,
    'projects',
  );
  const [selected, setSelected] = useState('');
  const projectId = projects.data?.projects.some(
    (project) => project.id === selected,
  )
    ? selected
    : projects.data?.projects[0]?.id || '';
  const scopedClient = useMemo(
    () => ({ ...client, projectId }),
    [client, projectId],
  );
  return (
    <div className="management-external-panel">
      <div className="management-scope">
        <label className="field">
          已授权的禅道项目
          <select
            value={projectId}
            disabled={!projects.data?.projects.length}
            onChange={(event) => {
              const value = event.target.value;
              guardUnsavedNavigation(() => setSelected(value));
            }}
          >
            <option value="" disabled>
              选择已连接项目
            </option>
            {projects.data?.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">能力授权与实际执行绑定具体项目和执行身份。</p>
      </div>
      <ResourceState
        error={projects.error}
        loading={!projects.data && projects.loading}
        retry={projects.reload}
      >
        {mode === 'capabilities' ? (
          <CapabilitiesPanel key={projectId} client={scopedClient} />
        ) : projectId ? (
          <DeliveryPanel
            key={projectId}
            client={scopedClient}
            view="agents"
            navigate={() => onCapabilities?.()}
          />
        ) : (
          <Empty title="先连接一个禅道项目">
            在连接器中选择当前账号已获授权的项目，再启动 T 组运行。
          </Empty>
        )}
      </ResourceState>
    </div>
  );
}

function ZentaoProjectConnections({
  client,
  canAdmin,
  data,
}: {
  client: ProductClient;
  canAdmin: boolean;
  data: WorkSnapshot;
}) {
  const available = useProductResource<{
    projects: { id: string; name: string; status: string }[];
  }>(client, 'available-projects');
  const connected = useProductResource<{ projects: ProjectItem[] }>(
    client,
    'projects',
  );
  const connection = useProductResource<{
    connection: { label: string; kind: string };
    authorization: { displayName: string; status: string };
  }>(client, 'connection');
  const [choice, setChoice] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  async function bind(event: React.FormEvent) {
    event.preventDefault();
    if (!choice || busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await actProduct(client, 'bind-project', { externalId: choice });
      setChoice('');
      setSuccess('项目已连接，可按账号权限读取项目数据。');
      connected.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management-section">
      <SectionHeader
        title="禅道项目连接"
        description="使用当前登录账号读取项目；连接本身不修改禅道业务数据。"
      />
      <ResourceState
        error={connection.error}
        loading={!connection.data && connection.loading}
        retry={connection.reload}
      >
        {connection.data ? (
          <p className="management-note">
            {connection.data.connection.label} · 当前执行账号：
            {connection.data.authorization.displayName}
          </p>
        ) : null}
      </ResourceState>
      {canAdmin ? (
        <ResourceState
          error={available.error}
          loading={!available.data && available.loading}
          retry={available.reload}
        >
          <form className="inline-form" onSubmit={bind}>
            <label className="field grow">
              选择可访问的项目
              <select
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
                required
                disabled={busy}
              >
                <option value="">请选择</option>
                {available.data?.projects
                  .filter(
                    (project) =>
                      !connected.data?.projects.some(
                        (item) => item.externalId === project.id,
                      ),
                  )
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              type="primary"
              htmlType="submit"
              loading={busy}
              disabled={!choice}
            >
              连接项目
            </Button>
          </form>
        </ResourceState>
      ) : null}
      <ErrorText value={error} />
      {success ? (
        <p role="status" className="success-message">
          {success}
        </p>
      ) : null}
      <ResourceState
        error={connected.error}
        loading={!connected.data && connected.loading}
        retry={connected.reload}
      >
        {connected.data?.projects.length ? (
          <ul className="product-rows">
            {connected.data.projects.map((project) => (
              <li key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  <p className="muted">
                    禅道项目 #{project.externalId} ·{' '}
                    {project.canWrite ? '允许提交写入草案' : '只读'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="尚未连接禅道项目">
            连接后，项目数据由禅道实时提供。
          </Empty>
        )}
      </ResourceState>
      {canAdmin && connected.data?.projects.length ? (
        <ZentaoProjectGrants
          client={client}
          data={data}
          projects={connected.data.projects}
        />
      ) : null}
    </section>
  );
}

function ZentaoProjectGrants({
  client,
  data,
  projects,
}: {
  client: ProductClient;
  data: WorkSnapshot;
  projects: ProjectItem[];
}) {
  const [selection, setSelection] = useState('');
  const projectId = projects.some((item) => item.id === selection)
    ? selection
    : projects[0]?.id || '';
  const [identityId, setIdentityId] = useState('');
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const grants = useProductResource<{
    grants: { identityId: string; displayName: string; canWrite: boolean }[];
  }>(client, 'project-grants', { project: projectId });
  async function save(
    command: 'grant-project' | 'revoke-project',
    target: string,
  ) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await actProduct(client, command, {
        projectId,
        identityId: target,
        ...(command === 'grant-project' ? { canWrite } : {}),
      });
      grants.reload();
      setMessage(
        command === 'grant-project'
          ? '项目访问授权已保存。'
          : '项目访问授权已撤销。',
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management-section">
      <SectionHeader
        title="项目访问授权"
        description="为空间成员明确授予已连接项目的访问权限，实际操作仍受其禅道账号权限约束。"
      />
      <label className="field">
        授权项目
        <select
          value={projectId}
          onChange={(event) => {
            setSelection(event.target.value);
            setMessage('');
            setError('');
          }}
          disabled={busy}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save('grant-project', identityId);
        }}
      >
        <label className="field grow">
          空间成员
          <select
            value={identityId}
            onChange={(event) => setIdentityId(event.target.value)}
            required
            disabled={busy}
          >
            <option value="">选择成员</option>
            {data.participants
              .filter((participant) => participant.kind === 'human')
              .map((participant) => (
                <option key={participant.id} value={participant.id}>
                  {participant.name}
                </option>
              ))}
          </select>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={canWrite}
            onChange={(event) => setCanWrite(event.target.checked)}
            disabled={busy}
          />
          允许提交写入草案
        </label>
        <Button htmlType="submit" loading={busy} disabled={!identityId}>
          保存项目授权
        </Button>
      </form>
      <ErrorText value={error} />
      {message ? (
        <p role="status" className="success-message">
          {message}
        </p>
      ) : null}
      <ResourceState
        error={grants.error}
        loading={!grants.data && grants.loading}
        retry={grants.reload}
      >
        {grants.data?.grants.length ? (
          <ul className="product-rows">
            {grants.data.grants.map((grant) => (
              <li key={grant.identityId}>
                <div>
                  <strong>{grant.displayName}</strong>
                  <p className="muted">
                    {grant.canWrite ? '允许读取和提交写入草案' : '只读'}
                  </p>
                </div>
                <Button
                  danger
                  disabled={busy}
                  onClick={() => void save('revoke-project', grant.identityId)}
                >
                  撤销 {grant.displayName}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="尚无成员授权记录" />
        )}
      </ResourceState>
    </section>
  );
}

function fieldsFor(
  kind: ConfigKind,
  data: WorkSnapshot,
  options?: { skills: Choice[]; servers: Choice[] },
): Field[] {
  const name: Field = {
    key: 'name',
    label: '名称',
    required: true,
    maxLength: 120,
  };
  const description: Field = {
    key: 'description',
    label: '说明',
    type: 'textarea',
    maxLength: 2000,
  };
  const enabled: Field = { key: 'enabled', label: '启用此配置', type: 'check' };
  const protocol: Field = {
    key: 'protocol',
    label: '协议',
    type: 'select',
    required: true,
    options: protocolOptions,
  };
  if (kind === 'agent')
    return [
      name,
      {
        key: 'avatar',
        label: '头像',
        maxLength: 2000,
        help: '填写图片地址，或输入简短文字作为头像。',
      },
      description,
      {
        key: 'teamId',
        label: '所属 Bot Team',
        type: 'select',
        options: data.teams.map((team) => ({
          value: team.id,
          label: team.name,
        })),
      },
      {
        key: 'modelChannelId',
        label: '模型渠道',
        type: 'select',
        options: data.modelChannels.map((channel) => ({
          value: channel.id,
          label: channel.name,
        })),
      },
      { key: 'model', label: '模型标识', maxLength: 200 },
      protocol,
      {
        key: 'sandboxId',
        label: '沙箱环境',
        type: 'select',
        options: data.sandboxes.map((sandbox) => ({
          value: sandbox.id,
          label: sandbox.name,
        })),
      },
      {
        key: 'skillIds',
        label: 'Skills',
        type: 'multiple',
        options: options?.skills || [],
        help: '注册绑定意向。实际运行还需在能力管理中按项目授权。',
      },
      {
        key: 'mcpServerIds',
        label: 'MCP Servers',
        type: 'multiple',
        options: options?.servers || [],
      },
      enabled,
    ];
  if (kind === 'team')
    return [
      name,
      description,
      {
        key: 'memberIds',
        label: '团队成员',
        type: 'multiple',
        options: data.participants.map((participant) => ({
          value: participant.id,
          label: `${participant.name}${participant.kind === 'agent' ? ' · Agent' : ''}`,
        })),
      },
    ];
  if (kind === 'sandbox')
    return [
      name,
      {
        key: 'image',
        label: '容器镜像与版本',
        required: true,
        maxLength: 500,
        help: '建议使用固定标签或镜像摘要。',
      },
      { key: 'workdir', label: '工作目录', required: true, maxLength: 500 },
      {
        key: 'networkPolicy',
        label: '网络策略',
        type: 'select',
        required: true,
        options: [
          { value: 'none', label: '禁止网络' },
          { value: 'restricted', label: '受限网络' },
        ],
      },
      {
        key: 'cpu',
        label: 'CPU 核数',
        type: 'number',
        min: 0.25,
        step: 0.25,
        required: true,
      },
      {
        key: 'memoryMb',
        label: '内存上限（MiB）',
        type: 'number',
        min: 128,
        step: 128,
        required: true,
      },
      enabled,
    ];
  if (kind === 'model-channel')
    return [
      name,
      { key: 'baseUrl', label: '渠道地址', required: true, maxLength: 2000 },
      protocol,
      {
        key: 'models',
        label: '支持的模型',
        type: 'lines',
        required: true,
        help: '每行一个完整模型标识。',
      },
      {
        key: 'credentialRef',
        label: 'API Key 环境变量名（可选）',
        maxLength: 120,
        help: '高级引用登记。当前测试使用下方直接保存的 API Key，不会读取任意服务器环境变量。',
      },
      enabled,
    ];
  if (kind === 'role')
    return [
      name,
      description,
      {
        key: 'permissions',
        label: '权限项',
        type: 'multiple',
        options: permissionOptions,
        help: '权限在成员已获授权的资源范围内生效。',
      },
      {
        key: 'memberIds',
        label: '分配给成员',
        type: 'multiple',
        options: data.participants
          .filter((participant) => participant.kind === 'human')
          .map((participant) => ({
            value: participant.id,
            label: participant.name,
          })),
      },
      enabled,
    ];
  if (kind === 'menu')
    return [
      {
        key: 'key',
        label: '对应入口',
        type: 'select',
        options: menuOptions,
        required: true,
      },
      { key: 'label', label: '显示名称', required: true, maxLength: 30 },
      {
        key: 'sortOrder',
        label: '显示顺序',
        type: 'number',
        min: 0,
        step: 1,
        required: true,
      },
      { key: 'visible', label: '显示此入口', type: 'check' },
    ];
  if (kind === 'plugin')
    return [
      name,
      description,
      { key: 'source', label: '插件来源', required: true, maxLength: 2000 },
      {
        key: 'pinnedVersion',
        label: '固定版本',
        required: true,
        maxLength: 200,
      },
      enabled,
    ];
  return [
    name,
    { key: 'baseUrl', label: '禅道地址', required: true, maxLength: 2000 },
    { key: 'databaseHost', label: '数据库主机', maxLength: 500 },
    {
      key: 'databasePort',
      label: '数据库端口',
      type: 'number',
      min: 1,
      step: 1,
    },
    { key: 'databaseName', label: '数据库名称', maxLength: 120 },
    { key: 'databaseUser', label: '只读数据库账号', maxLength: 120 },
    {
      key: 'credentialRef',
      label: '数据库密码环境变量名',
      maxLength: 120,
      help: '仅填写服务器环境变量名，不填写密码。账号应仅具有 SELECT 权限。',
    },
    enabled,
  ];
}

function defaultsFor(kind: ConfigKind): Record<string, unknown> {
  if (kind === 'agent')
    return {
      name: '',
      description: '',
      avatar: '',
      teamId: null,
      modelChannelId: null,
      model: '',
      protocol: 'openai',
      sandboxId: null,
      skillIds: [],
      mcpServerIds: [],
      enabled: true,
    };
  if (kind === 'team') return { name: '', description: '', memberIds: [] };
  if (kind === 'sandbox')
    return {
      name: '',
      image: '',
      workdir: '/workspace',
      networkPolicy: 'none',
      cpu: 1,
      memoryMb: 1024,
      enabled: true,
    };
  if (kind === 'model-channel')
    return {
      name: '',
      baseUrl: '',
      protocol: 'openai',
      models: [],
      credentialRef: '',
      enabled: true,
    };
  if (kind === 'role')
    return {
      name: '',
      description: '',
      permissions: [],
      memberIds: [],
      enabled: true,
    };
  if (kind === 'menu')
    return { key: 'projects', label: '', visible: true, sortOrder: 0 };
  if (kind === 'plugin')
    return {
      name: '',
      description: '',
      source: '',
      pinnedVersion: '',
      enabled: false,
    };
  return {
    name: '',
    kind: 'zentao',
    baseUrl: '',
    databaseHost: '',
    databasePort: 3306,
    databaseName: '',
    databaseUser: '',
    credentialRef: '',
    enabled: true,
  };
}

function normalizeConfiguration(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? value.trim()
        : Array.isArray(value)
          ? value.map((item: string) => item.trim()).filter(Boolean)
          : value,
    ]),
  );
}

function ConfigurationEditor({
  state,
  data,
  options,
  onCommand,
  close,
  saved,
}: {
  state: EditorState;
  data: WorkSnapshot;
  options?: { skills: Choice[]; servers: Choice[] };
  onCommand: Command;
  close: () => void;
  saved: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...defaultsFor(state.kind),
    ...state.record,
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [savedRecord, setSavedRecord] = useState<{
    id: string;
    version: number;
  } | null>(null);
  const [metadataSaved, setMetadataSaved] = useState(false);
  const [persistedValues, setPersistedValues] = useState(() =>
    normalizeConfiguration(values),
  );
  const [removeModal, modalContext] = Modal.useModal();
  const input = normalizeConfiguration(values);
  const metadataChanged =
    (!state.record && !savedRecord) ||
    JSON.stringify(input) !== JSON.stringify(persistedValues);
  const credentialValues = Object.fromEntries(
    Object.entries(credentials).filter(([, value]) => value.length > 0),
  );
  const credentialDirty = Object.keys(credentialValues).length > 0;
  const requiresConnectorReauthorization =
    state.kind === 'connector' &&
    (metadataChanged ||
      metadataSaved ||
      !state.record ||
      !hasCredential(data, state.kind, state.record.id));
  const { requestClose, confirmation } = useUnsavedChanges(
    { values, credentialDirty },
    close,
    busy || removing,
  );
  const agentChannel =
    state.kind === 'agent'
      ? data.modelChannels.find(
          (channel) => channel.id === values.modelChannelId,
        )
      : undefined;
  const fields = fieldsFor(state.kind, data, options).map((field): Field =>
    agentChannel && field.key === 'model'
      ? {
          ...field,
          type: 'select',
          required: true,
          options: agentChannel.models.map((model) => ({
            value: model,
            label: model,
          })),
        }
      : agentChannel && field.key === 'protocol'
        ? { ...field, disabled: true, help: '协议继承所选模型渠道。' }
        : field,
  );
  function change(key: string, value: unknown) {
    const channel =
      state.kind === 'agent' && key === 'modelChannelId'
        ? data.modelChannels.find((item) => item.id === value)
        : undefined;
    setValues((current) => ({
      ...current,
      [key]: value,
      ...(channel
        ? {
            protocol: channel.protocol,
            model: channel.models.includes(String(current.model))
              ? current.model
              : channel.models[0] || '',
          }
        : {}),
    }));
    setMetadataSaved(false);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    let metadataDone = metadataSaved;
    try {
      if (
        credentialDirty &&
        requiresConnectorReauthorization &&
        !['account', 'apiPassword', 'databasePassword'].every(
          (key) => credentialValues[key],
        )
      )
        throw new Error(
          '首次授权或连接配置变更后，请同时填写禅道账号、禅道密码和只读数据库密码。',
        );
      let target =
        savedRecord ||
        (state.record
          ? { id: state.record.id, version: state.record.version }
          : null);
      if (metadataChanged) {
        const result = (await onCommand(`save-${state.kind}`, {
          ...input,
          ...(savedRecord || {}),
        })) as { id?: string; version?: number };
        if (!result.id || !result.version)
          throw new Error('配置已保存，但服务未返回内容版本，请刷新后重试。');
        target = { id: result.id, version: result.version };
        setSavedRecord(target);
        setMetadataSaved(true);
        setPersistedValues(input);
        metadataDone = true;
      }
      if (
        credentialDirty &&
        (state.kind === 'model-channel' || state.kind === 'connector') &&
        target
      ) {
        await onCommand('set-credential', {
          kind: state.kind,
          id: target.id,
          values: credentialValues,
        });
      }
      saved();
    } catch (cause) {
      setError(
        `${metadataDone && credentialDirty ? '基本配置已保存，凭据尚未保存。再次保存将重试凭据。' : ''}${errorMessage(cause)}`,
      );
    } finally {
      setBusy(false);
    }
  }
  function remove() {
    if (!state.record || state.kind === 'team') return;
    removeModal.confirm({
      title: `删除${kindNames[state.kind]}？`,
      content: '删除后无法从配置列表恢复。有关联引用时，服务会阻止删除。',
      okText: '删除配置',
      cancelText: '保留',
      focusable: { autoFocusButton: 'cancel' },
      okButtonProps: { danger: true },
      onOk: async () => {
        setRemoving(true);
        setError('');
        try {
          await onCommand('remove-configuration', {
            kind: state.kind,
            id: state.record!.id,
            version: state.record!.version,
          });
          close();
        } catch (cause) {
          setError(errorMessage(cause));
          throw cause;
        } finally {
          setRemoving(false);
        }
      },
    });
  }
  return (
    <>
      <Drawer
        title={`${state.record ? '编辑' : '添加'}${kindNames[state.kind]}`}
        open
        onClose={requestClose}
        size="min(560px, 100vw)"
        mask={{ closable: !busy }}
        closable={!busy}
      >
        <form className="dialog-form" onSubmit={save}>
          <div className="management-editor-fields">
            {fields.map((field) =>
              field.type === 'check' ? (
                <label className="check-field" key={field.key}>
                  <input
                    type="checkbox"
                    checked={values[field.key] === true}
                    disabled={busy}
                    onChange={(event) =>
                      change(field.key, event.target.checked)
                    }
                  />
                  {field.label}
                </label>
              ) : (
                <label className="field" key={field.key}>
                  <span>
                    {field.label}
                    {field.required ? ' *' : ''}
                  </span>
                  {field.type === 'multiple' ? (
                    <Select
                      mode="multiple"
                      value={
                        Array.isArray(values[field.key])
                          ? (values[field.key] as string[])
                          : []
                      }
                      options={field.options || []}
                      disabled={busy || !!field.disabled}
                      onChange={(value) => change(field.key, value)}
                      optionFilterProp="label"
                      placeholder="选择已有配置"
                    />
                  ) : field.type === 'select' ? (
                    <select
                      value={String(values[field.key] ?? '')}
                      required={field.required}
                      disabled={busy || !!field.disabled}
                      onChange={(event) =>
                        change(field.key, event.target.value || null)
                      }
                    >
                      {!field.required ? (
                        <option value="">未选择</option>
                      ) : null}
                      {field.options?.map((option) => (
                        <option value={option.value} key={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'textarea' || field.type === 'lines' ? (
                    <Input.TextArea
                      required={field.required}
                      maxLength={field.maxLength || 8000}
                      value={
                        field.type === 'lines'
                          ? Array.isArray(values[field.key])
                            ? (values[field.key] as string[]).join('\n')
                            : ''
                          : String(values[field.key] ?? '')
                      }
                      autoSize={{ minRows: 3, maxRows: 8 }}
                      disabled={busy || !!field.disabled}
                      onChange={(event) =>
                        change(
                          field.key,
                          field.type === 'lines'
                            ? event.target.value.split('\n')
                            : event.target.value,
                        )
                      }
                    />
                  ) : (
                    <Input
                      type={field.type === 'number' ? 'number' : 'text'}
                      required={field.required}
                      maxLength={field.maxLength || 2000}
                      min={field.min}
                      step={field.step}
                      value={String(values[field.key] ?? '')}
                      disabled={busy || !!field.disabled}
                      onChange={(event) =>
                        change(
                          field.key,
                          field.type === 'number'
                            ? Number(event.target.value)
                            : event.target.value,
                        )
                      }
                    />
                  )}
                  {field.help ? (
                    <span className="form-help">{field.help}</span>
                  ) : null}
                </label>
              ),
            )}
            {data.canAdmin &&
            (state.kind === 'model-channel' || state.kind === 'connector') ? (
              <fieldset className="management-credentials">
                <legend>安全凭据</legend>
                <p className="form-help">
                  {state.kind === 'connector'
                    ? requiresConnectorReauthorization
                      ? '连接配置变更会使原授权失效。保存本人授权时，请填写全部三项；也可先只保存配置，稍后完成授权。'
                      : '凭据加密保存且不回显。仅修改凭据时，留空保留本人已有值；修改任一连接配置后须重新填写全部三项。'
                    : '凭据加密保存且不回显，留空可保留已有值。'}
                  {state.record &&
                  hasCredential(data, state.kind, state.record.id)
                    ? '此配置已有加密凭据。'
                    : ''}
                </p>
                {(state.kind === 'model-channel'
                  ? [{ key: 'apiKey', label: 'API Key', password: true }]
                  : [
                      { key: 'account', label: '禅道账号', password: false },
                      { key: 'apiPassword', label: '禅道密码', password: true },
                      {
                        key: 'databasePassword',
                        label: '只读数据库密码',
                        password: true,
                      },
                    ]
                ).map((field) => (
                  <label className="field" key={field.key}>
                    <span>{field.label}</span>
                    <Input
                      type={field.password ? 'password' : 'text'}
                      autoComplete={field.password ? 'new-password' : 'off'}
                      maxLength={state.kind === 'connector' ? 4096 : 8192}
                      value={credentials[field.key] || ''}
                      disabled={busy}
                      placeholder={
                        state.kind === 'connector' &&
                        requiresConnectorReauthorization
                          ? '完成授权时必填'
                          : state.record
                            ? '留空保留已有值'
                            : ''
                      }
                      onChange={(event) =>
                        setCredentials((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
          <ErrorText value={error} />
          <div className="dialog-actions">
            {state.record && state.kind !== 'team' ? (
              <Button danger onClick={remove} disabled={busy || removing}>
                删除
              </Button>
            ) : null}
            <Button onClick={requestClose} disabled={busy || removing}>
              取消
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={busy}
              disabled={removing}
            >
              保存配置
            </Button>
          </div>
        </form>
      </Drawer>
      <Fragment key="unsaved-confirmation">{confirmation}</Fragment>
      <Fragment key="remove-confirmation">{modalContext}</Fragment>
    </>
  );
}

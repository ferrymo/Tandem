'use client';
import { useState } from 'react';
import { Button, Drawer, Input, Modal, Select, Tabs } from 'antd';
import { displayDeliveryModel, formatDeliveryChannelModel } from '@tandem/core';
import type {
  AvailableDeliveryChannel,
  AgentRole,
  DeliveryDetail,
  DeliveryProfiles,
  DeliveryRun,
  ProjectDraft,
} from '@tandem/core';
import { errorMessage, type View } from './collaboration-types';
import {
  actProduct,
  Empty,
  ErrorText,
  ResourceState,
  Timestamp,
  useProductResource,
  type ProductClient,
} from './product-api';
import { DraftsPanel } from './drafts-panel';
import { NavIcon } from './workbench-icons';
import { useUnsavedChanges } from './use-unsaved-changes';

const statuses: Record<DeliveryRun['status'], string> = {
  queued: '等待执行',
  running: '执行中',
  paused: '已暂停',
  needs_auth: '需要更新授权',
  needs_configuration: '需要配置',
  needs_decision: '等待决策',
  awaiting_deployment: '等待部署批准',
  delivered: '已交付',
  failed: '执行失败',
  cancelled: '已取消',
};
const phases: Record<DeliveryRun['phase'], string> = {
  design: '产品设计',
  architecture: '技术与部署设计',
  implementation: '开发实现',
  test: '测试与构建',
  design_review: '设计复核',
  technical_review: '技术复核',
  delivery: '交付与部署',
};
const roleNames = {
  designer: '产品设计师',
  architect: '技术架构师',
  engineer: '研发工程师',
};
function documentName(kind: string) {
  if (kind.startsWith('skill_resources.')) return '技能资源读取记录';
  if (kind.startsWith('skills.')) return '技能版本快照';
  if (kind.startsWith('tools.')) return '工具授权快照';
  const names: Record<string, string> = {
    design: '产品设计',
    architecture: '技术与部署设计',
    implementation: '工程实现',
    design_review: '设计复核',
    technical_review: '技术复核',
    profiles: '团队配置快照',
    issues: '修订事项',
    pending_tool: '工具审批检查点',
    deployment_proposal: '部署提案',
  };
  return names[kind] ?? '运行记录';
}
type ProfilesResult = {
  profiles: DeliveryProfiles;
  model: { configured: boolean; name: string };
  execution: { configured: boolean };
  modelChannels?: AvailableDeliveryChannel[];
};
export function DeliveryPanel({
  client,
  view,
  navigate,
}: {
  client: ProductClient;
  view: View;
  navigate: (view: View) => void;
}) {
  const runs = useProductResource<{ runs: DeliveryRun[] }>(
    client,
    'runs',
    { project: client.projectId },
    true,
  );
  const profiles = useProductResource<ProfilesResult>(client, 'profiles');
  const [selected, setSelected] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const list = runs.data?.runs ?? [];
  if (view === 'observe')
    return (
      <>
        <section className="content-panel">
          <div className="section-heading">
            <div>
              <h2>当前项目执行概况</h2>
              <p className="muted">
                来自持久化运行记录；不将缺少容量和工时的数据换算为负载指数。
              </p>
            </div>
            <Button onClick={runs.reload}>刷新记录</Button>
          </div>
          <ResourceState
            error={runs.error}
            loading={!runs.data && runs.loading}
            retry={runs.reload}
          >
            <dl className="observation-list">
              <div>
                <dt>正在执行 / 排队</dt>
                <dd>
                  {
                    list.filter((r) => ['queued', 'running'].includes(r.status))
                      .length
                  }{' '}
                  次运行
                </dd>
              </div>
              <div>
                <dt>需要人工处理</dt>
                <dd>
                  {
                    list.filter((r) =>
                      [
                        'needs_auth',
                        'needs_configuration',
                        'needs_decision',
                        'awaiting_deployment',
                      ].includes(r.status),
                    ).length
                  }{' '}
                  次运行
                </dd>
              </div>
              <div>
                <dt>已交付</dt>
                <dd>
                  {list.filter((r) => r.status === 'delivered').length} 次运行
                </dd>
              </div>
              <div>
                <dt>模型消耗</dt>
                <dd>
                  {list.reduce((n, r) => n + r.usedCalls, 0)} 次调用 ·{' '}
                  {list.reduce((n, r) => n + r.usedTokens, 0).toLocaleString()}{' '}
                  Tokens
                </dd>
              </div>
              <div>
                <dt>人员负载与空档</dt>
                <dd>待评估 · 尚无完整容量与日历依据</dd>
              </div>
            </dl>
          </ResourceState>
        </section>
        <RunList client={client} runs={runs} select={setSelected} />
        {selected ? (
          <RunDetail
            key={selected}
            client={client}
            runId={selected}
            close={() => setSelected('')}
          />
        ) : null}
      </>
    );
  return (
    <>
      {view === 'focus' ? (
        <DispatchForm
          client={client}
          ready={
            !!profiles.data?.model.configured &&
            !!profiles.data.execution.configured
          }
        />
      ) : null}
      <section className="content-panel team-panel">
        <div className="section-heading">
          <div>
            <h2>{client.team.name}</h2>
            <p className="muted">
              挂靠人：{client.team.ownerDisplayName} ·
              三个角色共享目标、版本与交付证据
            </p>
          </div>
          <Button onClick={() => setConfiguring(true)}>配置 T 组</Button>
        </div>
        <ResourceState
          error={profiles.error}
          loading={!profiles.data && profiles.loading}
          retry={profiles.reload}
        >
          <ul className="agent-list">
            {client.team.agents.map((agent) => (
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
                  <p className="muted">
                    模型：
                    {displayDeliveryModel(
                      profiles.data?.profiles[agent.role as AgentRole]?.model ||
                        profiles.data?.model.name ||
                        '待配置',
                    )}
                  </p>
                </div>
                <span className="state-label">
                  <span
                    className={`state-marker${profiles.data?.model.configured ? ' is-success' : ''}`}
                  />
                  {profiles.data?.model.configured ? '模型已配置' : '待配置'}
                </span>
              </li>
            ))}
          </ul>
          <div className="team-requirements">
            <p className="muted">
              执行环境：
              {profiles.data?.execution.configured
                ? '已配置 · 每次运行仍须验证'
                : '待配置'}{' '}
              · Skills 与工具按项目和角色授权。
            </p>
            <Button type="link" onClick={() => navigate('capabilities')}>
              管理成员能力
            </Button>
          </div>
        </ResourceState>
      </section>
      {view === 'agents' ? (
        <DispatchForm
          client={client}
          ready={
            !!profiles.data?.model.configured &&
            !!profiles.data.execution.configured
          }
        />
      ) : null}
      <DraftsPanel client={client} />
      <RunList client={client} runs={runs} select={setSelected} />
      {selected ? (
        <RunDetail
          key={selected}
          client={client}
          runId={selected}
          close={() => setSelected('')}
        />
      ) : null}
      {configuring && profiles.data ? (
        <TeamConfiguration
          client={client}
          initial={profiles.data}
          close={() => setConfiguring(false)}
        />
      ) : null}
    </>
  );
}
function DispatchForm({
  client,
  ready,
}: {
  client: ProductClient;
  ready: boolean;
}) {
  const [goal, setGoal] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [mode, setMode] = useState('demo');
  const [role, setRole] = useState('team');
  const [calls, setCalls] = useState(16);
  const [tokens, setTokens] = useState(80000);
  const [revisions, setRevisions] = useState(2);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const { confirmation } = useUnsavedChanges(
    { goal, acceptance },
    () => {
      setGoal('');
      setAcceptance('');
    },
    busy,
  );
  async function start() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await actProduct(client, 'start-run', {
        projectId: client.projectId,
        goal,
        acceptance,
        mode,
        budgetCalls: calls,
        budgetTokens: tokens,
        maxRevisions: revisions,
        requestId,
        ...(role === 'team' ? {} : { assignedRole: role }),
      });
      setMessage('运行已创建，可在下方查看阶段、预算和交付证据。');
      setGoal('');
      setAcceptance('');
      setRequestId(crypto.randomUUID());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="content-panel">
      <h2>给 T 组一个目标</h2>
      {confirmation}
      <p className="muted">
        明确验收条件，其余阶段由团队持续推进；外部写入和部署停在草案审批。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <label className="field">
          交付目标
          <Input.TextArea
            required
            rows={2}
            maxLength={6000}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={busy}
            placeholder="描述目标用户、要解决的问题和完整演示路径"
          />
        </label>
        <label className="field">
          验收条件
          <Input.TextArea
            required
            rows={2}
            maxLength={6000}
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            disabled={busy}
            placeholder="描述可以实际操作和验证的结果"
          />
        </label>
        <div className="form-grid">
          <label className="field">
            交付模式
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              disabled={busy}
            >
              <option value="demo">可运行 Demo</option>
              <option value="deploy">开发并申请本地演示部署</option>
            </select>
          </label>
          <label className="field">
            负责成员
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={busy}
            >
              <option value="team">T 组整组协作</option>
              {Object.entries(roleNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <details className="budget-settings">
          <summary>预算与返工上限</summary>
          <div className="form-grid">
            <label className="field">
              最多模型调用
              <input
                type="number"
                min={5}
                max={100}
                required
                value={calls}
                onChange={(e) => setCalls(Number(e.target.value))}
              />
            </label>
            <label className="field">
              最多 Tokens
              <input
                type="number"
                min={10000}
                max={2000000}
                step={1000}
                required
                value={tokens}
                onChange={(e) => setTokens(Number(e.target.value))}
              />
            </label>
            <label className="field">
              最多返工次数
              <input
                type="number"
                min={0}
                max={5}
                required
                value={revisions}
                onChange={(e) => setRevisions(Number(e.target.value))}
              />
            </label>
          </div>
        </details>
        {!ready ? (
          <p className="form-help">
            模型或执行环境尚未就绪。请先完成 T 组与部署环境配置。
          </p>
        ) : null}
        <ErrorText value={error} />
        {message ? (
          <p role="status" className="success-message">
            {message}
          </p>
        ) : null}
        <div className="row-actions">
          <Button
            type="primary"
            htmlType="submit"
            loading={busy}
            disabled={
              !client.projectId || !ready || !goal.trim() || !acceptance.trim()
            }
          >
            交给 {role === 'team' ? 'T 组' : roleNames[role as AgentRole]}
          </Button>
        </div>
      </form>
    </section>
  );
}
function RunList({
  runs,
  select,
}: {
  client: ProductClient;
  runs: ReturnType<typeof useProductResource<{ runs: DeliveryRun[] }>>;
  select: (id: string) => void;
}) {
  return (
    <section className="content-panel">
      <div className="section-heading">
        <h2>运行与交付</h2>
        <Button onClick={runs.reload}>刷新运行</Button>
      </div>
      <ResourceState
        error={runs.error}
        loading={!runs.data && runs.loading}
        retry={runs.reload}
      >
        {!runs.data?.runs.length ? (
          <Empty title="还没有运行">
            提交目标后，这里展示实际阶段、决策与交付物。
          </Empty>
        ) : (
          <ul className="product-rows">
            {runs.data.runs.map((run) => (
              <li key={run.id}>
                <div className="grow">
                  <button
                    className="text-button"
                    onClick={() => select(run.id)}
                  >
                    {run.goal}
                  </button>
                  <p className="muted">
                    {phases[run.phase]} · {statuses[run.status]} ·{' '}
                    <Timestamp value={run.updatedAt} />
                  </p>
                  <p className="muted">
                    调用 {run.usedCalls}/{run.budgetCalls} · Tokens{' '}
                    {run.usedTokens.toLocaleString()}/
                    {run.budgetTokens.toLocaleString()} · 返工 {run.revision}/
                    {run.maxRevisions}
                  </p>
                </div>
                <Button onClick={() => select(run.id)}>查看运行</Button>
              </li>
            ))}
          </ul>
        )}
      </ResourceState>
    </section>
  );
}
function TeamConfiguration({
  client,
  initial,
  close,
}: {
  client: ProductClient;
  initial: ProfilesResult;
  close: () => void;
}) {
  const [profiles, setProfiles] = useState<DeliveryProfiles>(initial.profiles);
  const [customModels, setCustomModels] = useState<Record<AgentRole, boolean>>(
    () =>
      Object.fromEntries(
        (['designer', 'architect', 'engineer'] as const).map((role) => [
          role,
          !!initial.profiles[role]?.model &&
            !initial.profiles[role]?.model.startsWith('channel:'),
        ]),
      ) as Record<AgentRole, boolean>,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { requestClose, confirmation } = useUnsavedChanges(
    profiles,
    close,
    busy,
  );
  async function save() {
    setBusy(true);
    setError('');
    try {
      await actProduct(client, 'configure-team', { profiles });
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
        title="T 组模型与职责"
        open
        onCancel={requestClose}
        footer={null}
        width={720}
      >
        <p className="muted">
          为各角色选择已配置的模型渠道，或使用部署默认模型。渠道版本随配置固定，密钥不会显示在这里。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {(['designer', 'architect', 'engineer'] as const).map((role) => {
            const selected = profiles[role]?.model ?? '';
            const available = (initial.modelChannels ?? []).flatMap((channel) =>
              channel.models.map((model) =>
                formatDeliveryChannelModel(channel.id, channel.version, model),
              ),
            );
            const stale =
              selected.startsWith('channel:') && !available.includes(selected);
            const choices = [
              {
                label: '部署环境',
                options: [
                  {
                    value: '',
                    label: initial.model.name
                      ? `使用部署默认 · ${initial.model.name}`
                      : '使用部署默认模型',
                  },
                  { value: '__custom__', label: '手动填写部署模型' },
                ],
              },
              ...(initial.modelChannels ?? []).map((channel) => ({
                label: `${channel.name} · ${channel.protocol} · v${channel.version}${!channel.enabled ? ' · 已停用' : !channel.configured ? ' · 待配置凭据' : ''}`,
                options: channel.models.map((model) => ({
                  value: formatDeliveryChannelModel(
                    channel.id,
                    channel.version,
                    model,
                  ),
                  label: model,
                  disabled: !channel.enabled || !channel.configured,
                })),
              })),
              ...(stale
                ? [
                    {
                      label: '原固定版本',
                      options: [
                        {
                          value: selected,
                          label: `${displayDeliveryModel(selected)} · 配置已变化，请重新选择`,
                          disabled: true,
                        },
                      ],
                    },
                  ]
                : []),
            ];
            return (
              <fieldset className="role-fields" key={role}>
                <legend>{roleNames[role]}</legend>
                <div className="field">
                  <label htmlFor={`${role}-model`}>模型渠道与模型</label>
                  <Select
                    id={`${role}-model`}
                    value={customModels[role] ? '__custom__' : selected}
                    options={choices}
                    disabled={busy}
                    showSearch
                    optionFilterProp="label"
                    onChange={(value) => {
                      setCustomModels((current) => ({
                        ...current,
                        [role]: value === '__custom__',
                      }));
                      setProfiles((current) => ({
                        ...current,
                        [role]: {
                          ...current[role],
                          model: value === '__custom__' ? '' : value,
                        },
                      }));
                    }}
                  />
                </div>
                {customModels[role] ? (
                  <label className="field">
                    部署渠道模型名称
                    <Input
                      value={selected}
                      placeholder={
                        initial.model.name || '填写部署服务支持的模型标识'
                      }
                      maxLength={500}
                      disabled={busy}
                      onChange={(event) =>
                        setProfiles((current) => ({
                          ...current,
                          [role]: {
                            ...current[role],
                            model: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                ) : null}
                <label className="field">
                  补充要求
                  <Input.TextArea
                    value={profiles[role]?.instructions ?? ''}
                    onChange={(e) =>
                      setProfiles((current) => ({
                        ...current,
                        [role]: {
                          ...current[role],
                          instructions: e.target.value,
                        },
                      }))
                    }
                    rows={2}
                    maxLength={6000}
                    disabled={busy}
                  />
                </label>
              </fieldset>
            );
          })}
          <ErrorText value={error} />
          <div className="dialog-actions">
            <Button disabled={busy} onClick={requestClose}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" loading={busy}>
              保存配置
            </Button>
          </div>
        </form>
      </Modal>
      {confirmation}
    </>
  );
}
function RunDetail({
  client,
  runId,
  close,
}: {
  client: ProductClient;
  runId: string;
  close: () => void;
}) {
  const detail = useProductResource<DeliveryDetail>(
    client,
    'run',
    { run: runId },
    true,
  );
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const drafts = useProductResource<{ drafts: ProjectDraft[] }>(
    client,
    'drafts',
    { project: client.projectId },
    true,
  );
  const [confirmation, setConfirmation] = useState('');
  const [reconciliation, setReconciliation] = useState('');
  const run = detail.data?.run;
  const artifact = run?.artifact;
  const deploymentDrafts =
    drafts.data?.drafts.filter(
      (d) =>
        (d.action.kind === 'delivery.deploy' ||
          d.action.kind === 'delivery.rollback') &&
        d.action.runId === runId,
    ) ?? [];
  const unknownDraft = deploymentDrafts.find((d) => d.status === 'unknown');
  async function reconcile(draftId: string, confirmNotPublished = false) {
    setBusy('reconcile');
    setError('');
    setReconciliation('');
    try {
      const result = await actProduct<{ outcome: string }>(
        client,
        'reconcile-deployment',
        { runId, draftId, confirmNotPublished },
      );
      if (result.outcome === 'confirmation_required') {
        setConfirmation(draftId);
        setReconciliation(
          '核对完成：本地发布目录中未发现此审批的发布记录。请结合实际入口确认后，再申请一个新版本草案。',
        );
      } else {
        setConfirmation('');
        setReconciliation(
          result.outcome === 'recovered'
            ? '已根据持久发布记录和实际健康检查恢复回执。'
            : '已记录未发布确认；可继续运行并提交新草案重新审批。',
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function control(command: string) {
    setBusy(command);
    setError('');
    try {
      await actProduct(client, 'control-run', { runId, action: command });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function propose(rollback = false) {
    if (!run || !artifact) return;
    setBusy('draft');
    setError('');
    try {
      await actProduct(client, 'create-draft', {
        projectId: client.projectId,
        title: rollback ? '回滚部署' : '部署已验证交付物',
        requestId: crypto.randomUUID(),
        action: rollback
          ? {
              kind: 'delivery.rollback',
              runId,
              deploymentId: run.deployment!.id,
              contentHash: run.deployment!.contentHash,
              version: run.revision,
            }
          : {
              kind: 'delivery.deploy',
              runId,
              artifactRef: artifact.artifactRef,
              contentHash: artifact.contentHash,
              version: run.revision,
            },
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  const artifactBase = `/api/workspaces/${client.workspace.id}/artifacts/${runId}`;
  return (
    <Drawer title="运行详情与交付证据" open onClose={close} size="large">
      <ResourceState
        error={detail.error}
        loading={!detail.data && detail.loading}
        retry={detail.reload}
      >
        {run ? (
          <>
            <h2>{run.goal}</h2>
            <p className="plain-text muted">验收：{run.acceptance}</p>
            <p>
              {statuses[run.status]} · {phases[run.phase]}
            </p>
            <p className="muted">
              模型调用 {run.usedCalls}/{run.budgetCalls} · Tokens{' '}
              {run.usedTokens}/{run.budgetTokens} · 返工 {run.revision}/
              {run.maxRevisions}
            </p>
            {run.error ? <p className="form-error">{run.error}</p> : null}
            <div className="row-actions">
              {['queued', 'running'].includes(run.status) ? (
                <Button
                  disabled={!!busy}
                  loading={busy === 'pause'}
                  onClick={() => void control('pause')}
                >
                  暂停运行
                </Button>
              ) : null}
              {[
                'paused',
                'needs_auth',
                'needs_configuration',
                'needs_decision',
                'failed',
                ...(deploymentDrafts[0] &&
                ['rejected', 'failed'].includes(deploymentDrafts[0].status)
                  ? ['awaiting_deployment']
                  : []),
              ].includes(run.status) ? (
                <Button
                  disabled={!!busy}
                  loading={busy === 'resume'}
                  onClick={() => void control('resume')}
                >
                  继续运行
                </Button>
              ) : null}
              {!['delivered', 'cancelled'].includes(run.status) ? (
                <Button
                  danger
                  disabled={!!busy}
                  onClick={() => void control('cancel')}
                >
                  取消后续执行
                </Button>
              ) : null}
            </div>
            {unknownDraft ? (
              <div className="notice">
                <h3>部署结果需要核对</h3>
                <p>
                  请求结果未知，不会重新发送。先核对持久发布记录和实际入口。
                </p>
                <Button
                  disabled={!!busy}
                  loading={busy === 'reconcile'}
                  onClick={() => void reconcile(unknownDraft.id)}
                >
                  核对部署实际结果
                </Button>
                {confirmation === unknownDraft.id ? (
                  <div className="row-actions">
                    <Button onClick={() => setConfirmation('')}>
                      保留未知状态
                    </Button>
                    <Button
                      disabled={!!busy}
                      onClick={() => void reconcile(unknownDraft.id, true)}
                    >
                      确认未发布，重新提案
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {reconciliation ? <p role="status">{reconciliation}</p> : null}
            <RunBudget client={client} run={run} />
            <ErrorText value={error} />
            <Tabs
              items={[
                {
                  key: 'events',
                  label: '阶段记录',
                  children: (
                    <ol className="thread-list">
                      {detail.data?.events.map((event) => (
                        <li key={event.sequence}>
                          <strong>
                            {phases[event.phase]}
                            {event.role ? ` · ${roleNames[event.role]}` : ''}
                          </strong>
                          <p>{event.summary}</p>
                          <p className="muted">
                            <Timestamp value={event.createdAt} />
                          </p>
                        </li>
                      ))}
                    </ol>
                  ),
                },
                {
                  key: 'documents',
                  label: '方案与交接',
                  children: detail.data?.documents.length ? (
                    <div>
                      {detail.data.documents.map((doc, index) => (
                        <details
                          className="document-version"
                          key={`${doc.kind}-${doc.version}-${index}`}
                        >
                          <summary>
                            {roleNames[doc.role]} · {documentName(doc.kind)} ·
                            版本 {doc.version}
                          </summary>
                          <p className="muted">
                            <Timestamp value={doc.createdAt} />
                          </p>
                          <pre className="document-content">{doc.content}</pre>
                        </details>
                      ))}
                    </div>
                  ) : (
                    <Empty title="方案尚未生成" />
                  ),
                },
                {
                  key: 'artifacts',
                  label: '交付物',
                  children: artifact ? (
                    <>
                      <h3>
                        版本 {run.revision + 1} ·{' '}
                        {artifact.passed ? '验证通过' : '验证未通过'}
                      </h3>
                      <p className="muted">
                        验证时间 <Timestamp value={artifact.verifiedAt} />
                      </p>
                      <p className="muted">
                        这里记录构建、行为测试与入口检查；交互效果请打开预览验收。
                      </p>
                      <div className="row-actions">
                        <Button
                          disabled={!artifact.passed}
                          onClick={() => setPreview((v) => !v)}
                        >
                          {preview ? '收起预览' : '打开隔离预览'}
                        </Button>
                        <a
                          className="download-link"
                          href={`${artifactBase}?download=1`}
                        >
                          下载交付包
                        </a>
                        {artifact.passed && !run.deployment ? (
                          <Button
                            loading={busy === 'draft'}
                            disabled={!!busy}
                            onClick={() => void propose()}
                          >
                            申请本地演示部署
                          </Button>
                        ) : null}
                      </div>
                      {preview ? (
                        <iframe
                          title="交付物隔离预览"
                          sandbox="allow-scripts allow-forms"
                          src={`${artifactBase}/preview/index.html`}
                          className="artifact-preview"
                          referrerPolicy="no-referrer"
                        />
                      ) : null}
                      <details>
                        <summary>文件清单与内容摘要</summary>
                        <p>
                          <code>{artifact.contentHash}</code>
                        </p>
                        <ul className="file-manifest">
                          {artifact.files.map((file) => (
                            <li key={file.path}>
                              <span>{file.path}</span>
                              <span className="muted">{file.size} 字节</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                      {artifact.commands.map((command, index) => (
                        <details key={index} className="document-version">
                          <summary>
                            {command.exitCode === 0 ? '通过' : '失败'} ·{' '}
                            {command.command.join(' ')}
                          </summary>
                          <pre>{command.output}</pre>
                        </details>
                      ))}
                      {run.deployment ? (
                        <>
                          <h3 className="subsection-heading">部署记录</h3>
                          <p>
                            {run.deployment.status === 'healthy'
                              ? '健康检查通过'
                              : run.deployment.status === 'rolled_back'
                                ? '已回滚'
                                : '部署失败'}{' '}
                            · 本地演示环境 · 版本 {run.deployment.version}
                          </p>
                          <p className="muted">
                            健康检查{' '}
                            <Timestamp value={run.deployment.healthCheckedAt} />
                          </p>
                          <div className="row-actions">
                            <a
                              href={`${artifactBase}/deployment/index.html`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              打开部署入口
                            </a>
                            {run.deployment.previousDeploymentId ? (
                              <Button
                                disabled={!!busy}
                                onClick={() => void propose(true)}
                              >
                                申请回滚
                              </Button>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <Empty title="还没有可交付产物">
                      代码生成后仍需真实执行测试、构建与交叉验收。
                    </Empty>
                  ),
                },
              ]}
            />
          </>
        ) : null}
      </ResourceState>
    </Drawer>
  );
}

function RunBudget({
  client,
  run,
}: {
  client: ProductClient;
  run: DeliveryRun;
}) {
  const [calls, setCalls] = useState(run.budgetCalls);
  const [tokens, setTokens] = useState(run.budgetTokens);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function save() {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await actProduct(client, 'extend-budget', {
        runId: run.id,
        calls,
        tokens,
      });
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="budget-settings">
      <summary>调整累计预算</summary>
      <p className="form-help">
        仅发起人可增加上限；已用预算始终保留。保存后可继续运行。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="form-grid">
          <label className="field">
            总调用上限
            <input
              type="number"
              required
              min={run.budgetCalls}
              max={100}
              value={calls}
              onChange={(e) => setCalls(Number(e.target.value))}
            />
          </label>
          <label className="field">
            总 Token 上限
            <input
              type="number"
              required
              min={run.budgetTokens}
              max={2000000}
              value={tokens}
              onChange={(e) => setTokens(Number(e.target.value))}
            />
          </label>
        </div>
        <ErrorText value={error} />
        {saved ? <p role="status">累计预算已更新。</p> : null}
        <div className="row-actions">
          <Button htmlType="submit" loading={busy}>
            增加预算上限
          </Button>
        </div>
      </form>
    </details>
  );
}

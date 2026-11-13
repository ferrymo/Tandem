'use client';
import { useState } from 'react';
import { Button } from 'antd';
import type { ProjectDraft } from '@tandem/core';
import { errorMessage } from './collaboration-types';
import {
  actProduct,
  Empty,
  ErrorText,
  ResourceState,
  Timestamp,
  useProductResource,
  type ProductClient,
} from './product-api';

export const draftStatus: Record<ProjectDraft['status'], string> = {
  pending: '待审阅',
  approved: '已批准 · 等待执行',
  rejected: '已退回',
  executing: '执行中',
  succeeded: '执行成功',
  failed: '执行失败',
  unknown: '结果未知 · 请核对外部记录',
};
const validDate = (value: string | null) =>
  !!value && !value.startsWith('0000-') && Number.isFinite(Date.parse(value));
const dateLabel = (value: string) =>
  validDate(value) ? value.slice(0, 10) : '待记录';
const transitionNames = {
  start: '开始任务',
  pause: '暂停任务',
  finish: '完成任务',
  close: '关闭任务',
};
export function DraftsPanel({
  client,
  revise,
}: {
  client: ProductClient;
  revise?: (draft: ProjectDraft) => void;
}) {
  const result = useProductResource<{ drafts: ProjectDraft[] }>(
    client,
    'drafts',
    { project: client.projectId },
    true,
  );
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function review(draft: ProjectDraft, approve: boolean) {
    setBusy(draft.id);
    setError('');
    try {
      await actProduct(client, 'review-draft', {
        draftId: draft.id,
        version: draft.version,
        approve,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="content-panel">
      <div className="section-heading">
        <div>
          <h2>草案与决策</h2>
          <p className="muted">
            批准绑定当前版本，由原发起账号执行。修改后须重新审阅。
          </p>
        </div>
        <Button onClick={result.reload}>刷新草案</Button>
      </div>
      <ErrorText value={error} />
      <ResourceState
        error={result.error}
        loading={!result.data && result.loading}
        retry={result.reload}
      >
        {!result.data?.drafts.length ? (
          <Empty title="没有待处理草案">
            外部任务变更、工具写入和部署会在这里等待审阅。
          </Empty>
        ) : (
          <ul className="product-rows draft-list">
            {result.data.drafts.map((draft) => (
              <li key={draft.id}>
                <div className="grow">
                  <div className="row-heading">
                    <h3>{draft.title}</h3>
                    <span className={`state-label state-${draft.status}`}>
                      {draftStatus[draft.status]}
                    </span>
                  </div>
                  <p className="muted">
                    版本 {draft.version} ·{' '}
                    <Timestamp
                      value={
                        validDate(draft.updatedAt) ? draft.updatedAt : null
                      }
                    />
                  </p>
                  <DraftContent draft={draft} />
                  <details>
                    <summary>执行身份与审批记录</summary>
                    <p className="muted">
                      发起成员：<code>{draft.actorId}</code>
                    </p>
                    <p className="muted">
                      审批成员：{draft.reviewerId ?? '尚未审批'} ·{' '}
                      <Timestamp
                        value={
                          validDate(draft.reviewedAt) ? draft.reviewedAt : null
                        }
                      />
                    </p>
                  </details>
                  {draft.receipt ? (
                    <p role="status">
                      执行回执：{draft.receipt.summary ?? draft.receipt.status}
                      {draft.receipt.taskId
                        ? ` · 任务 #${draft.receipt.taskId}`
                        : ''}
                    </p>
                  ) : null}
                  {draft.error ? (
                    <p className="form-error">执行未完成：{draft.error}</p>
                  ) : null}
                  <div className="row-actions">
                    {draft.status === 'pending' ? (
                      <>
                        <Button
                          type="primary"
                          loading={busy === draft.id}
                          disabled={!!busy}
                          onClick={() => void review(draft, true)}
                        >
                          批准版本 {draft.version}
                        </Button>
                        <Button
                          disabled={!!busy}
                          onClick={() => void review(draft, false)}
                        >
                          退回修改
                        </Button>
                      </>
                    ) : null}
                    {revise &&
                    ['pending', 'rejected', 'failed'].includes(draft.status) &&
                    (draft.action.kind === 'task.create' ||
                      draft.action.kind === 'task.update') ? (
                      <Button disabled={!!busy} onClick={() => revise(draft)}>
                        修改草案
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ResourceState>
    </section>
  );
}
function DraftContent({ draft }: { draft: ProjectDraft }) {
  const a = draft.action;
  if (a.kind === 'task.create')
    return (
      <dl className="compact-details">
        <div>
          <dt>操作</dt>
          <dd>创建任务</dd>
        </div>
        <div>
          <dt>任务</dt>
          <dd>{a.name}</dd>
        </div>
        <div>
          <dt>说明</dt>
          <dd className="plain-text">{a.description || '未填写'}</dd>
        </div>
        <div>
          <dt>负责人 / 工期</dt>
          <dd>
            {a.assignedTo} · {a.startDate} 至 {a.deadline} · {a.estimate} 小时
          </dd>
        </div>
      </dl>
    );
  if (a.kind === 'task.update')
    return (
      <dl className="compact-details">
        <div>
          <dt>操作</dt>
          <dd>修改任务 #{a.taskId}</dd>
        </div>
        {Object.entries(a.changes).map(([key, value]) => (
          <div key={key}>
            <dt>
              {{
                name: '名称',
                description: '说明',
                assignedTo: '负责人',
                priority: '优先级',
                estimate: '预计工时',
                deadline: '截止日期',
              }[key] ?? key}
            </dt>
            <dd className="plain-text">{String(value)}</dd>
          </div>
        ))}
      </dl>
    );
  if (a.kind === 'task.status')
    return (
      <dl className="compact-details">
        <div>
          <dt>操作</dt>
          <dd>
            {transitionNames[a.transition]} · #{a.taskId}
          </dd>
        </div>
        {a.transition === 'start' ? (
          <>
            <div>
              <dt>开始后累计耗时</dt>
              <dd>{a.consumed} 小时</dd>
            </div>
            <div>
              <dt>剩余工时</dt>
              <dd>{a.left} 小时</dd>
            </div>
          </>
        ) : null}
        {a.transition === 'finish' ? (
          <>
            <div>
              <dt>本次新增耗时</dt>
              <dd>{a.consumed} 小时</dd>
            </div>
            <div>
              <dt>实际开始</dt>
              <dd>
                <Timestamp
                  value={
                    a.realStarted && validDate(a.realStarted)
                      ? a.realStarted
                      : null
                  }
                />
              </dd>
            </div>
            <div>
              <dt>实际完成</dt>
              <dd>
                <Timestamp
                  value={
                    a.finishedDate && validDate(a.finishedDate)
                      ? a.finishedDate
                      : null
                  }
                />
              </dd>
            </div>
          </>
        ) : null}
        <div>
          <dt>流转说明</dt>
          <dd className="plain-text">{a.comment || '未填写'}</dd>
        </div>
      </dl>
    );
  if (a.kind === 'task.effort')
    return (
      <dl className="compact-details">
        <div>
          <dt>操作</dt>
          <dd>登记工时 · #{a.taskId}</dd>
        </div>
        <div>
          <dt>登记日期</dt>
          <dd>{dateLabel(a.date)}</dd>
        </div>
        <div>
          <dt>本次新增耗时</dt>
          <dd>{a.consumed} 小时</dd>
        </div>
        <div>
          <dt>登记后剩余</dt>
          <dd>
            {a.left} 小时{a.left === 0 ? ' · 连接系统可能同步完成状态' : ''}
          </dd>
        </div>
        <div>
          <dt>工作内容</dt>
          <dd className="plain-text">{a.work}</dd>
        </div>
      </dl>
    );
  if (a.kind === 'delivery.deploy')
    return (
      <dl className="compact-details">
        <div>
          <dt>操作</dt>
          <dd>发布已验证产物至本地演示环境</dd>
        </div>
        <div>
          <dt>内容摘要</dt>
          <dd>
            <code>{a.contentHash}</code>
          </dd>
        </div>
        <div>
          <dt>运行</dt>
          <dd>{a.runId}</dd>
        </div>
      </dl>
    );
  if (a.kind === 'delivery.rollback')
    return (
      <p>
        回滚当前部署，目标记录：<code>{a.deploymentId}</code>
      </p>
    );
  if (a.kind === 'mcp.call')
    return (
      <div className="draft-tool">
        <p>
          工具写入：{a.serverId} / {a.toolName} · 配置版本 {a.serverRevision}
        </p>
        <pre>{JSON.stringify(a.arguments, null, 2)}</pre>
      </div>
    );
  return <pre>{JSON.stringify(a, null, 2)}</pre>;
}

'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import rehypeSanitize from 'rehype-sanitize';
import { Button, Input, Select, Segmented } from 'antd';
import type { WorkDocument, WorkSurfaceProps } from './work-management-types';
import { day, can, hasProjectWriteAccess } from './work-management-types';
import {
  WorkEditor,
  TextField,
  ChoiceField,
  WorkEmpty,
  AttachmentList,
  AttachmentUpload,
} from './work-shared';
import { guardUnsavedNavigation } from './use-unsaved-changes';

const MarkdownEditor = dynamic(() => import('@uiw/react-md-editor'), {
  ssr: false,
  loading: () => <p className="muted">正在加载编辑器…</p>,
});
const Markdown = dynamic(
  () => import('@uiw/react-md-editor').then((m) => m.default.Markdown),
  { ssr: false },
);
const scopeLabels = {
  project: '项目空间',
  team: '团队空间',
  personal: '个人空间',
};
export function DocumentsManagement(props: WorkSurfaceProps) {
  const { data, client, onCommand } = props;
  const [scope, setScope] = useState<WorkDocument['scope']>('project');
  const [owner, setOwner] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [editing, setEditing] = useState<WorkDocument | 'new' | null>(null);
  const docs = data.documents.filter(
    (d) =>
      d.scope === scope &&
      (!owner ||
        (scope === 'project' ? d.projectId === owner : d.teamId === owner)) &&
      d.title.toLowerCase().includes(query.toLowerCase()),
  );
  const doc =
    (data.documents.find((d) => d.id === selected) &&
      docs.find((d) => d.id === selected)) ||
    docs[0];
  const canEdit =
    doc &&
    can(data, 'document.manage') &&
    (doc.scope === 'personal'
      ? doc.ownerId === data.actorId
      : doc.scope === 'project'
        ? hasProjectWriteAccess(data, doc.projectId!)
        : data.teams.some((t) => t.id === doc.teamId));
  function changeScope(value: WorkDocument['scope']) {
    guardUnsavedNavigation(() => {
      setScope(value);
      setOwner('');
      setSelected('');
    });
  }
  return (
    <>
      <div className="work-page-actions">
        <Segmented
          aria-label="文档空间"
          value={scope}
          options={Object.entries(scopeLabels).map(([value, label]) => ({
            value,
            label,
          }))}
          onChange={(v) => changeScope(v as WorkDocument['scope'])}
        />
        <Button
          type="primary"
          onClick={() => setEditing('new')}
          disabled={
            !can(data, 'document.manage') ||
            (scope === 'project' && !data.projects.length) ||
            (scope === 'team' && !data.teams.length)
          }
        >
          ＋ 新建文档
        </Button>
      </div>
      <p className="space-description">
        {scope === 'project'
          ? '方案、报价、技术与部署资料，随项目沉淀。'
          : scope === 'team'
            ? '团队规范与跨项目资料，集中共享。'
            : '个人研究、工作风格与笔记，仅自己可见。'}
      </p>
      <div className="document-layout">
        <aside className="document-index">
          <div className="document-filters">
            {scope !== 'personal' ? (
              <Select
                aria-label="文档所属范围"
                value={owner}
                onChange={(v) => {
                  setOwner(v);
                  setSelected('');
                }}
                options={[
                  {
                    value: '',
                    label: scope === 'project' ? '全部项目' : '全部团队',
                  },
                  ...(scope === 'project' ? data.projects : data.teams).map(
                    (p) => ({ value: p.id, label: p.name }),
                  ),
                ]}
              />
            ) : null}
            <Input
              aria-label="搜索文档"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索文档标题"
              allowClear
            />
          </div>
          <nav aria-label="文档列表">
            {docs.map((d) => (
              <button
                key={d.id}
                className={`document-index-item ${doc?.id === d.id ? 'selected' : ''}`}
                onClick={() => guardUnsavedNavigation(() => setSelected(d.id))}
              >
                <span>{d.title}</span>
                <small>
                  {d.visibility === 'private'
                    ? '仅自己可见'
                    : scopeLabels[d.scope]}{' '}
                  · {day(d.updatedAt)}
                </small>
              </button>
            ))}
          </nav>
          {!docs.length ? <p className="group-hint">这里还没有文档。</p> : null}
        </aside>
        <article className="document-reader" data-color-mode="light">
          {doc ? (
            <>
              <header>
                <div>
                  <h2>{doc.title}</h2>
                  <p className="muted">
                    {scopeLabels[doc.scope]} ·{' '}
                    {doc.visibility === 'private'
                      ? '仅自己可见'
                      : '范围内成员可见'}{' '}
                    · 版本 {doc.version} · 更新于 {day(doc.updatedAt)}
                  </p>
                </div>
                {canEdit ? (
                  <Button onClick={() => setEditing(doc)}>编辑文档</Button>
                ) : null}
              </header>
              <div className="markdown-content">
                <Markdown
                  source={doc.body || '尚未添加正文。'}
                  rehypePlugins={[rehypeSanitize]}
                />
              </div>
              <section className="document-attachments">
                <h3>附件</h3>
                <AttachmentList
                  attachments={data.attachments.filter(
                    (a) => a.documentId === doc.id,
                  )}
                  workspaceId={client.workspace.id}
                  {...(canEdit ? { onRemove: client.refresh } : {})}
                />
                {canEdit ? (
                  <AttachmentUpload
                    workspaceId={client.workspace.id}
                    owner={{ documentId: doc.id }}
                    onComplete={client.refresh}
                  />
                ) : null}
              </section>
            </>
          ) : (
            <WorkEmpty
              title="把知识留在合适的空间"
              description={
                scope === 'project' && !data.projects.length
                  ? '先创建项目，再保存项目资料。'
                  : scope === 'team' && !data.teams.length
                    ? '先在 Agents 中创建团队，再建立共享资料。'
                    : '创建一份 Markdown 文档，记录下一次协作需要的上下文。'
              }
            />
          )}
        </article>
      </div>
      {editing ? (
        <WorkEditor
          title={editing === 'new' ? '新建文档' : '编辑文档'}
          width={1000}
          initial={
            editing === 'new'
              ? {
                  title: '',
                  body: '',
                  scope,
                  projectId:
                    scope === 'project'
                      ? owner || data.projects[0]?.id || null
                      : null,
                  teamId:
                    scope === 'team'
                      ? owner || data.teams[0]?.id || null
                      : null,
                  visibility: scope === 'personal' ? 'private' : 'space',
                }
              : { ...editing }
          }
          command="save-document"
          onCommand={onCommand}
          close={() => setEditing(null)}
        >
          {(values, set) => (
            <>
              <TextField
                label="文档标题"
                name="title"
                values={values}
                set={set}
                required
              />
              <div className="form-grid">
                {values.scope === 'project' ? (
                  <ChoiceField
                    label="所属项目"
                    name="projectId"
                    values={values}
                    set={set}
                    options={data.projects.map((p) => ({
                      value: p.id,
                      label: p.name,
                    }))}
                  />
                ) : values.scope === 'team' ? (
                  <ChoiceField
                    label="所属团队"
                    name="teamId"
                    values={values}
                    set={set}
                    options={data.teams.map((p) => ({
                      value: p.id,
                      label: p.name,
                    }))}
                  />
                ) : null}
                {values.scope !== 'personal' ? (
                  <ChoiceField
                    label="可见范围"
                    name="visibility"
                    disabled={
                      editing !== 'new' && editing.ownerId !== data.actorId
                    }
                    values={values}
                    set={set}
                    options={[
                      { value: 'space', label: '当前范围内成员' },
                      { value: 'private', label: '仅自己可见' },
                    ]}
                  />
                ) : (
                  <p className="form-help">个人空间文档仅自己可见。</p>
                )}
              </div>
              <div className="field" data-color-mode="light">
                <label>文档正文 · Markdown</label>
                <MarkdownEditor
                  value={String(values.body ?? '')}
                  onChange={(value) => set('body', value ?? '')}
                  height={420}
                  previewOptions={{ rehypePlugins: [rehypeSanitize] }}
                  textareaProps={{ 'aria-label': '文档正文' }}
                />
              </div>
              <p className="form-help">
                支持标题、列表、链接、表格与代码块。附件请保存文档后单独上传。
              </p>
            </>
          )}
        </WorkEditor>
      ) : null}
    </>
  );
}

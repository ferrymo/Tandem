'use client';
import { Fragment, useState } from 'react';
import { Button, Drawer, Input, InputNumber, Modal, Select } from 'antd';
import type { WorkSurfaceProps } from './work-management-types';
import { errorMessage } from './collaboration-types';
import { useUnsavedChanges } from './use-unsaved-changes';

export function WorkEditor({
  title,
  initial,
  command,
  onCommand,
  close,
  children,
  width = 720,
  remove,
  removeTitle = '删除这条记录？',
}: {
  title: string;
  initial: Record<string, unknown>;
  command: string;
  onCommand: WorkSurfaceProps['onCommand'];
  close: () => void;
  children: (
    values: Record<string, unknown>,
    set: (key: string, value: unknown) => void,
  ) => React.ReactNode;
  width?: number;
  remove?: () => Promise<unknown>;
  removeTitle?: string;
}) {
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const [modal, modalContext] = Modal.useModal();
  const guard = useUnsavedChanges(values, close, busy || removing);
  async function requestRemove() {
    if (!remove || busy || removing) return;
    const confirmed = await modal.confirm({
      title: removeTitle,
      content: '仅删除已保存的空分类，已关联的业务资料会受到保护。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
    });
    if (!confirmed) return;
    setRemoving(true);
    setError('');
    try {
      await remove();
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRemoving(false);
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onCommand(command, values);
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Fragment key="unsaved-confirmation">{guard.confirmation}</Fragment>
      <Fragment key="remove-confirmation">{modalContext}</Fragment>
      <Drawer
        title={title}
        open
        onClose={guard.requestClose}
        size={width}
        destroyOnHidden
      >
        <form onSubmit={save} className="work-editor">
          <div className="work-editor-fields">
            {children(values, (key, value) =>
              setValues((old) => ({ ...old, [key]: value })),
            )}
          </div>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          <div className="editor-actions">
            {remove ? (
              <Button
                danger
                className="editor-remove"
                onClick={requestRemove}
                loading={removing}
                disabled={busy}
              >
                删除
              </Button>
            ) : null}
            <Button onClick={guard.requestClose} disabled={busy || removing}>
              取消
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={busy}
              disabled={removing}
            >
              保存
            </Button>
          </div>
        </form>
      </Drawer>
    </>
  );
}
export function TextField({
  label,
  name,
  values,
  set,
  required = false,
  multiline = false,
  type = 'text',
  help,
}: {
  label: string;
  name: string;
  values: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
  required?: boolean;
  multiline?: boolean;
  type?: string;
  help?: string;
}) {
  const id = `field-${name}`;
  return (
    <div className={`field${multiline ? ' field-wide' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required ? (
          <span className="required-mark" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      {multiline ? (
        <Input.TextArea
          id={id}
          value={String(values[name] ?? '')}
          onChange={(e) => set(name, e.target.value)}
          rows={4}
          maxLength={20000}
          required={required}
        />
      ) : (
        <Input
          id={id}
          type={type}
          value={String(values[name] ?? '')}
          onChange={(e) =>
            set(name, type === 'date' ? e.target.value || null : e.target.value)
          }
          required={required}
          maxLength={500}
        />
      )}
      {help ? <span className="form-help">{help}</span> : null}
    </div>
  );
}
export function NumberField({
  label,
  name,
  values,
  set,
  suffix,
}: {
  label: string;
  name: string;
  values: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
  suffix?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={`field-${name}`}>{label}</label>
      <InputNumber
        id={`field-${name}`}
        value={typeof values[name] === 'number' ? values[name] : null}
        onChange={(v) => set(name, v)}
        min={0}
        max={1000000000}
        step={0.5}
        suffix={suffix}
        style={{ width: '100%' }}
      />
    </div>
  );
}
export function ChoiceField({
  label,
  name,
  values,
  set,
  options,
  multiple = false,
  custom = false,
  nullable = false,
  disabled = false,
}: {
  label: string;
  name: string;
  values: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
  options: { label: string; value: string }[];
  multiple?: boolean;
  custom?: boolean;
  nullable?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={`field-${name}`}>{label}</label>
      <Select
        id={`field-${name}`}
        showSearch
        optionFilterProp="label"
        allowClear={nullable}
        disabled={disabled}
        {...(custom
          ? { mode: 'tags' as const }
          : multiple
            ? { mode: 'multiple' as const }
            : {})}
        value={(values[name] ?? undefined) as string | string[] | undefined}
        options={options}
        onChange={(v) => set(name, v ?? null)}
      />
    </div>
  );
}
export function StatusLabel({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  return (
    <span className={`work-status status-${value}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}
export function WorkEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="work-empty">
      <svg
        width="48"
        height="48"
        viewBox="0 0 48 48"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        aria-hidden="true"
      >
        <path d="M9 14h12l4 4h14v20H9zM9 14V9h12l4 5" />
        <path d="M19 28h10M24 23v10" />
      </svg>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function AttachmentList({
  attachments,
  workspaceId,
  onRemove,
}: {
  attachments: { id: string; name: string; size: number }[];
  workspaceId: string;
  onRemove?: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  return (
    <>
      <ul className="attachment-list">
        {attachments.map((file) => (
          <li key={file.id}>
            <a
              href={`/api/workspaces/${workspaceId}/attachments/${file.id}`}
              download
            >
              {file.name}
            </a>
            <span className="muted">
              {Math.max(1, Math.ceil(file.size / 1024))} KB
            </span>
            {onRemove ? (
              <Button
                type="text"
                size="small"
                loading={busy === file.id}
                onClick={async () => {
                  setBusy(file.id);
                  setError('');
                  try {
                    const response = await fetch(
                      `/api/workspaces/${workspaceId}/attachments/${file.id}`,
                      { method: 'DELETE' },
                    );
                    if (!response.ok)
                      throw new Error('附件未移除，请刷新后重试。');
                    onRemove();
                  } catch (cause) {
                    setError(errorMessage(cause));
                  } finally {
                    setBusy('');
                  }
                }}
              >
                移除
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
export function AttachmentUpload({
  workspaceId,
  owner,
  onComplete,
}: {
  workspaceId: string;
  owner: { taskId: string } | { documentId: string };
  onComplete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="attachment-upload">
      <label className="upload-button">
        {busy ? '正在上传…' : '添加附件'}
        <input
          type="file"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setError('');
            if (file.size > 20 * 1024 * 1024) {
              setError('文件超过20 MB，请选择较小的文件。');
              return;
            }
            setBusy(true);
            try {
              const body = new FormData();
              body.set('file', file);
              Object.entries(owner).forEach(([key, value]) =>
                body.set(key, value),
              );
              const response = await fetch(
                `/api/workspaces/${workspaceId}/attachments`,
                { method: 'POST', body },
              );
              if (!response.ok) {
                const value = await response.json();
                throw new Error(value?.error?.message ?? '上传失败，请重试。');
              }
              onComplete();
            } catch (cause) {
              setError(errorMessage(cause));
            } finally {
              setBusy(false);
              e.target.value = '';
            }
          }}
        />
      </label>
      <span className="form-help">单个文件最多20 MB</span>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

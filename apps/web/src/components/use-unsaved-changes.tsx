'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from 'antd';

type NavigationBlocker = (proceed: () => void) => void;
const navigationBlockers = new Set<NavigationBlocker>();
export function hasUnsavedChanges() {
  return navigationBlockers.size > 0;
}
export function guardUnsavedNavigation(proceed: () => void) {
  const blockers = [...navigationBlockers];
  const next = (index: number) => {
    if (index === blockers.length) proceed();
    else blockers[index]!(() => next(index + 1));
  };
  next(0);
}

/** Keep unsaved form values in memory until the user explicitly discards them. */
export function useUnsavedChanges(
  value: unknown,
  close: () => void,
  busy = false,
) {
  const current = JSON.stringify(value);
  const [initial] = useState(current);
  const dirty = initial !== current;
  const [modal, confirmation] = Modal.useModal();
  const confirming = useRef(false);
  const requestLeave = useCallback(
    (proceed: () => void) => {
      if (busy || confirming.current) return;
      if (!dirty) return proceed();
      confirming.current = true;
      modal.confirm({
        title: '放弃未保存的内容？',
        content: '内容尚未保存。继续编辑可保留当前输入，放弃更改后无法恢复。',
        okText: '放弃更改',
        cancelText: '继续编辑',
        autoFocusButton: 'cancel',
        onOk: proceed,
        afterClose: () => {
          confirming.current = false;
        },
      });
    },
    [busy, dirty, modal],
  );
  useEffect(() => {
    if (!dirty) return;
    navigationBlockers.add(requestLeave);
    return () => {
      navigationBlockers.delete(requestLeave);
    };
  }, [dirty, requestLeave]);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [dirty]);
  function requestClose() {
    requestLeave(close);
  }
  return { requestClose, confirmation };
}

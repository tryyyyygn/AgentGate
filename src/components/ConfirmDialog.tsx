import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from "react";
import { useI18n } from "../i18n";

interface ConfirmDialogProps {
  title: string;
  message: string;
  /** 正文下面的明细区。删会话时用来摆出「要删什么、又特意保留什么」。 */
  details?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 应用内确认弹窗，替代系统原生 confirm。
 *
 * Escape 或点击遮罩视为取消；确认按钮默认聚焦，危险操作使用红色主按钮。
 */
export function ConfirmDialog({
  title,
  message,
  details,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement {
  const { m } = useI18n();
  const layerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelText = cancelLabel ?? m.confirm.cancel;

  useEffect(() => {
    const layer = layerRef.current;
    const backgroundState: Array<{
      element: HTMLElement;
      inert: boolean;
      ariaHidden: string | null;
    }> = [];
    let branch: HTMLElement | null = layer;
    while (branch?.parentElement) {
      const parent = branch.parentElement;
      for (const element of parent.children) {
        if (!(element instanceof HTMLElement) || element === branch) continue;
        backgroundState.push({
          element,
          inert: element.inert,
          ariaHidden: element.getAttribute("aria-hidden"),
        });
      }
      if (parent.classList.contains("editor-layer")) break;
      branch = parent;
      if (parent === document.body) break;
    }
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    for (const state of backgroundState) {
      state.element.inert = true;
      state.element.setAttribute("aria-hidden", "true");
    }
    confirmRef.current?.focus();
    return () => {
      for (const state of backgroundState) {
        state.element.inert = state.inert;
        if (typeof state.ariaHidden === "string") {
          state.element.setAttribute("aria-hidden", state.ariaHidden);
        } else {
          state.element.removeAttribute("aria-hidden");
        }
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!dialog.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      ref={layerRef}
      className="editor-layer"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      style={{ zIndex: 85 }}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className="editor-scrim"
        aria-label={cancelText}
        tabIndex={-1}
        onClick={onCancel}
      />
      <div className="confirm-dialog" ref={dialogRef}>
        <h2>{title}</h2>
        <p>{message}</p>
        {details}
        <div className="confirm-foot">
          <button type="button" className="btn-ghost" onClick={onCancel}>{cancelText}</button>
          <button
            type="button"
            ref={confirmRef}
            className={danger ? "btn-danger" : "btn-accent"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

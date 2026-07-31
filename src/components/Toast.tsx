import { AlertCircle, CheckCircle2, Clipboard, X } from "lucide-react";
import type { ReactElement } from "react";
import { useI18n } from "../i18n";
import type { ToastState } from "../ui-types";

interface ToastProps {
  toast: ToastState;
  onClose: () => void;
}

function ToastIcon({ kind }: Pick<ToastState, "kind">): ReactElement {
  if (kind === "success") return <CheckCircle2 size={16} />;
  if (kind === "error") return <AlertCircle size={16} />;
  return <Clipboard size={16} />;
}

/**
 * 展示操作反馈。
 *
 * @param props 提示内容与关闭回调。
 * @returns 固定在窗口底部居中的深色提示胶囊。
 */
export function Toast({ toast, onClose }: ToastProps): ReactElement {
  const { m } = useI18n();
  return (
    <div className={`toast${toast.action ? " has-action" : ""}`} role="status">
      <span className={`toast-icon ${toast.kind}`}><ToastIcon kind={toast.kind} /></span>
      <span>{toast.message}</span>
      {toast.action && (
        <button type="button" className="toast-action" onClick={toast.action.onClick}>
          {toast.action.label}
        </button>
      )}
      <button type="button" className="toast-close" title={m.toast.close} onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}

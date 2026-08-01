export type View = "overview" | "keyring" | "status" | "wallet" | "activity" | "sessions" | "settings";

export type RequestFilter = "all" | "active" | "completed" | "failed";

export type BusyAction =
  | "load"
  | "save"
  | "duplicate"
  | "group"
  | "apply"
  | "test"
  | "delete"
  | "gateway-start"
  | "gateway-stop"
  | "restore-official"
  | "undo"
  | "settings";

export interface ToastState {
  kind: "success" | "error" | "info";
  message: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

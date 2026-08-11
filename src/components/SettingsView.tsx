import {
  ArrowDownToLine,
  CheckCircle2,
  Download,
  LoaderCircle,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  SunMoon,
  RotateCcw,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { CLIENT_META } from "../config";
import { LOCALE_LABELS, useI18n } from "../i18n";
import { formatDateTime } from "../lib/format";
import type { Messages } from "../i18n";
import type { AppLanguage, AppSettings, AppTheme, HistoryEntry, UpdateState } from "../types";

interface SettingToggleProps {
  title: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

function SettingToggle({
  title,
  checked,
  disabled,
  onChange,
}: SettingToggleProps): ReactElement {
  return (
    <label className={`settings-row ${disabled ? "disabled" : ""}`}>
      <span className="settings-row-copy">
        <strong>{title}</strong>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={`kd-switch ${checked ? "checked" : ""}`} aria-hidden="true"><span /></span>
    </label>
  );
}

const THEMES: Array<{ value: AppTheme; label: (m: Messages) => string; icon: ReactNode }> = [
  { value: "system", label: (m) => m.config.system, icon: <SunMoon size={12} /> },
  { value: "light", label: () => "α FIELD", icon: <Sun size={12} /> },
  { value: "dark", label: () => "β FIELD", icon: <Moon size={12} /> },
];

const LANGUAGES: AppLanguage[] = ["system", "zh", "zh-TW", "ja", "en"];

interface SettingsViewProps {
  active?: boolean;
  settings: AppSettings;
  busy: boolean;
  update?: UpdateState;
  version: string;
  onChange: (patch: Partial<AppSettings>) => void;
  onCheckUpdate: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  history?: ReadonlyArray<HistoryEntry>;
  onUndoHistory?: (entry: HistoryEntry) => void;
}

/** 更新区块：显示当前版本、检查更新与下载安装入口。 */
function UpdateRow({
  update,
  version,
  onCheck,
  onDownload,
  onInstall,
}: {
  update?: UpdateState;
  version: string;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}): ReactElement {
  const { m, fill } = useI18n();
  const state = update?.state ?? "idle";
  const checking = state === "checking";
  const downloading = state === "downloading";
  const description = state === "available"
    ? fill(m.config.updateAvailable, { version: update?.version ?? "" })
    : state === "downloading"
      ? fill(m.config.updateDownloading, { percent: update?.percent ?? 0 })
      : state === "ready"
        ? fill(m.config.updateReady, { version: update?.version ?? "" })
        : state === "up-to-date"
          ? m.config.updateLatest
          : state === "error"
            ? update?.message ?? m.config.updateFailed
            : fill(m.config.updateCurrent, { version });

  return (
    <div className="settings-theme-row">
      <span className="settings-row-copy">
        <strong className={state === "error" ? "tier-bad" : state === "ready" ? "tier-good" : ""}>
          {description}
        </strong>
      </span>
      {state === "ready" && !update?.portable ? (
        <button type="button" className="primary-pill" onClick={onInstall}>
          <ArrowDownToLine size={13} />{m.config.installRestart}
        </button>
      ) : state === "available" || state === "downloading" ? (
        <button type="button" className="primary-pill" disabled={downloading} onClick={onDownload}>
          {downloading
            ? <LoaderCircle size={13} className="spin" />
            : <Download size={13} />}
          {update?.portable
            ? m.config.goDownload
            : downloading ? `${update?.percent ?? 0}%` : m.config.download}
        </button>
      ) : (
        <button type="button" className="ghost-pill" disabled={checking} onClick={onCheck}>
          {checking
            ? <LoaderCircle size={13} className="spin" />
            : state === "up-to-date"
              ? <CheckCircle2 size={13} />
              : <RefreshCw size={13} />}
          {m.config.checkUpdate}
        </button>
      )}
    </div>
  );
}

function historyStatusLabel(entry: HistoryEntry, m: Messages): string {
  if (entry.status === "undone") return m.config.historyUndone;
  if (entry.status === "superseded") return m.config.historySuperseded;
  if (entry.status === "rolled-back") return m.config.historyRolledBack;
  if (entry.status === "failed" || !entry.success) return m.config.historyFailed;
  return m.config.historyApplied;
}

function historyStatusTone(entry: HistoryEntry): string {
  if (entry.status === "failed" || entry.status === "rolled-back" || !entry.success) return "tier-bad";
  if (entry.status === "superseded") return "tier-warn";
  return "tier-good";
}

function historyTargetLabel(target: HistoryEntry["targets"][number]): string {
  return CLIENT_META[target]?.label ?? target;
}

/** 设置页：启动与后台开关、语言、主题选择、软件更新和密钥安全说明。 */
export function SettingsView({
  active = true,
  settings,
  busy,
  update,
  version,
  onChange,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  history = [],
  onUndoHistory,
}: SettingsViewProps): ReactElement {
  const { locale, m, fill } = useI18n();
  return (
    <main className="page-scroll" aria-label={m.config.title} hidden={!active}>
      <div className="page-inner narrow">
        <div className="section-head rise">
          <h1>{m.config.title}</h1>
        </div>
        <div className="settings-card rise-1">
          <SettingToggle
            title={m.config.launchAtLogin}
            checked={settings.launchAtLogin}
            disabled={busy}
            onChange={(launchAtLogin) => onChange({ launchAtLogin })}
          />
          <SettingToggle
            title={m.config.closeToTray}
            checked={settings.closeToTray}
            disabled={busy}
            onChange={(closeToTray) => onChange({ closeToTray })}
          />
          <SettingToggle
            title={m.config.startGateway}
            checked={settings.startGatewayOnLaunch}
            disabled={busy}
            onChange={(startGatewayOnLaunch) => onChange({ startGatewayOnLaunch })}
          />
          <div className="settings-theme-row" style={{ borderTop: "1px solid var(--line)" }}>
            <span className="settings-row-copy">
              <strong>{m.config.routingMode}</strong>
            </span>
            <div className="theme-segments" role="radiogroup" aria-label={m.config.routingMode}>
              {([
                ["assignment", m.config.routingAssignment],
                ["weighted", m.config.routingWeighted],
              ] as const).map(([mode, label]) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.routing.mode === mode}
                  className={settings.routing.mode === mode ? "active" : ""}
                  disabled={busy}
                  key={mode}
                  onClick={() => onChange({ routing: { ...settings.routing, mode } })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {settings.routing.mode === "weighted" && (
            <div className="settings-theme-row">
              <span className="settings-row-copy">
                <strong>{m.config.routingStrategy}</strong>
              </span>
              <div className="theme-segments" role="radiogroup" aria-label={m.config.routingStrategy}>
                {([
                  ["fixed", m.config.routingFixed],
                  ["adaptive", m.config.routingAdaptive],
                ] as const).map(([strategy, label]) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={settings.routing.strategy === strategy}
                    className={settings.routing.strategy === strategy ? "active" : ""}
                    disabled={busy}
                    key={strategy}
                    onClick={() => onChange({ routing: { ...settings.routing, strategy } })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <UpdateRow
            update={update}
            version={version}
            onCheck={onCheckUpdate}
            onDownload={onDownloadUpdate}
            onInstall={onInstallUpdate}
          />
          <div className="settings-theme-row" style={{ borderTop: "1px solid var(--line)" }}>
            <span className="settings-row-copy">
              <strong>{m.config.language}</strong>
            </span>
            <div className="theme-segments" role="radiogroup" aria-label={m.config.language}>
              {LANGUAGES.map((language) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.language === language}
                  className={settings.language === language ? "active" : ""}
                  disabled={busy}
                  key={language}
                  onClick={() => onChange({ language })}
                >
                  {language === "system" ? m.config.system : LOCALE_LABELS[language]}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-theme-row">
            <span className="settings-row-copy">
              <strong>{m.config.attractorField}</strong>
            </span>
            <div className="theme-segments" role="radiogroup" aria-label={m.config.attractorField}>
              {THEMES.map((theme) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === theme.value}
                  className={settings.theme === theme.value ? "active" : ""}
                  disabled={busy}
                  key={theme.value}
                  onClick={() => onChange({ theme: theme.value })}
                >
                  {theme.icon}{theme.label(m)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="security-note rise-2">
          <ShieldCheck size={14} />
          <span>{m.config.security}</span>
        </p>
        <section className="history-panel rise-2" aria-label={m.config.history}>
          <div className="history-panel-head">
            <div>
              <span className="kicker">AUDIT LOG</span>
              <h2>{m.config.history}</h2>
            </div>
            <span>{history.length}</span>
          </div>
          {history.length === 0 ? (
            <p className="history-empty">{m.config.historyEmpty}</p>
          ) : (
            <div className="history-list">
              {history.slice(0, 12).map((entry) => (
                <article className="history-item" key={entry.id}>
                  <div className="history-item-main">
                    <strong>{entry.profileName}</strong>
                    <span>{entry.targets.map(historyTargetLabel).join(" · ")}</span>
                    <small>{formatDateTime(entry.createdAt, locale)} · {fill(m.config.historySource, {
                      source: entry.source === "auto" ? m.config.historyAuto : m.config.historyManual,
                    })} · {entry.connectionMode === "gateway" ? m.config.historyGateway : m.config.historyDirect}</small>
                  </div>
                  <div className="history-item-action">
                    <span className={historyStatusTone(entry)}>
                      {historyStatusLabel(entry, m)}
                    </span>
                    {entry.canUndo && onUndoHistory && (
                      <button type="button" className="icon-ghost" title={m.config.historyUndo} aria-label={m.config.historyUndo} disabled={busy} onClick={() => onUndoHistory(entry)}>
                        <RotateCcw size={13} />
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

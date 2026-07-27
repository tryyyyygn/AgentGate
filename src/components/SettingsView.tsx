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
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { LOCALE_LABELS, useI18n } from "../i18n";
import type { Messages } from "../i18n";
import type { AppLanguage, AppSettings, AppTheme, UpdateState } from "../types";

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
  settings: AppSettings;
  busy: boolean;
  update?: UpdateState;
  version: string;
  onChange: (patch: Partial<AppSettings>) => void;
  onCheckUpdate: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
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

/** 设置页：启动与后台开关、语言、主题选择、软件更新和密钥安全说明。 */
export function SettingsView({
  settings,
  busy,
  update,
  version,
  onChange,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
}: SettingsViewProps): ReactElement {
  const { m } = useI18n();
  return (
    <main className="page-scroll" aria-label={m.config.title}>
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
      </div>
    </main>
  );
}

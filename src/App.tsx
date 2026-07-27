import { Activity, KeyRound, LayoutDashboard, MessagesSquare, Minus, Radio, Settings, ShieldCheck, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { ActivityView } from "./components/ActivityView";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HintLayer } from "./components/HintLayer";
import { SessionsView } from "./components/SessionsView";
import { KeyringView } from "./components/KeyringView";
import { OverviewView } from "./components/OverviewView";
import { ProfileEditor } from "./components/ProfileEditor";
import { RollingNumber } from "./components/RollingNumber";
import { SettingsView } from "./components/SettingsView";
import { StatusView } from "./components/StatusView";
import { Toast } from "./components/Toast";
import { APP_VERSION, DEFAULT_SETTINGS } from "./config";
import { useAgentGateController } from "./hooks/useAgentGateController";
import { I18nProvider, useI18n } from "./i18n";
import type { Messages } from "./i18n";
import { api, isDesktop } from "./lib/api";
import type { Profile, SaveProfileInput } from "./types";
import type { View } from "./ui-types";

interface EditorState {
  open: boolean;
  profile?: Profile;
}

const NAV_ICONS: Record<View, ReactElement> = {
  overview: <LayoutDashboard size={13} />,
  keyring: <KeyRound size={13} />,
  status: <Radio size={13} />,
  activity: <Activity size={13} />,
  sessions: <MessagesSquare size={13} />,
  settings: <Settings size={13} />,
};

const NAV_LABEL: Record<View, (m: Messages) => string> = {
  overview: (m) => m.nav.overview,
  keyring: (m) => m.nav.keys,
  status: (m) => m.nav.status,
  activity: (m) => m.nav.stream,
  sessions: (m) => m.sessions.title,
  settings: (m) => m.nav.config,
};

const NAV_ORDER: View[] = ["overview", "keyring", "status", "activity", "sessions", "settings"];

/** 与 CSS 里 .theme-shifting 的过渡时长保持一致。 */
const THEME_SHIFT_MS = 460;

function isContextMenuTargetInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    "button, input, select, textarea, label, a, [role='button'], [role='radio'], [role='menuitem'], .mono, code",
  ));
}

/** 外层只负责把语言设置注入 I18nProvider，界面本体在 AppShell 里。 */
function App(): ReactElement {
  const controller = useAgentGateController();
  const language = (controller.data.settings ?? DEFAULT_SETTINGS).language;
  return (
    <I18nProvider locale={language}>
      <AppShell controller={controller} />
    </I18nProvider>
  );
}

function AppShell({ controller }: { controller: ReturnType<typeof useAgentGateController> }): ReactElement {
  const { locale, m, fill } = useI18n();
  const [view, setView] = useState<View>("overview");
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [pendingDelete, setPendingDelete] = useState<Profile>();
  const settings = controller.data.settings ?? DEFAULT_SETTINGS;
  const requestRecords = controller.data.activeRequests ?? [];
  const activeRequests = requestRecords.filter((request) => (
    !request.completedAt
    && ["connecting", "waiting-first-token", "streaming"].includes(request.state)
  ));
  const gateway = controller.data.gateway;
  const engagedCount = gateway.engaged.length;
  const gatewayOn = gateway.status === "running" || gateway.status === "starting";
  const routeCount = gateway.routes
    .filter((route) => controller.data.profiles.some((profile) => profile.id === route.profileId))
    .length;

  // 世界线跃迁：换主题时临时挂上 .theme-shifting，让所有颜色过渡而不是硬切。
  // 首次挂载不算「切换」，否则打开应用就会看到一次莫名的渐变。
  const themeMounted = useRef(false);
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = settings.theme;

    if (!themeMounted.current) {
      themeMounted.current = true;
      return undefined;
    }
    root.classList.add("theme-shifting");
    const timer = window.setTimeout(() => root.classList.remove("theme-shifting"), THEME_SHIFT_MS);
    return () => window.clearTimeout(timer);
  }, [settings.theme]);

  // 日文的字形与中文不同，行首禁则也各有一套，交给 CSS 按 lang 去挑。
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    function goBack(): void {
      if (editor.open) return;
      if (view !== "overview") setView("overview");
    }

    function handleKey(event: KeyboardEvent): void {
      if (event.ctrlKey && event.key.toLowerCase() === "n") {
        if (controller.busy || editor.open) return;
        event.preventDefault();
        setView("keyring");
        setEditor({ open: true });
        return;
      }
      if (event.key === "F5" && !controller.busy && !editor.open) {
        event.preventDefault();
        void controller.refresh();
        return;
      }
      if (event.key === "Escape" && !editor.open && view !== "overview") {
        event.preventDefault();
        goBack();
      }
    }

    function handleMouseBack(event: MouseEvent): void {
      if (event.button !== 3 || editor.open) return;
      if (view !== "overview") {
        event.preventDefault();
        goBack();
      }
    }

    window.addEventListener("keydown", handleKey);
    window.addEventListener("mousedown", handleMouseBack);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("mousedown", handleMouseBack);
    };
  }, [controller.busy, controller.refresh, editor.open, view]);

  async function handleSave(input: SaveProfileInput, useAfter: boolean): Promise<void> {
    const saved = await controller.saveProfile(input);
    if (!saved) return;
    setView("keyring");
    setEditor({ open: false });
    if (useAfter) await controller.applyProfile(saved.id);
  }

  async function confirmDelete(): Promise<void> {
    const profile = pendingDelete;
    setPendingDelete(undefined);
    if (profile) await controller.deleteProfile(profile);
  }

  function handleContextBack(event: ReactMouseEvent<HTMLElement>): void {
    if (editor.open || isContextMenuTargetInteractive(event.target)) return;
    if (view === "overview") return;
    event.preventDefault();
    setView("overview");
  }

  function goActivity(): void {
    setView("activity");
  }

  /*
   * 页脚状态：把数字（路由数、端口）从句子里拆出来单独交给滚轮，
   * 其余文字走淡入。整句拼成一个字符串的话，数字只能跟着硬切。
   */
  const statusLabel = gateway.status === "starting"
    ? m.overview.heroStarting
    : gateway.status === "stopping"
      ? m.overview.heroStopping
      : gateway.status === "error"
        ? m.overview.heroFault
        : gatewayOn ? m.gateway.online : m.gateway.offline;
  const statusError = gateway.status === "error" ? gateway.error : undefined;
  const statusDot = gateway.status === "error"
    ? "var(--bad)"
    : gateway.status === "running"
      ? "var(--good)"
      : "var(--warn)";

  return (
    <div className="app-shell" onContextMenu={handleContextBack}>
      <header className="topbar">
        <div className="brand-mark" aria-label="Agent;Gate">
          <strong>Agent;<span className="brand-g">G</span>ate</strong>
          <span className="brand-rule" aria-hidden="true" />
        </div>
        <nav className="top-nav" aria-label={m.nav.overview}>
          {NAV_ORDER.map((item) => (
            <button
              type="button"
              key={item}
              className={view === item ? "active" : ""}
              aria-current={view === item ? "page" : undefined}
              onClick={() => setView(item)}
            >
              {NAV_ICONS[item]}
              <span key={locale} className="swap-text">{NAV_LABEL[item](m)}</span>
              {item === "activity" && activeRequests.length > 0 && (
                <em>{activeRequests.length}</em>
              )}
              <i aria-hidden="true" />
            </button>
          ))}
        </nav>
        <div className="topbar-side">
          {/*
            端口。默认端口被别的程序占住时，用户在界面上本来没有别的出路——
            未接管任何客户端时点它就换一个空闲端口。运行中不能换：已写进客户端
            配置的地址会指向旧端口。
          */}
          <button
            type="button"
            className="port-chip"
            disabled={engagedCount > 0 || Boolean(controller.busy)}
            title={engagedCount > 0 ? undefined : m.overview.portHint}
            onClick={() => void controller.reassignPort()}
          >
            {/* 换端口是「跳变」，走整卷慢滚——和分歧率、Token 一个待遇 */}
            <RollingNumber value={`127.0.0.1:${gateway.port || 17863}`} />
          </button>
          {isDesktop && api.windowControl && (
            <div className="win-controls">
              <button
                type="button"
                title={m.window.minimize}
                aria-label={m.window.minimize}
                onClick={() => void api.windowControl?.("minimize")}
              >
                <Minus size={14} />
              </button>
              <button
                type="button"
                title={m.window.maximize}
                aria-label={m.window.maximize}
                onClick={() => void api.windowControl?.("maximize")}
              >
                <Square size={12} />
              </button>
              <button
                type="button"
                className="win-close"
                title={m.window.close}
                aria-label={m.window.close}
                onClick={() => void api.windowControl?.("close")}
              >
                <X size={15} />
              </button>
            </div>
          )}
        </div>
      </header>

      {view === "overview" && (
        <OverviewView
          profiles={controller.data.profiles}
          clients={controller.data.clients}
          gateway={gateway}
          requests={requestRecords}
          activeRequestCount={activeRequests.length}
          busy={Boolean(controller.busy)}
          onApply={(id, target) => void controller.applyProfile(id, [target])}
          onEngage={(target) => void controller.startGateway({
            port: gateway.port || 17863,
            targets: [target],
          })}
          onRelease={(target) => void controller.stopGateway({ targets: [target] })}
          onGoActivity={goActivity}
        />
      )}
      <KeyringView
        profiles={controller.data.profiles}
        gateway={gateway}
        busy={controller.busy}
        busyId={controller.busyId}
        loading={controller.busy === "load"}
        error={controller.bootstrapError}
        onCreate={() => setEditor({ open: true })}
        onEdit={(profile) => setEditor({ open: true, profile })}
        onDuplicate={(profile) => controller.duplicateProfile(profile)}
        onDelete={setPendingDelete}
        onApply={(id, targets) => void controller.applyProfile(id, targets)}
        onTest={(id) => void controller.checkProfileHealth(id)}
        onTestAll={() => void controller.checkAllProfilesHealth()}
        testingIds={controller.testingIds}
        onDiscoverModels={(id) => void controller.testProfile(id)}
        onProbe={(id) => void controller.probeProfile(id)}
        onCopyKey={(profile) => void controller.copyKey(profile)}
        onReorder={(ids) => void controller.reorderProfiles(ids)}
        onRetry={() => void controller.refresh()}
        active={view === "keyring"}
      />
      <StatusView
        profiles={controller.data.profiles}
        busy={Boolean(controller.busy)}
        busyId={controller.busyId}
        onApply={(id, targets) => void controller.applyProfile(id, targets)}
        active={view === "status"}
      />
      <ActivityView requests={requestRecords} active={view === "activity"} />
      <SessionsView
        active={view === "sessions"}
        onToast={(kind, message) => controller.setToast({ kind, message })}
      />
      {view === "settings" && (
        <SettingsView
          settings={settings}
          busy={controller.busy === "settings"}
          update={controller.data.update}
          version={APP_VERSION}
          onChange={(patch) => void controller.updateSettings(patch)}
          onCheckUpdate={() => void controller.checkForUpdate()}
          onDownloadUpdate={() => void controller.downloadUpdate()}
          onInstallUpdate={() => void controller.installUpdate()}
        />
      )}

      <footer className="status-footer" aria-live="polite">
        <span>
          <i className="status-dot" style={{ background: statusDot }} />
          <span key={statusLabel} className="swap-text">{statusLabel}</span>
          {statusError
            ? ` · ${statusError}`
            : (
              <>
                {gatewayOn && (
                  <>
                    {" · "}
                    <RollingNumber as="span" value={String(routeCount)} />
                    {" ROUTES"}
                  </>
                )}
                {" · "}
                <RollingNumber as="span" value={`127.0.0.1:${gateway.port}`} />
              </>
            )}
        </span>
        <span><ShieldCheck size={12} />{m.footer.sealed}</span>
        <span className="footer-right">
          <RollingNumber as="span" value={String(controller.data.profiles.length)} />
          {" "}{m.footer.profiles} / 4 {m.footer.clients} · Agent;Gate {APP_VERSION}
          {!isDesktop && ` · ${m.footer.preview}`}
        </span>
      </footer>

      {editor.open && (
        <ProfileEditor
          profile={editor.profile}
          busy={controller.busy === "save"}
          discovering={controller.busy === "test" && controller.busyId === editor.profile?.id}
          onDiscoverModels={(input) => controller.testProfileDraft(input)}
          onClose={() => setEditor({ open: false })}
          onSave={handleSave}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={fill(m.confirm.deleteTitle, { name: pendingDelete.name })}
          message={m.confirm.deleteMessage}
          confirmLabel={m.confirm.deleteConfirm}
          cancelLabel={m.confirm.cancel}
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(undefined)}
        />
      )}

      {controller.toast && (
        <Toast toast={controller.toast} onClose={() => controller.setToast(undefined)} />
      )}

      {/* 全应用唯一的提示层，替掉原生 title。元素只要写个 data-hint。 */}
      <HintLayer />
    </div>
  );
}

export default App;

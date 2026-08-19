import {
  AlertCircle,
  Check,
  CircleDollarSign,
  Clock3,
  Download,
  Infinity as InfinityIcon,
  LoaderCircle,
  LogIn,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  WalletCards,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { describeError, formatCompactDateTime, formatDateTime } from "../lib/format";
import type {
  SaveWalletInput,
  Wallet,
  WalletBalance,
  WalletBalanceStatus,
  WalletSubscription,
  WalletTemplate,
  WalletKeyImportGroupMode,
} from "../types";
import { ConfirmDialog } from "./ConfirmDialog";

interface WalletViewProps {
  active?: boolean;
  onToast: (kind: "success" | "error" | "info", message: string) => void;
  onProfilesChanged: () => void | Promise<void>;
}

interface WalletEditorProps {
  wallet?: Wallet;
  onSave: (input: SaveWalletInput, loginAfterSave: boolean) => Promise<void>;
  onClose: () => void;
}

interface WalletForm {
  name: string;
  siteUrl: string;
  template: WalletTemplate;
  apiKey: string;
  lowBalanceUsd: string;
}

const TEMPLATE_LABELS: Record<WalletTemplate, string> = {
  sub2api: "Sub2API",
  "new-api": "New API",
  "one-api": "One API",
};

export const WALLET_AUTO_REFRESH_MS = 5 * 60_000;
export const WALLET_CHECK_CONCURRENCY = 3;
const DAY_MS = 24 * 60 * 60_000;

function formatUsd(value: number | undefined, locale: string): string {
  if (value === undefined || !Number.isFinite(value)) return "——";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value);
}

function replaceWallet(wallets: Wallet[], updated: Wallet): Wallet[] {
  const found = wallets.some((wallet) => wallet.id === updated.id);
  return found
    ? wallets.map((wallet) => wallet.id === updated.id ? updated : wallet)
    : [updated, ...wallets];
}

export function primaryWalletSubscription(
  subscriptions: readonly WalletSubscription[] | undefined,
): WalletSubscription | undefined {
  return subscriptions?.reduce<WalletSubscription | undefined>((best, current) => {
    if (!best) return current;
    const bestRatio = best.dailyLimitUsd ? best.dailyUsedUsd / best.dailyLimitUsd : -1;
    const currentRatio = current.dailyLimitUsd ? current.dailyUsedUsd / current.dailyLimitUsd : -1;
    return currentRatio > bestRatio ? current : best;
  }, undefined);
}

function subscriptionDaysRemaining(expiresAt: string | undefined): number | undefined {
  if (!expiresAt) return undefined;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return undefined;
  return Math.max(0, Math.ceil((expiresAtMs - Date.now()) / DAY_MS));
}

function WalletEditor({ wallet, onSave, onClose }: WalletEditorProps): ReactElement {
  const { m, fill } = useI18n();
  const [form, setForm] = useState<WalletForm>({
    name: wallet?.name ?? "",
    siteUrl: wallet?.siteUrl ?? "",
    template: wallet?.template ?? "sub2api",
    apiKey: "",
    lowBalanceUsd: String(wallet?.lowBalanceUsd ?? 5),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const title = wallet
    ? fill(m.wallet.editTitle, { name: wallet.name })
    : m.wallet.createTitle;
  const normalizedFormSite = form.siteUrl.trim().replace(/\/+$/, "");
  const normalizedWalletSite = wallet?.siteUrl.replace(/\/+$/, "");
  const sessionReady = form.template === "sub2api"
    && wallet?.template === "sub2api"
    && wallet.credentialStatus === "ready"
    && normalizedFormSite === normalizedWalletSite;
  const loginAfterSave = form.template === "sub2api" && !sessionReady;
  const reusableApiKey = form.template !== "sub2api"
    && wallet?.credentialKind === "api-key"
    && wallet.credentialStatus === "ready";

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    nameRef.current?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function update<K extends keyof WalletForm>(key: K, value: WalletForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setError(undefined);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (event.key === "Escape" && !saving) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleMouseBack(event: ReactMouseEvent<HTMLDivElement>): void {
    if (event.button !== 3) return;
    event.preventDefault();
    event.stopPropagation();
    if (!saving) onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const lowBalanceUsd = Number(form.lowBalanceUsd);
    if (!Number.isFinite(lowBalanceUsd) || lowBalanceUsd < 0) {
      setError(m.wallet.thresholdInvalid);
      return;
    }

    setSaving(true);
    setError(undefined);
    try {
      await onSave({
        ...(wallet ? { id: wallet.id } : {}),
        name: form.name.trim(),
        siteUrl: form.siteUrl.trim(),
        template: form.template,
        apiKey: form.apiKey.trim() || undefined,
        lowBalanceUsd,
      }, loginAfterSave);
    } catch (caught) {
      setError(describeError(caught));
      setSaving(false);
    }
  }

  return (
    <div
      className="editor-layer"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseBack}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        type="button"
        className="editor-scrim"
        aria-label={m.editor.close}
        disabled={saving}
        onClick={onClose}
      />
      <form ref={dialogRef} className="editor-dialog wallet-editor" onSubmit={(event) => void submit(event)}>
        <header className="editor-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="editor-close"
            aria-label={m.editor.close}
            disabled={saving}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>

        <div className="editor-body">
          {error && (
            <div className="editor-error" role="alert">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}

          <div className="field-grid wallet-field-grid">
            <label className="field-block">
              <span className="field-name">{m.wallet.name}</span>
              <input
                ref={nameRef}
                value={form.name}
                maxLength={80}
                required
                onChange={(event) => update("name", event.target.value)}
                placeholder={m.wallet.namePlaceholder}
              />
            </label>
            <label className="field-block">
              <span className="field-name">{m.wallet.template}</span>
              <select
                value={form.template}
                onChange={(event) => update("template", event.target.value as WalletTemplate)}
              >
                {(Object.keys(TEMPLATE_LABELS) as WalletTemplate[]).map((template) => (
                  <option value={template} key={template}>{TEMPLATE_LABELS[template]}</option>
                ))}
              </select>
            </label>
            <label className="field-block wallet-field-wide">
              <span className="field-name">{m.wallet.siteUrl}</span>
              <input
                type="url"
                value={form.siteUrl}
                maxLength={2048}
                required
                spellCheck={false}
                onChange={(event) => update("siteUrl", event.target.value)}
                placeholder="https://relay.example.com"
              />
            </label>
            {form.template === "sub2api" ? (
              <div className="field-block">
                <span className="field-name">{m.wallet.accountLogin}</span>
                <div className={`wallet-auth-control ${sessionReady ? "ready" : "missing"}`}>
                  {sessionReady ? <Check size={13} /> : <LogIn size={13} />}
                  <span>{sessionReady ? wallet?.credentialHint ?? m.wallet.accountLogin : m.wallet.notSignedIn}</span>
                </div>
              </div>
            ) : (
              <label className="field-block">
                <span className="field-name">
                  {m.wallet.apiKey}
                  {reusableApiKey && wallet?.credentialHint && (
                    <small>{fill(m.wallet.keyKeepHint, { hint: wallet.credentialHint })}</small>
                  )}
                </span>
                <input
                  type="password"
                  value={form.apiKey}
                  maxLength={8192}
                  required={!reusableApiKey}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => update("apiKey", event.target.value)}
                  placeholder={reusableApiKey ? m.editor.keyPlaceholder : "sk-..."}
                />
              </label>
            )}
            <label className="field-block">
              <span className="field-name">{m.wallet.threshold}</span>
              <input
                type="number"
                value={form.lowBalanceUsd}
                min="0"
                max="1000000000"
                step="0.01"
                required
                onChange={(event) => update("lowBalanceUsd", event.target.value)}
              />
            </label>
          </div>
        </div>

        <footer className="editor-foot">
          <button type="button" className="btn-ghost" disabled={saving} onClick={onClose}>
            {m.editor.cancel}
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving && <LoaderCircle size={13} className="spin" />}
            {saving ? m.editor.saving : loginAfterSave ? m.wallet.saveAndLogin : m.editor.save}
          </button>
        </footer>
      </form>
    </div>
  );
}

interface WalletImportConflictProps {
  wallet: Wallet;
  busy: boolean;
  onChoose: (mode: WalletKeyImportGroupMode) => void;
  onClose: () => void;
}

function WalletImportConflict({
  wallet,
  busy,
  onChoose,
  onClose,
}: WalletImportConflictProps): ReactElement {
  const { m, fill } = useI18n();
  return (
    <div className="editor-layer" role="dialog" aria-modal="true" aria-label={m.wallet.importConflictTitle}>
      <button
        type="button"
        className="editor-scrim"
        aria-label={m.editor.close}
        disabled={busy}
        onClick={onClose}
      />
      <div className="editor-dialog wallet-import-dialog">
        <header className="editor-head">
          <h2>{m.wallet.importConflictTitle}</h2>
          <button type="button" className="editor-close" aria-label={m.editor.close} onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="editor-body">
          <p>{fill(m.wallet.importConflictMessage, { name: wallet.name })}</p>
        </div>
        <footer className="editor-foot wallet-import-actions">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
            {m.confirm.cancel}
          </button>
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => onChoose("new")}>
            {m.wallet.importCreateGroup}
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => onChoose("existing")}>
            {busy && <LoaderCircle size={13} className="spin" />}
            {m.wallet.importExistingGroup}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function WalletView({ active = true, onToast, onProfilesChanged }: WalletViewProps): ReactElement {
  const { locale, m, fill } = useI18n();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [editorWallet, setEditorWallet] = useState<Wallet | null>();
  const [pendingDelete, setPendingDelete] = useState<Wallet>();
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(new Set());
  const [loggingIds, setLoggingIds] = useState<ReadonlySet<string>>(new Set());
  const [importingIds, setImportingIds] = useState<ReadonlySet<string>>(new Set());
  const [importConflict, setImportConflict] = useState<Wallet>();
  const loadStartedRef = useRef(false);
  const walletsRef = useRef<Wallet[]>([]);
  const checkingIdsRef = useRef(new Set<string>());
  const loggingIdsRef = useRef(new Set<string>());
  const importingIdsRef = useRef(new Set<string>());

  function updateWallets(update: (current: Wallet[]) => Wallet[]): void {
    setWallets((current) => {
      const next = update(current);
      walletsRef.current = next;
      return next;
    });
  }

  async function loadWallets(): Promise<void> {
    loadStartedRef.current = true;
    setLoading(true);
    setLoadError(undefined);
    try {
      const loaded = await api.listWallets();
      walletsRef.current = loaded;
      setWallets(loaded);
    } catch (error) {
      setLoadError(describeError(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!loadStartedRef.current) void loadWallets();
    const timer = window.setInterval(() => {
      const readyIds = walletsRef.current
        .filter((wallet) => wallet.credentialStatus === "ready")
        .map((wallet) => wallet.id);
      if (readyIds.length > 0) void checkMany(readyIds, false);
    }, WALLET_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  function markChecking(ids: string[]): string[] {
    const pending = ids.filter((id) => !checkingIdsRef.current.has(id));
    if (pending.length === 0) return pending;
    const next = new Set(checkingIdsRef.current);
    for (const id of pending) next.add(id);
    checkingIdsRef.current = next;
    setCheckingIds(next);
    return pending;
  }

  function finishChecking(id: string): void {
    const next = new Set(checkingIdsRef.current);
    next.delete(id);
    checkingIdsRef.current = next;
    setCheckingIds(next);
  }

  async function checkMany(ids: string[], showErrors = true): Promise<void> {
    const readyIds = ids.filter((id) => (
      walletsRef.current.find((wallet) => wallet.id === id)?.credentialStatus === "ready"
    ));
    const pending = markChecking(readyIds);
    for (let index = 0; index < pending.length; index += WALLET_CHECK_CONCURRENCY) {
      await Promise.all(pending
        .slice(index, index + WALLET_CHECK_CONCURRENCY)
        .map(async (id) => {
          try {
            const checked = await api.checkWallet(id);
            updateWallets((current) => replaceWallet(current, checked));
          } catch (error) {
            if (showErrors) {
              onToast("error", fill(m.wallet.checkFailed, { message: describeError(error) }));
            }
          } finally {
            finishChecking(id);
          }
        }));
    }
  }

  async function loginWallet(wallet: Wallet): Promise<void> {
    if (loggingIdsRef.current.has(wallet.id)) return;
    const next = new Set(loggingIdsRef.current);
    next.add(wallet.id);
    loggingIdsRef.current = next;
    setLoggingIds(next);
    try {
      const result = await api.loginWallet(wallet.id);
      if (result.cancelled || !result.wallet) return;
      updateWallets((current) => replaceWallet(current, result.wallet!));
      onToast("success", fill(m.wallet.loginSuccess, { name: result.wallet.name }));
    } catch (error) {
      onToast("error", describeError(error));
    } finally {
      const finished = new Set(loggingIdsRef.current);
      finished.delete(wallet.id);
      loggingIdsRef.current = finished;
      setLoggingIds(finished);
    }
  }

  async function importWalletKeys(
    wallet: Wallet,
    groupMode?: WalletKeyImportGroupMode,
  ): Promise<void> {
    if (importingIdsRef.current.has(wallet.id)) return;
    const next = new Set(importingIdsRef.current);
    next.add(wallet.id);
    importingIdsRef.current = next;
    setImportingIds(next);
    try {
      const result = await api.importWalletKeys(wallet.id, groupMode);
      if (result.status === "group-conflict") {
        setImportConflict(wallet);
        return;
      }
      setImportConflict(undefined);
      await onProfilesChanged();
      onToast("success", fill(m.wallet.importSuccess, {
        group: result.groupName,
        imported: result.imported,
        reused: result.reused,
        skipped: result.skipped,
      }));
    } catch (error) {
      onToast("error", describeError(error));
    } finally {
      const finished = new Set(importingIdsRef.current);
      finished.delete(wallet.id);
      importingIdsRef.current = finished;
      setImportingIds(finished);
    }
  }

  async function saveWallet(input: SaveWalletInput, loginAfterSave: boolean): Promise<void> {
    const saved = await api.saveWallet(input);
    updateWallets((current) => replaceWallet(current, saved));
    setEditorWallet(undefined);
    onToast("success", fill(m.wallet.saved, { name: saved.name }));
    if (loginAfterSave) void loginWallet(saved);
  }

  async function deleteWallet(): Promise<void> {
    const wallet = pendingDelete;
    setPendingDelete(undefined);
    if (!wallet) return;
    try {
      await api.deleteWallet(wallet.id);
      updateWallets((current) => current.filter((item) => item.id !== wallet.id));
      onToast("success", fill(m.wallet.deleted, { name: wallet.name }));
    } catch (error) {
      onToast("error", describeError(error));
    }
  }

  function balanceStatusLabel(status: WalletBalanceStatus | undefined): string {
    if (status === "ok") return m.wallet.ok;
    if (status === "low") return m.wallet.low;
    if (status === "empty") return m.wallet.empty;
    if (status === "unlimited") return m.wallet.unlimited;
    if (status === "error") return m.wallet.error;
    return m.wallet.unchecked;
  }

  function balanceScopeLabel(scope: WalletBalance["scope"]): string | undefined {
    if (scope === "key") return m.wallet.scopeKey;
    if (scope === "account") return m.wallet.scopeAccount;
    if (scope === "site") return m.wallet.scopeSite;
    return undefined;
  }

  return (
    <main
      className="page-scroll wallet-page"
      aria-label={m.wallet.title}
      hidden={!active}
      onMouseDown={(event) => {
        if (event.button !== 3 || !pendingDelete) return;
        event.preventDefault();
        event.stopPropagation();
        setPendingDelete(undefined);
      }}
      onContextMenu={(event) => {
        if (!pendingDelete) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="page-inner wallet-inner">
        <div className="section-head wallet-head rise">
          <div>
            <span className="kicker">BALANCE LEDGER</span>
            <h1>{m.wallet.title}</h1>
          </div>
          <span className="wallet-count">{fill(m.wallet.count, { count: wallets.length })}</span>
          <div className="wallet-head-actions">
            <button
              type="button"
              className="ghost-pill"
              disabled={wallets.every((wallet) => wallet.credentialStatus !== "ready") || checkingIds.size > 0}
              onClick={() => void checkMany(wallets.map((wallet) => wallet.id))}
            >
              <RefreshCw size={13} className={checkingIds.size > 0 ? "spin" : undefined} />
              {m.wallet.checkAll}
            </button>
            <button type="button" className="primary-pill" onClick={() => setEditorWallet(null)}>
              <Plus size={13} />
              {m.keys.create}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="empty-state rise-1">
            <div className="empty-icon"><LoaderCircle size={22} className="spin" /></div>
            <h2>{m.wallet.loading}</h2>
          </div>
        ) : loadError ? (
          <div className="empty-state rise-1">
            <div className="empty-icon error-icon"><AlertCircle size={22} /></div>
            <h2>{m.wallet.loadError}</h2>
            <p>{loadError}</p>
            <button
              type="button"
              className="ghost-pill"
              onClick={() => {
                loadStartedRef.current = false;
                void loadWallets();
              }}
            >
              <RefreshCw size={13} />
              {m.keys.retry}
            </button>
          </div>
        ) : wallets.length === 0 ? (
          <div className="empty-state rise-1">
            <div className="empty-icon"><WalletCards size={22} /></div>
            <h2>{m.wallet.emptyTitle}</h2>
            <p>{m.wallet.emptyHint}</p>
            <button type="button" className="primary-pill" onClick={() => setEditorWallet(null)}>
              <Plus size={13} />
              {m.keys.create}
            </button>
          </div>
        ) : (
          <div className="wallet-table rise-1" role="table" aria-label={m.wallet.title}>
            <div className="wallet-table-head" role="row">
              <span role="columnheader">{m.wallet.name}</span>
              <span role="columnheader">{m.wallet.template}</span>
              <span role="columnheader">{m.wallet.balance}</span>
              <span role="columnheader">{m.wallet.subscription}</span>
              <span role="columnheader">{m.status.state}</span>
              <span role="columnheader">{m.status.lastCheck}</span>
              <span role="columnheader">{m.wallet.actions}</span>
            </div>
            {wallets.map((wallet) => {
              const checking = checkingIds.has(wallet.id);
              const logging = loggingIds.has(wallet.id);
              const importing = importingIds.has(wallet.id);
              const status = wallet.balance?.status;
              const credentialBlocked = wallet.credentialStatus !== "ready";
              const balanceMeta = [
                balanceScopeLabel(wallet.balance?.scope),
                wallet.balance?.plan,
                wallet.balance?.totalUsd !== undefined
                  ? `${formatUsd(wallet.balance.usedUsd, locale)} / ${formatUsd(wallet.balance.totalUsd, locale)}`
                  : undefined,
              ].filter(Boolean).join(" · ");
              const subscriptions = wallet.balance?.subscriptions ?? [];
              const subscription = primaryWalletSubscription(subscriptions);
              const daysRemaining = subscriptionDaysRemaining(subscription?.expiresAt);
              const resetTime = subscription?.resetsAt
                ? formatCompactDateTime(subscription.resetsAt)
                : undefined;
              const resetLabel = resetTime
                ? fill(m.wallet.resetsAt, { time: resetTime })
                : undefined;
              const dailyUsage = subscription
                ? subscription.dailyLimitUsd
                  ? fill(m.wallet.dailyUsage, {
                      used: formatUsd(subscription.dailyUsedUsd, locale),
                      limit: formatUsd(subscription.dailyLimitUsd, locale),
                    })
                  : fill(m.wallet.dailyUnlimited, {
                      used: formatUsd(subscription.dailyUsedUsd, locale),
                    })
                : undefined;
              const subscriptionProgress = subscription?.dailyLimitUsd
                ? Math.min(100, Math.max(0, subscription.dailyUsedUsd / subscription.dailyLimitUsd * 100))
                : undefined;
              const subscriptionTitle = subscriptions.map((item) => {
                const itemDays = subscriptionDaysRemaining(item.expiresAt);
                const itemUsage = item.dailyLimitUsd
                  ? fill(m.wallet.dailyUsage, {
                      used: formatUsd(item.dailyUsedUsd, locale),
                      limit: formatUsd(item.dailyLimitUsd, locale),
                    })
                  : fill(m.wallet.dailyUnlimited, { used: formatUsd(item.dailyUsedUsd, locale) });
                return [
                  item.name,
                  itemUsage,
                  item.resetsAt
                    ? fill(m.wallet.resetsAt, { time: formatCompactDateTime(item.resetsAt) })
                    : undefined,
                  itemDays === undefined ? undefined : fill(m.wallet.daysRemaining, { days: itemDays }),
                ].filter(Boolean).join(" · ");
              }).join("\n");
              return (
                <div
                  className={`wallet-row ${credentialBlocked ? "credential-missing" : status ?? "unknown"} ${checking || logging || importing ? "checking" : ""}`}
                  role="row"
                  key={wallet.id}
                >
                  <div className="wallet-identity" role="cell">
                    <strong>{wallet.name}</strong>
                  </div>
                  <code className="wallet-template" role="cell">{TEMPLATE_LABELS[wallet.template]}</code>
                  <div className="wallet-balance" role="cell">
                    <strong>
                      {status === "unlimited" ? <InfinityIcon size={18} /> : formatUsd(wallet.balance?.remainingUsd, locale)}
                    </strong>
                    {balanceMeta ? <small title={balanceMeta}>{balanceMeta}</small> : null}
                  </div>
                  <div className="wallet-subscription-cell" role="cell">
                    {subscription ? (
                      <div className="wallet-subscription" title={subscriptionTitle}>
                        <div className="wallet-subscription-head">
                          <span>{subscription.name}</span>
                          {subscriptions.length > 1 && (
                            <em>{fill(m.wallet.moreSubscriptions, { count: subscriptions.length - 1 })}</em>
                          )}
                        </div>
                        {(daysRemaining !== undefined || resetTime) && (
                          <div className="wallet-subscription-meta">
                            {daysRemaining !== undefined && (
                              <span>{fill(m.wallet.daysRemaining, { days: daysRemaining })}</span>
                            )}
                            {resetTime && (
                              <span className="wallet-subscription-reset" aria-label={resetLabel}>
                                <Clock3 size={9} aria-hidden="true" />
                                <span>{resetTime}</span>
                              </span>
                            )}
                          </div>
                        )}
                        {dailyUsage && <small>{dailyUsage}</small>}
                        {subscriptionProgress !== undefined && dailyUsage && (
                          <span
                            className="wallet-subscription-meter"
                            role="progressbar"
                            aria-label={dailyUsage}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(subscriptionProgress)}
                          >
                            <i style={{ width: `${subscriptionProgress}%` }} />
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="wallet-empty-value">——</span>
                    )}
                  </div>
                  <div className="wallet-state" role="cell" title={wallet.balance?.message}>
                    {logging
                      ? <LoaderCircle size={12} className="spin" />
                      : credentialBlocked
                        ? <LogIn size={12} />
                        : checking
                      ? <LoaderCircle size={12} className="spin" />
                      : status === "ok" || status === "unlimited"
                        ? <Check size={12} />
                        : status === "error" || status === "empty"
                          ? <AlertCircle size={12} />
                          : <CircleDollarSign size={12} />}
                    <span>
                      {logging
                        ? m.wallet.login
                        : credentialBlocked
                          ? wallet.credentialStatus === "expired" ? m.wallet.loginExpired : m.wallet.notSignedIn
                          : checking ? m.status.checking : balanceStatusLabel(status)}
                    </span>
                    {!credentialBlocked && status === "error" && wallet.balance?.message && <small>{wallet.balance.message}</small>}
                  </div>
                  <code className="wallet-checked" role="cell">
                    {wallet.balance?.checkedAt
                      ? formatDateTime(wallet.balance.checkedAt, locale)
                      : m.keys.never}
                  </code>
                  <div className="wallet-actions" role="cell">
                    <button
                      type="button"
                      className="icon-ghost"
                      aria-label={`${m.wallet.check} ${wallet.name}`}
                      data-hint={m.wallet.check}
                      disabled={checking || logging || credentialBlocked}
                      onClick={() => void checkMany([wallet.id])}
                    >
                      <RefreshCw size={13} className={checking ? "spin" : undefined} />
                    </button>
                    {wallet.template === "sub2api" && (
                      <button
                        type="button"
                        className="icon-ghost"
                        aria-label={`${m.wallet.importKeys} ${wallet.name}`}
                        data-hint={m.wallet.importKeys}
                        disabled={checking || logging || importing || credentialBlocked}
                        onClick={() => void importWalletKeys(wallet)}
                      >
                        {importing ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}
                      </button>
                    )}
                    {wallet.template === "sub2api" && (
                      <button
                        type="button"
                        className="icon-ghost wallet-login"
                        aria-label={`${wallet.credentialStatus === "ready" ? m.wallet.relogin : m.wallet.login} ${wallet.name}`}
                        data-hint={wallet.credentialStatus === "ready" ? m.wallet.relogin : m.wallet.login}
                        disabled={checking || logging || importing}
                        onClick={() => void loginWallet(wallet)}
                      >
                        <LogIn size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-ghost"
                      aria-label={`${m.keys.edit} ${wallet.name}`}
                      data-hint={m.keys.edit}
                      disabled={checking || logging || importing}
                      onClick={() => setEditorWallet(wallet)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-ghost wallet-delete"
                      aria-label={`${m.keys.delete} ${wallet.name}`}
                      data-hint={m.keys.delete}
                      disabled={checking || logging || importing}
                      onClick={() => setPendingDelete(wallet)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editorWallet !== undefined && (
        <WalletEditor
          wallet={editorWallet ?? undefined}
          onSave={saveWallet}
          onClose={() => setEditorWallet(undefined)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={fill(m.wallet.deleteTitle, { name: pendingDelete.name })}
          message={m.wallet.deleteMessage}
          confirmLabel={m.keys.delete}
          cancelLabel={m.confirm.cancel}
          danger
          onConfirm={() => void deleteWallet()}
          onCancel={() => setPendingDelete(undefined)}
        />
      )}

      {importConflict && (
        <WalletImportConflict
          wallet={importConflict}
          busy={importingIds.has(importConflict.id)}
          onChoose={(mode) => void importWalletKeys(importConflict, mode)}
          onClose={() => setImportConflict(undefined)}
        />
      )}
    </main>
  );
}

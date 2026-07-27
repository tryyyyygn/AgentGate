import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Circle,
  Eye,
  EyeOff,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement, SyntheticEvent } from "react";
import {
  BLANK_PROFILE_INPUT,
  CLIENT_META,
  CLIENT_TARGET_ORDER,
  PROTOCOL_META,
} from "../config";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n";
import { normalizeHttpUrl } from "../lib/url";
import type {
  ClientTarget,
  Profile,
  ProfileEndpoint,
  ProfileGroup,
  Protocol,
  SaveProfileInput,
} from "../types";
import { ConfirmDialog } from "./ConfirmDialog";

interface ProfileEditorProps {
  profile?: Profile;
  groups: ProfileGroup[];
  busy: boolean;
  /** 正在识别模型。 */
  discovering?: boolean;
  /** 识别模型：用当前 Key 请求上游模型列表；返回最新可用模型。 */
  onDiscoverModels?: (input: SaveProfileInput) => Promise<string[] | undefined>;
  onClose: () => void;
  onSave: (input: SaveProfileInput, applyAfter: boolean) => Promise<void>;
}

/** 校验结果用错误码表示——文案是翻译的，定位逻辑不能依赖文案。 */
type ValidationCode = keyof Messages["errors"];

/** 出错时把焦点送回哪个字段；用 data-field 定位，不受语言影响。 */
const ERROR_FIELD: Partial<Record<ValidationCode, string>> = {
  nameRequired: "name",
  urlInvalid: "url",
  urlCredentials: "url",
  urlDuplicate: "url",
  urlActiveRequired: "url",
  urlAtLeastOne: "url",
  keyRequired: "key",
};

function createEditorInput(profile?: Profile, defaultGroupId?: string): SaveProfileInput {
  if (!profile) {
    return {
      ...BLANK_PROFILE_INPUT,
      groupId: defaultGroupId ?? null,
      endpoints: BLANK_PROFILE_INPUT.endpoints.map((endpoint) => ({ ...endpoint })),
      autoSwitch: { ...BLANK_PROFILE_INPUT.autoSwitch },
    };
  }
  return {
    id: profile.id,
    groupId: profile.groupId ?? null,
    name: profile.name,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    endpoints: profile.endpoints.map((endpoint) => ({ url: endpoint.url })),
    apiKey: "",
    model: profile.model,
    authMode: profile.authMode,
    targets: [...profile.targets],
    enableToolSearch: profile.enableToolSearch,
    autoSwitch: { ...profile.autoSwitch },
  };
}

/**
 * 在进入主进程前校验表单边界。
 *
 * @param form 当前表单值。
 * @param hasExistingKey 是否允许空 Key 表示保留原密文。
 * @returns 首个校验错误码；通过时返回 undefined。
 */
function validateProfileInput(
  form: SaveProfileInput,
  hasExistingKey: boolean,
): ValidationCode | undefined {
  if (!form.name.trim()) return "nameRequired";

  if (form.endpoints.length === 0) return "urlAtLeastOne";
  const normalizedUrls: string[] = [];
  for (const endpoint of form.endpoints) {
    try {
      const value = endpoint.url.trim();
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "urlInvalid";
      if (parsed.username || parsed.password || parsed.hash) return "urlCredentials";
      normalizedUrls.push(normalizeHttpUrl(value));
    } catch {
      return "urlInvalid";
    }
  }
  if (new Set(normalizedUrls).size !== normalizedUrls.length) return "urlDuplicate";
  if (!form.endpoints.some((endpoint) => endpoint.url === form.baseUrl)) return "urlActiveRequired";

  if (!hasExistingKey && !form.apiKey?.trim()) return "keyRequired";
  if (form.targets.length === 0) return "targetRequired";
  return undefined;
}

/**
 * 清理用户输入但不改变 URL 路径和 Key 内容。
 *
 * @param form 已通过校验的表单。
 * @returns 可提交主进程的规范化方案。
 */
function normalizeProfileInput(form: SaveProfileInput): SaveProfileInput {
  const activeIndex = form.endpoints.findIndex((endpoint) => endpoint.url === form.baseUrl);
  const endpoints = form.endpoints.map((endpoint) => ({
    url: normalizeHttpUrl(endpoint.url),
  }));
  return {
    ...form,
    name: form.name.trim(),
    baseUrl: endpoints[Math.max(0, activeIndex)].url,
    endpoints,
    apiKey: form.apiKey?.trim() || undefined,
    model: form.model.trim(),
  };
}

function endpointStatus(
  endpoint: ProfileEndpoint | undefined,
  m: Messages,
): { text: string; className: string } {
  if (!endpoint?.health || endpoint.health.status === "unknown") {
    return { text: m.editor.notDetected, className: "unknown" };
  }
  if (endpoint.health.status === "unhealthy") return { text: m.editor.unavailable, className: "bad" };
  return { text: `${endpoint.health.latencyMs ?? 0} ms`, className: "good" };
}

/**
 * 新建或编辑连接方案，并在提交前完成客户端兼容性和必填项校验。
 *
 * 编辑已有方案时，空 Key 表示保留主进程中的原密文；组件不会读取已有明文。
 * 保存并分配会先保存方案，再由父级将它分配给本地网关。
 *
 * @param props 可选现有方案、保存状态及关闭/保存回调。
 * @returns 居中弹出的方案编辑对话框。
 */
export function ProfileEditor({
  profile,
  groups,
  busy,
  discovering,
  onDiscoverModels,
  onClose,
  onSave,
}: ProfileEditorProps): ReactElement {
  const { m, fill } = useI18n();
  const initialForm = useRef(createEditorInput(profile, groups[0]?.id));
  const [form, setForm] = useState<SaveProfileInput>(() => initialForm.current);
  const formRef = useRef(form);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<ValidationCode>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [models, setModels] = useState<string[]>(() => profile?.availableModels ?? []);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  /** 用户在模型框里主动键入的搜索词；undefined 表示未搜索，此时列出全部模型。 */
  const [modelQuery, setModelQuery] = useState<string>();
  const dialogRef = useRef<HTMLFormElement>(null);
  const modelFieldRef = useRef<HTMLDivElement>(null);
  const compatibleTargets = PROTOCOL_META[form.protocol].compatible;
  const hasUnsavedChanges = JSON.stringify(form) !== JSON.stringify(initialForm.current);
  // 展开时始终列出全部模型；只有用户主动键入才按搜索词过滤，
  // 这样已选中的模型不会把列表过滤成只剩它自己。
  const modelOptions = modelQuery?.trim()
    ? models.filter((model) => (
        model.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase())
      ))
    : models;

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    function handlePointerDown(event: MouseEvent): void {
      if (!(event.target instanceof Node)) return;
      if (modelFieldRef.current?.contains(event.target)) return;
      setModelMenuOpen(false);
    }
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [modelMenuOpen]);

  async function discoverModels(): Promise<void> {
    if (!onDiscoverModels || discovering) return;
    const draft = form;
    const discovered = await onDiscoverModels(draft);
    if (!discovered) return;
    if (JSON.stringify(formRef.current) !== JSON.stringify(draft)) return;
    setModels(discovered);
    setModelQuery(undefined);
    setModelMenuOpen(discovered.length > 0);
  }

  function requestClose(): void {
    if (busy) return;
    if (hasUnsavedChanges) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    const layer = dialog?.closest<HTMLElement>(".editor-layer");
    const backgroundState = layer?.parentElement
      ? [...layer.parentElement.children]
        .filter((element): element is HTMLElement => (
          element instanceof HTMLElement && element !== layer
        ))
        .map((element) => ({
          element,
          inert: element.inert,
          ariaHidden: element.getAttribute("aria-hidden"),
        }))
      : [];
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    for (const state of backgroundState) {
      state.element.inert = true;
      state.element.setAttribute("aria-hidden", "true");
    }

    function trapFocus(event: KeyboardEvent): void {
      if (event.key !== "Tab" || !dialog) return;
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

    dialog?.addEventListener("keydown", trapFocus);
    dialog?.querySelector<HTMLElement>("[autofocus]")?.focus();
    return () => {
      dialog?.removeEventListener("keydown", trapFocus);
      for (const state of backgroundState) {
        state.element.inert = state.inert;
        if (typeof state.ariaHidden === "string") {
          state.element.setAttribute("aria-hidden", state.ariaHidden);
        } else {
          state.element.removeAttribute("aria-hidden");
        }
      }
      previousFocus?.focus();
    };
  }, []);

  function update<K extends keyof SaveProfileInput>(
    key: K,
    value: SaveProfileInput[K],
  ): void {
    setForm((current) => ({ ...current, [key]: value }));
    setError(undefined);
  }

  function changeProtocol(protocol: Protocol): void {
    const compatible = PROTOCOL_META[protocol].compatible;
    const retainedTargets = form.targets.filter((target) => compatible.includes(target));
    setForm((current) => ({
      ...current,
      protocol,
      targets: retainedTargets.length > 0 ? retainedTargets : [compatible[0]],
      authMode: protocol === "anthropic" ? current.authMode : "bearer",
      enableToolSearch: protocol === "anthropic" && current.enableToolSearch,
    }));
    setError(undefined);
  }

  function toggleTarget(target: ClientTarget): void {
    const selected = form.targets.includes(target);
    const targets = selected
      ? form.targets.filter((item) => item !== target)
      : [...form.targets, target];
    update("targets", targets);
  }

  function updateEndpoints(endpoints: Array<{ url: string }>, activeUrl: string): void {
    setForm((current) => ({ ...current, endpoints, baseUrl: activeUrl }));
    setError(undefined);
  }

  function updateUrl(index: number, url: string): void {
    const previousUrl = form.endpoints[index].url;
    const next = form.endpoints.map((endpoint, endpointIndex) => (
      endpointIndex === index ? { url } : endpoint
    ));
    updateEndpoints(next, form.baseUrl === previousUrl ? url : form.baseUrl);
  }

  function removeEndpoint(index: number): void {
    if (form.endpoints.length === 1) return;
    const removedUrl = form.endpoints[index].url;
    const next = form.endpoints.filter((_, endpointIndex) => endpointIndex !== index);
    updateEndpoints(next, form.baseUrl === removedUrl ? next[0].url : form.baseUrl);
  }

  async function submit(event: SyntheticEvent, applyAfter: boolean): Promise<void> {
    event.preventDefault();
    const code = validateProfileInput(form, Boolean(profile));
    if (code) {
      setError(code);
      const field = ERROR_FIELD[code];
      if (field) {
        requestAnimationFrame(() => {
          const input = dialogRef.current?.querySelector<HTMLElement>(`[data-field="${field}"]`);
          input?.focus();
          input?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      }
      return;
    }
    await onSave(normalizeProfileInput(form), applyAfter);
  }

  function handleContextBack(event: ReactMouseEvent<HTMLDivElement>): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const onScrim = Boolean(target.closest(".editor-scrim"));
    const interactive = Boolean(target.closest(
      "button, input, select, textarea, label, .mono",
    ));
    if (!onScrim && interactive) return;
    event.preventDefault();
    requestClose();
  }

  const title = profile ? fill(m.editor.editTitle, { name: profile.name }) : m.editor.createTitle;

  return (
    <div
      className="editor-layer"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || confirmDiscard) return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
      onMouseDown={(event) => {
        if (event.button !== 3) return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
      onContextMenu={handleContextBack}
    >
      <button
        type="button"
        className="editor-scrim"
        aria-label={m.editor.close}
        disabled={busy}
        onClick={requestClose}
      />
      <form
        ref={dialogRef}
        className="editor-dialog"
        onSubmit={(event) => void submit(event, false)}
      >
        <header className="editor-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="editor-close"
            aria-label={m.editor.close}
            title={m.editor.close}
            disabled={busy}
            onClick={requestClose}
          >
            <X size={15} />
          </button>
        </header>

        <div className="editor-body">
          {error && (
            <div className="editor-error" role="alert">
              <AlertCircle size={14} />
              <span>{m.errors[error]}</span>
            </div>
          )}

          <div className="field-grid">
            <label className="field-block">
              <span className="field-name">{m.editor.name}</span>
              <input
                data-field="name"
                aria-label={m.editor.name}
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder={m.editor.namePlaceholder}
                autoFocus
              />
            </label>
            <label className="field-block">
              <span className="field-name">{m.editor.protocol}</span>
              <select
                aria-label={m.editor.protocol}
                value={form.protocol}
                onChange={(event) => changeProtocol(event.target.value as Protocol)}
              >
                {(Object.keys(PROTOCOL_META) as Protocol[]).map((protocol) => (
                  <option value={protocol} key={protocol}>
                    {PROTOCOL_META[protocol].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-block field-wide">
              <span className="field-name">{m.keys.groupName}</span>
              <select
                value={form.groupId ?? ""}
                onChange={(event) => update("groupId", event.target.value || null)}
              >
                <option value="">{m.keys.ungrouped}</option>
                {groups.map((group) => (
                  <option value={group.id} key={group.id}>{group.name}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="editor-section">
            <span className="field-name">
              {m.editor.apiUrl}
              <small>{m.editor.activeUrlHint}</small>
            </span>
            <div className="url-pool" role="group" aria-label={m.editor.apiUrl}>
              {form.endpoints.map((endpoint, index) => {
                const known = profile?.endpoints.find((item) => item.url === endpoint.url);
                const active = endpoint.url === form.baseUrl;
                const status = endpointStatus(known, m);
                return (
                  <div className={`url-row ${active ? "active" : ""}`} key={index}>
                    <button
                      type="button"
                      className="url-radio"
                      title={m.editor.setActive}
                      aria-label={`${m.editor.setActive} ${index + 1}`}
                      aria-pressed={active}
                      onClick={() => updateEndpoints(form.endpoints, endpoint.url)}
                    >
                      {active ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                    </button>
                    <input
                      data-field={index === 0 ? "url" : undefined}
                      aria-label={`${m.editor.apiUrl} ${index + 1}`}
                      value={endpoint.url}
                      onChange={(event) => updateUrl(index, event.target.value)}
                      placeholder="https://api.example.com/v1"
                      spellCheck={false}
                    />
                    <span className={`url-status ${status.className}`}>{status.text}</span>
                    <button
                      type="button"
                      className="url-remove"
                      title={m.editor.removeUrl}
                      aria-label={`${m.editor.removeUrl} ${index + 1}`}
                      disabled={form.endpoints.length === 1}
                      onClick={() => removeEndpoint(index)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="url-pool-foot">
              <button
                type="button"
                className="add-url-pill"
                onClick={() => updateEndpoints([...form.endpoints, { url: "" }], form.baseUrl)}
              >
                <Plus size={13} />{m.editor.addUrl}
              </button>
              <label className="inline-switch">
                <span className="switch-label">{m.editor.autoSwitch}</span>
                <input
                  type="checkbox"
                  className="switch-input"
                  aria-label={m.editor.autoSwitchHint}
                  checked={form.autoSwitch.enabled}
                  onChange={(event) => update("autoSwitch", {
                    ...form.autoSwitch,
                    enabled: event.target.checked,
                    intervalMinutes: 2,
                  })}
                />
                <span
                  className={`kd-switch small ${form.autoSwitch.enabled ? "checked" : ""}`}
                  aria-hidden="true"
                >
                  <span />
                </span>
              </label>
            </div>
          </div>

          <div className="editor-section ruled">
            <div className="field-grid">
              <label className="field-block">
                <span className="field-name">
                  {m.editor.apiKey}
                  {profile && <small>{fill(m.editor.keyKeepHint, { hint: profile.keyHint })}</small>}
                </span>
                <div className="password-field">
                  <input
                    data-field="key"
                    aria-label={m.editor.apiKey}
                    className="mono"
                    type={showKey ? "text" : "password"}
                    value={form.apiKey}
                    onChange={(event) => update("apiKey", event.target.value)}
                    placeholder={profile ? m.editor.keyPlaceholder : m.editor.keyPlaceholderNew}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="icon-mini"
                    title={showKey ? m.editor.hideKey : m.editor.showKey}
                    aria-label={showKey ? m.editor.hideKey : m.editor.showKey}
                    onClick={() => setShowKey((value) => !value)}
                  >
                    {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </label>
              <div className="field-block">
                <span className="field-name">
                  {m.editor.model}
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy || discovering}
                    onClick={() => void discoverModels()}
                  >
                    {discovering
                      ? <LoaderCircle size={11} className="spin" />
                      : <RefreshCw size={11} />}
                    {m.editor.discoverModels}
                  </button>
                </span>
                <div className="model-field" ref={modelFieldRef}>
                  <input
                    aria-label={m.editor.model}
                    className="mono"
                    role="combobox"
                    aria-expanded={modelMenuOpen}
                    aria-autocomplete="list"
                    value={form.model}
                    onChange={(event) => {
                      update("model", event.target.value);
                      setModelQuery(event.target.value);
                      setModelMenuOpen(true);
                    }}
                    onFocus={() => {
                      setModelQuery(undefined);
                      setModelMenuOpen(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && modelMenuOpen) {
                        event.preventDefault();
                        event.stopPropagation();
                        setModelMenuOpen(false);
                      }
                    }}
                    placeholder="claude-sonnet-4-5"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="model-toggle"
                    aria-label={m.editor.model}
                    title={models.length > 0
                      ? fill(m.editor.modelsAvailable, { count: models.length })
                      : m.editor.discoverModels}
                    onClick={() => {
                      setModelQuery(undefined);
                      setModelMenuOpen((open) => !open);
                    }}
                  >
                    <ChevronsUpDown size={13} />
                  </button>
                  {modelMenuOpen && (
                    <div className="model-menu" role="listbox" aria-label={m.editor.model}>
                      {modelOptions.length > 0 ? modelOptions.map((model) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={model === form.model}
                          className={`model-option ${model === form.model ? "current" : ""}`}
                          key={model}
                          onClick={() => {
                            update("model", model);
                            setModelQuery(undefined);
                            setModelMenuOpen(false);
                          }}
                        >
                          <code>{model}</code>
                          {model === form.model && <Check size={12} />}
                        </button>
                      )) : (
                        <p className="model-menu-empty">
                          {models.length === 0 ? m.editor.modelEmpty : m.editor.modelNoMatch}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
            {form.protocol === "anthropic" && (
              <div className="field-block" style={{ marginTop: 12 }}>
                <span className="field-name">{m.editor.authMode}</span>
                <div className="auth-segments" role="radiogroup" aria-label={m.editor.authMode}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.authMode === "bearer"}
                    className={form.authMode === "bearer" ? "active" : ""}
                    onClick={() => update("authMode", "bearer")}
                  >
                    Bearer Token
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.authMode === "api-key"}
                    className={form.authMode === "api-key" ? "active" : ""}
                    onClick={() => update("authMode", "api-key")}
                  >
                    x-api-key
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="editor-section ruled">
            <span className="field-name">{m.editor.targets}</span>
            <div className="target-grid">
              {CLIENT_TARGET_ORDER.map((target) => {
                const compatible = compatibleTargets.includes(target);
                const checked = form.targets.includes(target);
                const className = [
                  "target-option",
                  checked ? "checked" : "",
                  compatible ? "" : "incompatible",
                ].filter(Boolean).join(" ");
                return (
                  <label className={className} key={target}>
                    <input
                      type="checkbox"
                      className="switch-input"
                      checked={checked}
                      disabled={!compatible}
                      onChange={() => toggleTarget(target)}
                    />
                    <span className="target-check">{checked && <Check size={12} />}</span>
                    <span className="target-copy">
                      <strong>{CLIENT_META[target].label}</strong>
                      <small>{compatible ? m.editor.viaGateway : m.editor.incompatible}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            {form.protocol === "anthropic" && form.targets.includes("claude") && (
              <label className="tool-search-row">
                <span>
                  <strong>{m.editor.toolSearch}</strong>
                  <small>{m.editor.toolSearchDesc}</small>
                </span>
                <input
                  type="checkbox"
                  className="switch-input"
                  checked={Boolean(form.enableToolSearch)}
                  onChange={(event) => update("enableToolSearch", event.target.checked)}
                />
                <span
                  className={`kd-switch small ${form.enableToolSearch ? "checked" : ""}`}
                  aria-hidden="true"
                >
                  <span />
                </span>
              </label>
            )}
          </div>
        </div>

        <footer className="editor-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={requestClose}>
            {m.editor.cancel}
          </button>
          <button type="submit" className="btn-save" disabled={busy || discovering}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
            {busy ? m.editor.saving : m.editor.save}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || discovering}
            onClick={(event) => void submit(event, true)}
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Zap size={14} fill="currentColor" />
            )}
            {busy ? m.editor.saving : m.editor.saveAndUse}
          </button>
        </footer>
      </form>
      {confirmDiscard && (
        <ConfirmDialog
          title={m.confirm.discardTitle}
          message={m.confirm.discardMessage}
          confirmLabel={m.confirm.discardConfirm}
          cancelLabel={m.confirm.cancel}
          danger
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}

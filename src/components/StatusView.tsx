import {
  AlertCircle,
  Check,
  Clock3,
  LoaderCircle,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Settings2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CLIENT_META, CLIENT_TARGET_ORDER, DEFAULT_SETTINGS } from "../config";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { describeError, formatCompactDateTime, formatDuration } from "../lib/format";
import type {
  AppSettings,
  ClientTarget,
  GatewayState,
  Profile,
  ProbeResult,
} from "../types";

const DEFAULT_INTERVAL_MS = 120_000;
const MAX_SAMPLES = 60;
const PULSE_SLOTS = 30;
const HEALTHY_RESPONSE_MS = 5_000;
const SMOOTH_RESPONSE_MS = 10_000;
const DISABLED_PROFILES_KEY = "agentgate.status.disabled-profiles.v1";
const AUTO_PROBE_KEY = "agentgate.status.auto-probe.v1";
const PROBE_INTERVAL_KEY = "agentgate.status.probe-interval.v1";
const PROBE_RECORDS_KEY = "agentgate.status.records.v1";
const PROBE_MODELS_KEY = "agentgate.status.probe-models.v1";

type ProbeState = "healthy" | "smooth" | "limited" | "unhealthy" | "unknown";

interface ProbeRecord {
  samples: ProbeResult[];
  result?: ProbeResult;
  checking: boolean;
  error?: string;
}

interface ProbeBatchItem<T> {
  profile: T;
  result?: ProbeResult;
  error?: string;
}

interface StatusViewProps {
  profiles: ReadonlyArray<Profile>;
  gateway?: Pick<GatewayState, "routes">;
  busy?: boolean;
  busyId?: string;
  onApply?: (id: string, targets: Profile["targets"]) => void;
  settings?: AppSettings;
  onSettingsChange?: (patch: Partial<AppSettings>) => void;
  active?: boolean;
}

const INTERVALS = [
  { value: 120_000, label: "every2m" as const },
  { value: 300_000, label: "every5m" as const },
  { value: 600_000, label: "every10m" as const },
];

export function storedAutoProbeEnabled(value: string | null): boolean {
  return value !== "false";
}

export function storedProbeInterval(value: string | null): number {
  const parsed = Number(value);
  return INTERVALS.some((option) => option.value === parsed) ? parsed : DEFAULT_INTERVAL_MS;
}

export function probeState(result: ProbeResult | undefined): ProbeState {
  if (!result) return "unknown";
  if (!result.ok) return "unhealthy";
  if (result.totalMs <= HEALTHY_RESPONSE_MS) return "healthy";
  if (result.totalMs <= SMOOTH_RESPONSE_MS) return "smooth";
  return "limited";
}

export function probeCountdownSeconds(nextProbeAt: number, now = Date.now()): number {
  if (!Number.isFinite(nextProbeAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.ceil((nextProbeAt - now) / 1_000));
}

export function probeAvailability(samples: ReadonlyArray<ProbeResult>): number | undefined {
  if (samples.length === 0) return undefined;
  return Math.round((samples.filter((sample) => sample.ok).length / samples.length) * 100);
}

export async function probeProfilesTogether<T extends { id: string }>(
  profiles: ReadonlyArray<T>,
  probe: (id: string) => Promise<ProbeResult>,
  onSettled?: (item: ProbeBatchItem<T>) => void,
): Promise<Array<ProbeBatchItem<T>>> {
  return Promise.all(profiles.map(async (profile) => {
    let item: ProbeBatchItem<T>;
    try {
      item = { profile, result: await probe(profile.id) };
    } catch (error) {
      item = { profile, error: describeError(error) };
    }
    onSettled?.(item);
    return item;
  }));
}

export function visibleProbeSamples(samples: ReadonlyArray<ProbeResult>): ProbeResult[] {
  return samples.slice(-PULSE_SLOTS);
}

function isProbeResult(value: unknown): value is ProbeResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ProbeResult>;
  return typeof result.ok === "boolean"
    && typeof result.firstByteMs === "number"
    && Number.isFinite(result.firstByteMs)
    && typeof result.totalMs === "number"
    && Number.isFinite(result.totalMs)
    && typeof result.model === "string"
    && typeof result.checkedAt === "string";
}

export function parseStoredProbeRecords(source: string | null): Record<string, ProbeRecord> {
  if (!source) return {};
  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const records: Record<string, ProbeRecord> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const stored = value as { samples?: unknown; error?: unknown };
      const samples = Array.isArray(stored.samples)
        ? stored.samples.filter(isProbeResult).slice(-MAX_SAMPLES)
        : [];
      const error = typeof stored.error === "string" ? stored.error : undefined;
      if (samples.length === 0 && !error) continue;
      records[id] = {
        samples,
        result: samples.at(-1),
        checking: false,
        error,
      };
    }
    return records;
  } catch {
    return {};
  }
}

export function parseStoredProbeModels(source: string | null): Record<string, string> {
  if (!source) return {};
  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string"
      && entry[1].trim().length > 0
      && entry[1].trim().length <= 240
    )).map(([id, model]) => [id, model.trim()]));
  } catch {
    return {};
  }
}

export function probeModelOptions(profile: Profile): string[] {
  const endpoint = profile.endpoints.find((item) => item.url === profile.baseUrl)
    ?? profile.endpoints[0];
  return [...new Set([
    profile.model,
    ...profile.availableModels,
    ...(endpoint?.models ?? []),
  ].map((model) => model.trim()).filter(Boolean))];
}

function readStoredValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function readDisabledProfileIds(): ReadonlySet<string> {
  try {
    const source = readStoredValue(DISABLED_PROFILES_KEY);
    if (!source) return new Set();
    const parsed: unknown = JSON.parse(source);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function readProbeRecords(): Record<string, ProbeRecord> {
  return parseStoredProbeRecords(readStoredValue(PROBE_RECORDS_KEY));
}

function readProbeModels(): Record<string, string> {
  return parseStoredProbeModels(readStoredValue(PROBE_MODELS_KEY));
}

function persistProbeRecords(records: Readonly<Record<string, ProbeRecord>>): void {
  try {
    const stored = Object.fromEntries(Object.entries(records).map(([id, record]) => [id, {
      samples: record.samples.slice(-MAX_SAMPLES),
      ...(record.error ? { error: record.error } : {}),
    }]));
    window.localStorage?.setItem(PROBE_RECORDS_KEY, JSON.stringify(stored));
  } catch {
    // Probe history remains available until this renderer is closed.
  }
}

function ProbePulse({ samples, label }: { samples: ReadonlyArray<ProbeResult>; label: string }): ReactElement {
  const visible = visibleProbeSamples(samples);
  const slots: Array<ProbeResult | undefined> = [
    ...Array.from({ length: PULSE_SLOTS - visible.length }, () => undefined),
    ...visible,
  ];
  return (
    <div className="status-pulse" role="img" aria-label={label}>
      {slots.map((sample, index) => (
        <i
          key={sample ? `${sample.checkedAt}-${index}` : `empty-${index}`}
          className={`status-pulse-bar ${sample ? probeState(sample) : "empty"}`}
        />
      ))}
    </div>
  );
}

function stateLabel(state: ProbeState, m: ReturnType<typeof useI18n>["m"]): string {
  if (state === "healthy") return m.status.healthy;
  if (state === "smooth") return m.status.smooth;
  if (state === "limited") return m.status.limited;
  if (state === "unhealthy") return m.status.unhealthy;
  return m.status.unknown;
}

function StateIcon({ state }: { state: ProbeState }): ReactElement {
  if (state === "healthy") return <Check size={12} />;
  if (state === "smooth") return <Check size={12} />;
  if (state === "limited") return <TriangleAlert size={12} />;
  if (state === "unhealthy") return <X size={12} />;
  return <Radio size={12} />;
}

function cloneFailoverSettings(settings: AppSettings): AppSettings["failover"] {
  return Object.fromEntries(CLIENT_TARGET_ORDER.map((target) => {
    const current = settings.failover?.[target] ?? DEFAULT_SETTINGS.failover[target];
    return [target, { enabled: current.enabled, profileIds: [...current.profileIds] }];
  })) as AppSettings["failover"];
}

interface FailoverDialogProps {
  profiles: ReadonlyArray<Profile>;
  gateway?: Pick<GatewayState, "routes">;
  settings: AppSettings;
  busy: boolean;
  onSave: (failover: AppSettings["failover"]) => void;
  onClose: () => void;
}

export function FailoverDialog({
  profiles,
  gateway,
  settings,
  busy,
  onSave,
  onClose,
}: FailoverDialogProps): ReactElement {
  const { m, fill } = useI18n();
  const [draft, setDraft] = useState<AppSettings["failover"]>(() => {
    const next = cloneFailoverSettings(settings);
    for (const target of CLIENT_TARGET_ORDER) {
      const route = gateway?.routes.find((item) => item.target === target);
      if (!next[target].enabled || !route) continue;
      if (!next[target].profileIds.includes(route.profileId)) {
        next[target].profileIds.push(route.profileId);
      }
    }
    return next;
  });

  function setEnabled(target: ClientTarget, enabled: boolean): void {
    setDraft((current) => {
      const route = gateway?.routes.find((item) => item.target === target);
      const profileIds = [...current[target].profileIds];
      if (enabled && route && !profileIds.includes(route.profileId)) profileIds.push(route.profileId);
      return { ...current, [target]: { enabled, profileIds } };
    });
  }

  function setProfileAllowed(target: ClientTarget, profileId: string, allowed: boolean): void {
    setDraft((current) => {
      const profileIds = allowed
        ? [...new Set([...current[target].profileIds, profileId])]
        : current[target].profileIds.filter((id) => id !== profileId);
      return { ...current, [target]: { ...current[target], profileIds } };
    });
  }

  return (
    <div
      className="editor-layer"
      role="dialog"
      aria-modal="true"
      aria-label={m.status.failoverTitle}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || busy) return;
        event.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        className="editor-scrim"
        aria-label={m.editor.close}
        disabled={busy}
        onClick={onClose}
      />
      <form
        className="editor-dialog failover-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
        }}
      >
        <header className="editor-head">
          <h2>{m.status.failoverTitle}</h2>
          <button
            type="button"
            className="editor-close"
            aria-label={m.editor.close}
            disabled={busy}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>
        <div className="editor-body failover-body">
          {CLIENT_TARGET_ORDER.map((target) => {
            const targetSettings = draft[target];
            const route = gateway?.routes.find((item) => item.target === target);
            const compatible = profiles.filter((profile) => profile.targets.includes(target));
            const toggleLabel = fill(
              targetSettings.enabled ? m.status.disableFailover : m.status.enableFailover,
              { client: CLIENT_META[target].label },
            );
            return (
              <section className="failover-client" key={target}>
                <header className="failover-client-head">
                  <div>
                    <strong>{CLIENT_META[target].label}</strong>
                    <span>{fill(m.status.failoverSelected, { count: targetSettings.profileIds.length })}</span>
                  </div>
                  <label className="failover-switch" data-hint={toggleLabel}>
                    <input
                      type="checkbox"
                      className="switch-input"
                      checked={targetSettings.enabled}
                      disabled={busy}
                      aria-label={toggleLabel}
                      onChange={(event) => setEnabled(target, event.target.checked)}
                    />
                    <span className={`kd-switch ${targetSettings.enabled ? "checked" : ""}`} aria-hidden="true"><span /></span>
                  </label>
                </header>
                <div className="failover-candidate-head">
                  <span>{m.status.failoverCandidates}</span>
                </div>
                {compatible.length === 0 ? (
                  <p className="failover-empty">{m.status.failoverNoProfiles}</p>
                ) : (
                  <div className="failover-profile-list">
                    {compatible.map((profile) => {
                      const current = route?.profileId === profile.id;
                      const checked = targetSettings.profileIds.includes(profile.id);
                      return (
                        <label key={profile.id}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy || (targetSettings.enabled && current)}
                            onChange={(event) => setProfileAllowed(target, profile.id, event.target.checked)}
                          />
                          <span title={profile.name}>{profile.name}</span>
                          {current && <small>{m.status.failoverCurrent}</small>}
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <footer className="editor-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
            {m.editor.cancel}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {m.editor.save}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function StatusView({
  profiles,
  gateway,
  busy = false,
  busyId,
  onApply,
  settings = DEFAULT_SETTINGS,
  onSettingsChange,
  active = true,
}: StatusViewProps): ReactElement {
  const { locale, m, fill } = useI18n();
  const [records, setRecords] = useState<Record<string, ProbeRecord>>(readProbeRecords);
  const [disabledIds, setDisabledIds] = useState<ReadonlySet<string>>(readDisabledProfileIds);
  const [probeModels, setProbeModels] = useState<Record<string, string>>(readProbeModels);
  const [auto, setAuto] = useState(() => storedAutoProbeEnabled(readStoredValue(AUTO_PROBE_KEY)));
  const [intervalMs, setIntervalMs] = useState(() => storedProbeInterval(readStoredValue(PROBE_INTERVAL_KEY)));
  const [running, setRunning] = useState(false);
  const [nextProbeAt, setNextProbeAt] = useState(() => Date.now() + intervalMs);
  const [clockMs, setClockMs] = useState(Date.now);
  const [failoverOpen, setFailoverOpen] = useState(false);
  const profilesRef = useRef(profiles);
  const disabledRef = useRef(disabledIds);
  const probeModelsRef = useRef(probeModels);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const profilesWereAvailableRef = useRef(profiles.length > 0);

  profilesRef.current = profiles;
  disabledRef.current = disabledIds;
  probeModelsRef.current = probeModels;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage?.setItem(DISABLED_PROFILES_KEY, JSON.stringify([...disabledIds].sort()));
    } catch {
      // Monitoring preferences remain usable for this run when storage is unavailable.
    }
  }, [disabledIds]);

  useEffect(() => {
    try {
      window.localStorage?.setItem(AUTO_PROBE_KEY, String(auto));
      window.localStorage?.setItem(PROBE_INTERVAL_KEY, String(intervalMs));
    } catch {
      // Probe controls remain usable for this run when storage is unavailable.
    }
  }, [auto, intervalMs]);

  useEffect(() => {
    persistProbeRecords(records);
  }, [records]);

  useEffect(() => {
    try {
      window.localStorage?.setItem(PROBE_MODELS_KEY, JSON.stringify(probeModels));
    } catch {
      // Per-profile model choices remain usable for this run when storage is unavailable.
    }
  }, [probeModels]);

  const probeAll = useCallback(async (): Promise<void> => {
    if (runningRef.current || !api.probeProfile) return;
    const snapshot = profilesRef.current.filter((profile) => !disabledRef.current.has(profile.id));
    if (snapshot.length === 0) return;

    runningRef.current = true;
    setRunning(true);
    setRecords((current) => {
      const next = { ...current };
      for (const profile of snapshot) {
        next[profile.id] = {
          ...(current[profile.id] ?? { samples: [] }),
          checking: true,
          error: undefined,
        };
      }
      return next;
    });

    const modelSnapshot = probeModelsRef.current;
    await probeProfilesTogether(
      snapshot,
      (id) => api.probeProfile!(id, modelSnapshot[id]),
      (item) => {
        if (!mountedRef.current) return;
        setRecords((current) => {
          const previous = current[item.profile.id] ?? { samples: [], checking: false };
          if (disabledRef.current.has(item.profile.id)) {
            return { ...current, [item.profile.id]: { ...previous, checking: false } };
          }
          if (item.result) {
            return {
              ...current,
              [item.profile.id]: {
                samples: [...previous.samples, item.result].slice(-MAX_SAMPLES),
                result: item.result,
                checking: false,
              },
            };
          }
          return {
            ...current,
            [item.profile.id]: {
              ...previous,
              checking: false,
              error: item.error,
            },
          };
        });
      },
    );
    runningRef.current = false;
    if (mountedRef.current) setRunning(false);
  }, []);

  useEffect(() => {
    if (!auto) return undefined;
    setNextProbeAt(Date.now() + intervalMs);
    void probeAll();
    const timer = window.setInterval(() => {
      setNextProbeAt(Date.now() + intervalMs);
      void probeAll();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [auto, intervalMs, probeAll]);

  useEffect(() => {
    if (!active || !auto) return undefined;
    const tick = () => setClockMs(Date.now());
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [active, auto]);

  useEffect(() => {
    if (profiles.length === 0 || profilesWereAvailableRef.current) return;
    profilesWereAvailableRef.current = true;
    if (auto) void probeAll();
  }, [auto, probeAll, profiles.length]);

  const enabledProfiles = useMemo(
    () => profiles.filter((profile) => !disabledIds.has(profile.id)),
    [disabledIds, profiles],
  );
  const summary = useMemo(() => {
    const counts: Record<ProbeState, number> = {
      healthy: 0,
      smooth: 0,
      limited: 0,
      unhealthy: 0,
      unknown: 0,
    };
    for (const profile of enabledProfiles) {
      const record = records[profile.id];
      counts[record?.error ? "unhealthy" : probeState(record?.result)] += 1;
    }
    return counts;
  }, [enabledProfiles, records]);

  function setProfileMonitoring(id: string, enabled: boolean): void {
    setDisabledIds((current) => {
      const next = new Set(current);
      if (enabled) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setProfileProbeModel(id: string, model: string): void {
    setProbeModels((current) => {
      const next = { ...current };
      if (model) next[id] = model;
      else delete next[id];
      return next;
    });
    setRecords((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  const unsupported = !api.probeProfile;
  const countdown = probeCountdownSeconds(nextProbeAt, clockMs);
  const currentProfileIds = useMemo(
    () => new Set(gateway?.routes.map((route) => route.profileId) ?? []),
    [gateway?.routes],
  );

  return (
    <main className="page-scroll status-page" aria-label={m.status.title} hidden={!active}>
      <div className="page-inner status-inner">
        <div className="section-head status-head rise">
          <div>
            <span className="kicker">SIGNAL DECK</span>
            <h1>{m.status.title}</h1>
          </div>
          <div className="status-controls">
            <button
              type="button"
              className="ghost-pill status-failover"
              aria-haspopup="dialog"
              aria-expanded={failoverOpen}
              disabled={!onSettingsChange}
              onClick={() => setFailoverOpen(true)}
            >
              <Settings2 size={13} />
              {m.status.failover}
            </button>
            <label className="status-interval">
              <Clock3 size={13} />
              <span>{m.status.interval}</span>
              <select
                value={intervalMs}
                aria-label={m.status.interval}
                onChange={(event) => setIntervalMs(Number(event.target.value))}
              >
                {INTERVALS.map((option) => (
                  <option value={option.value} key={option.value}>{m.status[option.label]}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="icon-ghost"
              title={auto ? m.status.pause : m.status.resume}
              aria-label={auto ? m.status.pause : m.status.resume}
              disabled={unsupported || enabledProfiles.length === 0}
              onClick={() => setAuto((current) => !current)}
            >
              {auto ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              type="button"
              className="ghost-pill status-refresh"
              disabled={unsupported || enabledProfiles.length === 0 || running}
              onClick={() => void probeAll()}
            >
              <RefreshCw size={13} className={running ? "spin" : undefined} />
              {m.status.refresh}
            </button>
          </div>
        </div>

        <section className="status-console rise-1" aria-live="polite">
          <div className="status-console-label"><Radio size={14} />{m.status.auto}</div>
          <div className="status-console-copy">
            <strong>{enabledProfiles.length}</strong> {m.status.enabled} · <strong>{summary.healthy}</strong> {m.status.healthy} · <strong>{summary.smooth}</strong> {m.status.smooth} · <strong>{summary.limited}</strong> {m.status.limited} · <strong>{summary.unhealthy}</strong> {m.status.unhealthy} · <strong>{summary.unknown}</strong> {m.status.unknown} · <strong>{profiles.length - enabledProfiles.length}</strong> {m.status.disabled}
          </div>
          <span className={`status-console-state ${auto ? "on" : "off"}`}>
            {running
              ? <LoaderCircle size={12} className="spin" />
              : auto ? <Radio size={12} /> : <Pause size={12} />}
            {running
              ? m.status.checking
              : auto
                ? fill(m.status.countdown, { seconds: countdown })
                : m.status.pause}
          </span>
        </section>

        {unsupported && (
          <div className="security-note status-note rise-2">
            <AlertCircle size={15} />
            <span>{m.status.unsupported}</span>
          </div>
        )}

        {profiles.length === 0 ? (
          <div className="empty-state rise-2">
            <div className="empty-icon"><Radio size={22} /></div>
            <h2>{m.keys.emptyTitle}</h2>
            <p>{m.keys.emptyHint}</p>
          </div>
        ) : (
          <div className="status-table rise-2" role="table" aria-label={m.status.title}>
            <div className="status-table-head" role="row">
              <span role="columnheader">{m.status.monitor}</span>
              <span role="columnheader">{m.status.channel}</span>
              <span role="columnheader">{m.status.model}</span>
              <span role="columnheader">{m.status.state}</span>
              <span role="columnheader">{m.status.response}</span>
              <span role="columnheader">{m.status.availability}</span>
              <span role="columnheader">{m.status.history}</span>
              <span role="columnheader">{m.status.lastCheck}</span>
              <span role="columnheader">{m.status.action}</span>
            </div>
            {profiles.map((profile) => {
              const record = records[profile.id] ?? { samples: [], checking: false };
              const disabled = disabledIds.has(profile.id);
              const state = record.error ? "unhealthy" : probeState(record.result);
              const endpoint = profile.endpoints.find((item) => item.url === profile.baseUrl) ?? profile.endpoints[0];
              const defaultModel = profile.model.trim() || endpoint?.models[0] || "";
              const selectedModel = probeModels[profile.id] ?? "";
              const model = selectedModel || defaultModel;
              const modelOptions = [...new Set([selectedModel, ...probeModelOptions(profile)])]
                .filter(Boolean)
                .filter((option) => option !== defaultModel || option === selectedModel);
              const historySamples = visibleProbeSamples(record.samples);
              const availabilityValue = probeAvailability(historySamples);
              const lastCheck = record.result?.checkedAt;
              const applying = busyId === profile.id;
              const current = currentProfileIds.has(profile.id);
              const monitoringHint = fill(
                disabled ? m.status.enableProbe : m.status.disableProbe,
                { name: profile.name },
              );
              return (
                <div
                  className={`status-row ${state} ${current ? "current" : ""} ${disabled ? "disabled" : ""} ${record.checking ? "checking" : ""}`}
                  key={profile.id}
                  role="row"
                >
                  <label className="status-row-switch" data-hint={monitoringHint}>
                    <input
                      type="checkbox"
                      className="switch-input"
                      checked={!disabled}
                      disabled={record.checking}
                      aria-label={monitoringHint}
                      onChange={(event) => setProfileMonitoring(profile.id, event.target.checked)}
                    />
                    <span className={`kd-switch small ${disabled ? "" : "checked"}`} aria-hidden="true"><span /></span>
                  </label>

                  <div className="status-row-channel" role="cell">
                    <span className={`status-row-mark ${current ? "current" : ""}`}>
                      {current ? <Zap size={12} /> : <Radio size={12} />}
                    </span>
                    <span className="status-row-name">
                      <strong title={profile.name}>{profile.name}</strong>
                      {current && <small>{m.keys.active}</small>}
                    </span>
                  </div>

                  <div className="status-row-model-cell" role="cell">
                    <select
                      className="status-row-model"
                      value={selectedModel}
                      disabled={record.checking}
                      aria-label={fill(m.status.probeModelLabel, { name: profile.name })}
                      title={model || undefined}
                      onChange={(event) => setProfileProbeModel(profile.id, event.target.value)}
                    >
                      <option value="">{fill(m.status.defaultModel, { model: defaultModel || "———" })}</option>
                      {modelOptions.map((option) => (
                        <option value={option} key={option}>{option}</option>
                      ))}
                    </select>
                  </div>
                  <span
                    className={`status-row-state ${disabled ? "disabled" : state}`}
                    role="cell"
                    title={record.error}
                  >
                    {disabled
                      ? <Pause size={12} />
                      : record.checking
                        ? <LoaderCircle size={12} className="spin" />
                        : <StateIcon state={state} />}
                    {disabled ? m.status.disabled : record.checking ? m.status.checking : stateLabel(state, m)}
                  </span>

                  <span className="status-row-latency" role="cell">
                    <strong>{record.result ? formatDuration(record.result.totalMs) : "———"}</strong>
                    <small>{m.status.firstByte} {record.result ? formatDuration(record.result.firstByteMs) : "———"}</small>
                  </span>

                  <span className={`status-row-availability ${state}`} role="cell">
                    <strong>{availabilityValue === undefined ? "———" : `${availabilityValue}%`}</strong>
                  </span>

                  <div className="status-row-history" role="cell">
                    <ProbePulse samples={historySamples} label={`${profile.name} ${m.status.availability}`} />
                  </div>

                  <span className="status-row-last" role="cell" title={record.error}>
                    {disabled
                      ? m.status.disabled
                      : record.checking
                        ? m.status.checking
                        : record.error || (lastCheck
                          ? formatCompactDateTime(lastCheck)
                          : m.status.noSamples)}
                  </span>

                  <button
                    type="button"
                    className="ghost-pill status-row-action"
                    title={fill(m.keys.switchTo, { name: profile.name })}
                    aria-label={fill(m.keys.switchTo, { name: profile.name })}
                    disabled={busy || !onApply}
                    onClick={() => onApply?.(profile.id, [...profile.targets])}
                  >
                    {applying ? <LoaderCircle size={12} className="spin" /> : <Zap size={12} />}
                    {m.keys.assign}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {failoverOpen && (
        <FailoverDialog
          profiles={profiles}
          gateway={gateway}
          settings={settings}
          busy={busy}
          onClose={() => setFailoverOpen(false)}
          onSave={(failover) => {
            onSettingsChange?.({ failover });
            setFailoverOpen(false);
          }}
        />
      )}
    </main>
  );
}

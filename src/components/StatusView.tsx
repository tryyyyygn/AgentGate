import {
  AlertCircle,
  Check,
  Clock3,
  LoaderCircle,
  Pause,
  Play,
  Radio,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { PROTOCOL_META } from "../config";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { describeError, formatDuration, relativeTime } from "../lib/format";
import type { Profile, ProbeResult } from "../types";

const DEFAULT_INTERVAL_MS = 120_000;
const MAX_SAMPLES = 60;
const PULSE_SLOTS = 24;
const LIMITED_RESPONSE_MS = 5_000;
const DISABLED_PROFILES_KEY = "agentgate.status.disabled-profiles.v1";
const AUTO_PROBE_KEY = "agentgate.status.auto-probe.v1";
const PROBE_INTERVAL_KEY = "agentgate.status.probe-interval.v1";
const PROBE_RECORDS_KEY = "agentgate.status.records.v1";
const PROBE_MODELS_KEY = "agentgate.status.probe-models.v1";

type ProbeState = "healthy" | "limited" | "unhealthy" | "unknown";

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
  return result.totalMs >= LIMITED_RESPONSE_MS ? "limited" : "healthy";
}

export function probeAvailability(samples: ReadonlyArray<ProbeResult>): number | undefined {
  if (samples.length === 0) return undefined;
  return Math.round((samples.filter((sample) => sample.ok).length / samples.length) * 100);
}

export async function probeProfilesTogether<T extends { id: string }>(
  profiles: ReadonlyArray<T>,
  probe: (id: string) => Promise<ProbeResult>,
): Promise<Array<ProbeBatchItem<T>>> {
  return Promise.all(profiles.map(async (profile) => {
    try {
      return { profile, result: await probe(profile.id) };
    } catch (error) {
      return { profile, error: describeError(error) };
    }
  }));
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
  const visible = samples.slice(-PULSE_SLOTS);
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
  if (state === "limited") return m.status.limited;
  if (state === "unhealthy") return m.status.unhealthy;
  return m.status.unknown;
}

function StateIcon({ state }: { state: ProbeState }): ReactElement {
  if (state === "healthy") return <Check size={12} />;
  if (state === "limited") return <TriangleAlert size={12} />;
  if (state === "unhealthy") return <X size={12} />;
  return <Radio size={12} />;
}

export function StatusView({ profiles, active = true }: StatusViewProps): ReactElement {
  const { locale, m, fill } = useI18n();
  const [records, setRecords] = useState<Record<string, ProbeRecord>>(readProbeRecords);
  const [disabledIds, setDisabledIds] = useState<ReadonlySet<string>>(readDisabledProfileIds);
  const [probeModels, setProbeModels] = useState<Record<string, string>>(readProbeModels);
  const [auto, setAuto] = useState(() => storedAutoProbeEnabled(readStoredValue(AUTO_PROBE_KEY)));
  const [intervalMs, setIntervalMs] = useState(() => storedProbeInterval(readStoredValue(PROBE_INTERVAL_KEY)));
  const [running, setRunning] = useState(false);
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
    const batch = await probeProfilesTogether(
      snapshot,
      (id) => api.probeProfile!(id, modelSnapshot[id]),
    );
    if (mountedRef.current) {
      setRecords((current) => {
        const next = { ...current };
        for (const item of batch) {
          const previous = current[item.profile.id] ?? { samples: [], checking: false };
          if (disabledRef.current.has(item.profile.id)) {
            next[item.profile.id] = { ...previous, checking: false };
          } else if (item.result) {
            next[item.profile.id] = {
              samples: [...previous.samples, item.result].slice(-MAX_SAMPLES),
              result: item.result,
              checking: false,
            };
          } else {
            next[item.profile.id] = {
              ...previous,
              checking: false,
              error: item.error,
            };
          }
        }
        return next;
      });
    }
    runningRef.current = false;
    if (mountedRef.current) setRunning(false);
  }, []);

  useEffect(() => {
    if (!auto) return undefined;
    void probeAll();
    const timer = window.setInterval(() => void probeAll(), intervalMs);
    return () => window.clearInterval(timer);
  }, [auto, intervalMs, probeAll]);

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
    const counts: Record<ProbeState, number> = { healthy: 0, limited: 0, unhealthy: 0, unknown: 0 };
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

  return (
    <main className="page-scroll status-page" aria-label={m.status.title} hidden={!active}>
      <div className="page-inner status-inner">
        <div className="section-head status-head rise">
          <div>
            <span className="kicker">SIGNAL DECK</span>
            <h1>{m.status.title}</h1>
          </div>
          <span className="head-note">{m.status.subtitle}</span>
          <div className="status-controls">
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

        <section className="status-console rise-1" aria-live="polite" title={m.status.requestNote}>
          <div className="status-console-label"><Radio size={14} />{m.status.auto}</div>
          <div className="status-console-copy">
            <strong>{enabledProfiles.length}</strong> {m.status.enabled} · <strong>{summary.healthy}</strong> {m.status.healthy} · <strong>{summary.limited}</strong> {m.status.limited} · <strong>{summary.unhealthy}</strong> {m.status.unhealthy} · <strong>{summary.unknown}</strong> {m.status.unknown} · <strong>{profiles.length - enabledProfiles.length}</strong> {m.status.disabled}
          </div>
          <span className={`status-console-state ${auto ? "on" : "off"}`}>
            {running
              ? <LoaderCircle size={12} className="spin" />
              : auto ? <Radio size={12} /> : <Pause size={12} />}
            {running ? m.status.checking : auto ? m.status.auto : m.status.pause}
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
              const hourlySamples = record.samples.filter((sample) => {
                const checkedAt = Date.parse(sample.checkedAt);
                return Number.isFinite(checkedAt) && checkedAt >= Date.now() - 60 * 60_000;
              });
              const availabilityValue = probeAvailability(hourlySamples);
              const lastCheck = record.result?.checkedAt;
              const monitoringHint = fill(
                disabled ? m.status.enableProbe : m.status.disableProbe,
                { name: profile.name },
              );
              return (
                <div
                  className={`status-row ${state} ${disabled ? "disabled" : ""} ${record.checking ? "checking" : ""}`}
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
                    <span className="status-row-mark"><Radio size={12} /></span>
                    <span className="status-row-name">
                      <strong title={profile.name}>{profile.name}</strong>
                      <small>
                        <em>{PROTOCOL_META[profile.protocol].short}</em>
                        <code title={endpoint?.url}>{(endpoint?.url ?? profile.baseUrl).replace(/^https?:\/\//, "")}</code>
                      </small>
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
                    <small>#{hourlySamples.length}</small>
                  </span>

                  <div className="status-row-history" role="cell">
                    <ProbePulse samples={record.samples} label={`${profile.name} ${m.status.availability}`} />
                  </div>

                  <span className="status-row-last" role="cell" title={record.error}>
                    {disabled
                      ? m.status.disabled
                      : record.checking
                        ? m.status.checking
                        : record.error || (lastCheck
                          ? relativeTime(lastCheck, locale, m.status.noSamples)
                          : m.status.noSamples)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

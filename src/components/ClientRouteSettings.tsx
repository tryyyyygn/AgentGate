import { Check, Gauge, LoaderCircle, Radio, Settings2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CLIENT_META, PROTOCOL_META } from "../config";
import { useI18n } from "../i18n";
import { decisionReasonLabel } from "./StatusView";
import { ConfirmDialog } from "./ConfirmDialog";
import type {
  AppSettings,
  AutoSwitchPublicState,
  ClientStatus,
  ClientTarget,
  GatewayState,
  Profile,
  ProfileGroup,
} from "../types";

interface ClientRouteSettingsProps {
  target: ClientTarget;
  profiles: ReadonlyArray<Profile>;
  groups: ReadonlyArray<ProfileGroup>;
  clients: ReadonlyArray<ClientStatus>;
  gateway: GatewayState;
  settings: AppSettings;
  autoSwitch?: AutoSwitchPublicState;
  busy: boolean;
  onSave: (failover: AppSettings["failover"]) => Promise<boolean>;
  onClose: () => void;
}

function cloneFailover(settings: AppSettings, target: ClientTarget): AppSettings["failover"][ClientTarget] {
  const value = settings.failover?.[target] ?? { enabled: false, profileIds: [] };
  return { enabled: value.enabled, profileIds: [...value.profileIds] };
}

export function failoverDraftChanged(
  initial: AppSettings["failover"][ClientTarget],
  draft: AppSettings["failover"][ClientTarget],
): boolean {
  return JSON.stringify(initial) !== JSON.stringify(draft);
}

export function ClientRouteSettings({
  target,
  profiles,
  groups,
  clients,
  gateway,
  settings,
  autoSwitch,
  busy,
  onSave,
  onClose,
}: ClientRouteSettingsProps): ReactElement {
  const { m, fill } = useI18n();
  const initialDraft = useRef(cloneFailover(settings, target));
  const [draft, setDraft] = useState(() => initialDraft.current);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const route = gateway.routes.find((item) => item.target === target);
  const currentProfile = route ? profiles.find((profile) => profile.id === route.profileId) : undefined;
  const client = clients.find((item) => item.target === target);
  const compatible = useMemo(() => profiles.filter((profile) => (
    profile.targets.includes(target) && PROTOCOL_META[profile.protocol].compatible.includes(target)
  )), [profiles, target]);
  const groupNames = useMemo(
    () => new Map(groups.map((group) => [group.id, group.name])),
    [groups],
  );
  const grouped = useMemo(() => {
    const result = new Map<string, Profile[]>();
    for (const profile of compatible) {
      const group = profile.groupId ? groupNames.get(profile.groupId) : undefined;
      const key = group || m.keys.ungrouped;
      const list = result.get(key) ?? [];
      list.push(profile);
      result.set(key, list);
    }
    return result;
  }, [compatible, groupNames, m.keys.ungrouped]);

  function setEnabled(enabled: boolean): void {
    setDraft((current) => {
      const profileIds = [...current.profileIds];
      if (enabled && route && !profileIds.includes(route.profileId)) profileIds.push(route.profileId);
      return { enabled, profileIds };
    });
  }

  function setCandidate(profileId: string, checked: boolean): void {
    setDraft((current) => ({
      ...current,
      profileIds: checked
        ? [...new Set([...current.profileIds, profileId])]
        : current.profileIds.filter((id) => id !== profileId),
    }));
  }

  async function save(): Promise<void> {
    if (saving || busy) return;
    setSaving(true);
    try {
      const next = { ...settings.failover, [target]: draft };
      if (await onSave(next)) onClose();
    } finally {
      setSaving(false);
    }
  }

  function requestClose(): void {
    if (busy || saving) return;
    if (failoverDraftChanged(initialDraft.current, draft)) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  const gatewayOn = gateway.status === "running" || gateway.status === "starting";
  const monitoringStatus = currentProfile?.health?.status ?? "unknown";
  const statusLabel = monitoringStatus === "healthy"
    ? m.status.healthy
    : monitoringStatus === "limited"
      ? m.status.limited
      : monitoringStatus === "unhealthy" ? m.status.unhealthy : m.status.unknown;
  const statusTone = monitoringStatus === "healthy"
    ? "good"
    : monitoringStatus === "unhealthy" ? "bad" : "warn";
  const toggleLabel = fill(
    draft.enabled ? m.status.disableFailover : m.status.enableFailover,
    { client: CLIENT_META[target].label },
  );
  const failoverDecision = autoSwitch?.failover[target];
  const officialMode = target === "codex" && !(gatewayOn && gateway.engaged.includes(target));

  return (
    <div
      className="editor-layer"
      role="dialog"
      aria-modal="true"
      aria-label={`${CLIENT_META[target].label} · ${m.status.failoverTitle}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || confirmDiscard) return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
    >
      <button type="button" className="editor-scrim" aria-label={m.editor.close} disabled={busy || saving} onClick={requestClose} />
      <section className="editor-dialog client-route-dialog">
        <header className="editor-head">
          <div className="client-route-title">
            <Settings2 size={15} />
            <div>
              <span className="kicker">{CLIENT_META[target].short.toUpperCase()}</span>
              <h2>{m.status.failoverTitle}</h2>
            </div>
          </div>
          <button type="button" className="editor-close" aria-label={m.editor.close} disabled={busy || saving} onClick={requestClose}>
            <X size={15} />
          </button>
        </header>

        <div className="editor-body client-route-body">
          <section className="client-route-summary" aria-label={m.status.channel}>
            <div className="client-route-summary-main">
              <div className="client-route-name">
                <span className={`socket-dot dot-${statusTone}`} />
                <strong>{currentProfile?.name ?? route?.profileName ?? m.overview.noProfileBound}</strong>
              </div>
              <code>{currentProfile?.baseUrl ?? client?.baseUrl ?? m.overview.noProfileBound}</code>
            </div>
            <div className="client-route-summary-state">
              {gatewayOn && gateway.engaged.includes(target) ? <Check size={13} /> : <Radio size={13} />}
              <span>{officialMode ? m.config.restoreOfficialMode : gatewayOn && gateway.engaged.includes(target) ? m.config.gatewayMode : m.overview.notEngaged}</span>
              <small>{statusLabel}</small>
            </div>
          </section>

          <section className="client-route-section">
            <div className="client-route-section-head">
              <div>
                <strong>{m.status.failoverTitle}</strong>
                <p>{m.status.failoverCandidates}</p>
              </div>
              <label className="failover-switch" data-hint={toggleLabel}>
                <input
                  type="checkbox"
                  className="switch-input"
                  checked={draft.enabled}
                  disabled={busy || saving}
                  aria-label={toggleLabel}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                <span className={`kd-switch ${draft.enabled ? "checked" : ""}`} aria-hidden="true"><span /></span>
              </label>
            </div>
            <p className="client-route-hint">{m.keys.autoSwitchOn}</p>
          </section>

          <section className="client-route-section">
            <div className="client-route-section-head compact">
              <div>
                <strong>{m.status.auto}</strong>
                <p>{m.status.interval} · {currentProfile?.autoSwitch.intervalMinutes ?? 2} min</p>
              </div>
              <Gauge size={15} />
            </div>
            <p className="client-route-hint">
              {currentProfile?.autoSwitch.enabled ? m.status.enabled : m.status.disabled}
              {currentProfile ? ` · ${statusLabel}` : ` · ${m.status.noSamples}`}
            </p>
            {failoverDecision && (
              <p className="client-route-hint">
                {decisionReasonLabel(failoverDecision.reason, m)} · {fill(m.status.decisionFailureCount, {
                  count: failoverDecision.failureCount,
                  threshold: failoverDecision.failureThreshold,
                })}
                {failoverDecision.cooldownUntil ? ` · ${m.status.decisionCooling}` : ""}
              </p>
            )}
          </section>

          <section className="client-route-section">
            <div className="client-route-section-head compact">
              <div>
                <strong>{m.status.failoverCandidates}</strong>
                <p>{fill(m.status.failoverSelected, { count: draft.profileIds.length })}</p>
              </div>
            </div>
            {compatible.length === 0 ? (
              <p className="failover-empty">{m.status.failoverNoProfiles}</p>
            ) : (
              <div className="client-route-candidates">
                {[...grouped.entries()].map(([group, groupProfiles]) => (
                  <div key={group} className="client-route-group">
                    <span className="client-route-group-name">{group}</span>
                    {groupProfiles.map((profile) => {
                      const current = route?.profileId === profile.id;
                      return (
                        <label key={profile.id}>
                          <input
                            type="checkbox"
                            checked={draft.profileIds.includes(profile.id)}
                            disabled={busy || saving || (draft.enabled && current)}
                            onChange={(event) => setCandidate(profile.id, event.target.checked)}
                          />
                          <span>{profile.name}</span>
                          <small>{current ? m.status.failoverCurrent : PROTOCOL_META[profile.protocol].short}</small>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <footer className="editor-foot">
          <button type="button" className="btn-ghost" disabled={busy || saving} onClick={requestClose}>{m.editor.cancel}</button>
          <button type="button" className="btn-primary" disabled={busy || saving} onClick={() => void save()}>
            {saving ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
            {saving ? m.editor.saving : m.editor.save}
          </button>
        </footer>
      </section>
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

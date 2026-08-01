import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CLIENT_META, DEFAULT_SETTINGS, EMPTY_BOOTSTRAP } from "../config";
import { MESSAGES, fill, resolveLocale } from "../i18n";
import { api } from "../lib/api";
import { describeError } from "../lib/format";
import { mergeActiveRequests } from "../lib/requests";
import type {
  BootstrapData,
  ClientTarget,
  AppSettings,
  GatewayStartSettings,
  GatewayStopSettings,
  Profile,
  ProfileGroup,
  ProfileOrganizationInput,
  SaveProfileInput,
  StateChangedEvent,
} from "../types";
import type { BusyAction, ToastState } from "../ui-types";

const DEFAULT_TOAST_DURATION_MS = 4_200;

/** 用量事件只替换一个公开方案；找不到时交给调用方决定是否回退完整刷新。 */
export function mergeProfileUsage(profiles: Profile[], updated: Profile): Profile[] {
  let found = false;
  const next = profiles.map((profile) => {
    if (profile.id !== updated.id) return profile;
    found = true;
    return updated;
  });
  return found ? next : profiles;
}

export function isCodexGatewayConflict(message: string): boolean {
  return /^Local gateway configuration conflict for codex(?:;|$)/i.test(message.trim());
}

export interface AgentGateController {
  data: BootstrapData;
  busy: BusyAction | null;
  busyId?: string;
  bootstrapError?: string;
  toast?: ToastState;
  setToast: (toast?: ToastState) => void;
  refresh: () => Promise<void>;
  saveProfile: (input: SaveProfileInput) => Promise<Profile | undefined>;
  duplicateProfile: (profile: Profile) => Promise<Profile | undefined>;
  reorderProfiles: (ids: string[]) => Promise<void>;
  saveProfileGroup: (
    group: ProfileGroup | undefined,
    name: string,
    profileIds: string[],
  ) => Promise<boolean>;
  deleteProfileGroup: (group: ProfileGroup) => Promise<boolean>;
  organizeProfiles: (input: ProfileOrganizationInput) => Promise<void>;
  applyProfile: (id: string, targets?: ClientTarget[]) => Promise<void>;
  testProfile: (id: string) => Promise<string[] | undefined>;
  testProfileDraft: (input: SaveProfileInput) => Promise<string[] | undefined>;
  checkProfileHealth: (id: string) => Promise<void>;
  checkAllProfilesHealth: () => Promise<void>;
  /** 正在后台检测端点的方案 ID 集合；检测不锁定其他操作。 */
  testingIds: ReadonlySet<string>;
  deleteProfile: (profile: Profile) => Promise<boolean>;
  copyKey: (profile: Profile) => Promise<void>;
  openConfig: (target: ClientTarget) => Promise<void>;
  startGateway: (settings: GatewayStartSettings) => Promise<void>;
  stopGateway: (settings?: GatewayStopSettings) => Promise<void>;
  restoreCodexOfficial: () => Promise<void>;
  reassignPort: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<boolean>;
  checkForUpdate: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  undoHistory: (entry: import("../types").HistoryEntry) => Promise<boolean>;
}

/**
 * 统一管理 Agent;Gate 主界面的异步数据与命令状态。
 *
 * Hook 负责调用受隔离的 preload API、合并返回数据、维护 loading 状态并将
 * 异常转换为提示条。所有写入副作用都由 Electron 主进程执行；失败时本地状态
 * 不会提前假定成功。
 *
 * @returns 主界面需要的数据、忙碌状态和操作函数。
 */
export function useAgentGateController(): AgentGateController {
  const [data, setData] = useState<BootstrapData>(EMPTY_BOOTSTRAP);

  // 提示条文案要跟随语言，但把 m 塞进每个 useCallback 的依赖会让回调身份随语言
  // 变化、连带重挂事件监听。用 ref 持有最新文案，回调身份保持稳定。
  const language = data.settings?.language;
  const messages = useMemo(() => MESSAGES[resolveLocale(language)], [language]);
  const m = useRef(messages);
  m.current = messages;

  /** 应用完整快照；缺失的可选字段沿用当前值，避免请求记录和设置被清空。 */
  const mergeBootstrap = useCallback((next: BootstrapData): void => {
    setData((current) => {
      const nextRevision = next.activeRequestsRevision;
      const currentRevision = current.activeRequestsRevision;
      const acceptsRequestSnapshot = next.activeRequests !== undefined
        && (nextRevision === undefined
          || currentRevision === undefined
          || nextRevision >= currentRevision);
      return {
        ...next,
        profileGroups: next.profileGroups ?? current.profileGroups,
        settings: next.settings ?? current.settings,
        activeRequests: acceptsRequestSnapshot
          ? next.activeRequests
          : current.activeRequests,
        activeRequestsRevision: acceptsRequestSnapshot
          ? (nextRevision ?? currentRevision)
          : currentRevision,
        update: next.update ?? current.update,
      };
    });
  }, []);
  const [busy, setBusy] = useState<BusyAction | null>("load");
  const [busyId, setBusyId] = useState<string>();
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [toast, setToast] = useState<ToastState>();
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(() => new Set());
  const requestSequence = useRef(0);
  const commandLock = useRef(false);
  const testingRef = useRef(new Set<string>());
  const shownStartupError = useRef<string | undefined>(undefined);

  const loadLatest = useCallback(async (): Promise<boolean> => {
    const requestId = ++requestSequence.current;
    const next = await api.getBootstrap();
    const isLatest = requestId === requestSequence.current;
    if (isLatest) mergeBootstrap(next);
    return isLatest;
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (commandLock.current) return;
    setBusy("load");
    setBootstrapError(undefined);
    try {
      await loadLatest();
    } catch (error) {
      const message = describeError(error);
      setBootstrapError(message);
      setToast({ kind: "error", message });
    } finally {
      setBusy(null);
    }
  }, [loadLatest]);

  /**
   * 静默同步完整主进程状态。
   *
   * @param completedMessage 可选的已完成操作说明；同步失败时用于明确区分
   * 操作结果与界面刷新结果，避免用户重复执行已经成功的写操作。
   * @returns 同步成功时返回 true；失败时显示错误并返回 false。
   */
  const refreshSilently = useCallback(async (completedMessage?: string): Promise<boolean> => {
    try {
      const isLatest = await loadLatest();
      if (!isLatest) return false;
      return true;
    } catch (error) {
      const refreshError = describeError(error);
      setToast({
        kind: "error",
        message: completedMessage
          ? fill(m.current.toast.refreshFailed, { message: completedMessage, error: refreshError })
          : refreshError,
      });
      return false;
    }
  }, [loadLatest]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const message = data.startupError;
    if (!message || shownStartupError.current === message) return undefined;
    const show = () => {
      if (document.visibilityState === "hidden") return;
      shownStartupError.current = message;
      setToast({ kind: "error", message });
      window.removeEventListener("focus", show);
      document.removeEventListener("visibilitychange", show);
    };
    show();
    if (shownStartupError.current === message) return undefined;
    window.addEventListener("focus", show);
    document.addEventListener("visibilitychange", show);
    return () => {
      window.removeEventListener("focus", show);
      document.removeEventListener("visibilitychange", show);
    };
  }, [data.startupError]);

  useEffect(() => api.onStateChanged((event: StateChangedEvent) => {
    if (event.type === "active-requests-changed") {
      /*
       * patch = 只带了变动记录的最新状态，可能包含刚结束的行和过期删除 ID。
       *
       * 传输途中每 200ms 一次的进度通知，原本推的是整部三天历史。那部分
       * 根本没变，白白序列化过来——主进程那边实测吃掉了转发路径八成六的 CPU。
       * 现在只推变动记录，这里按 id 做 upsert，并移除明确淘汰的历史行。
      */
      if (event.patch) {
        setData((current) => {
          if (event.revision !== undefined
            && current.activeRequestsRevision !== undefined
            && event.revision <= current.activeRequestsRevision) return current;
          return {
            ...current,
            activeRequests: mergeActiveRequests(
              current.activeRequests ?? [],
              event.activeRequests,
              event.removedRequestIds,
            ),
            activeRequestsRevision: event.revision ?? current.activeRequestsRevision,
          };
        });
        return;
      }
      setData((current) => {
        if (event.revision !== undefined
          && current.activeRequestsRevision !== undefined
          && event.revision <= current.activeRequestsRevision) return current;
        return {
          ...current,
          activeRequests: event.activeRequests,
          activeRequestsRevision: event.revision ?? current.activeRequestsRevision,
        };
      });
      return;
    }
    if (event.type === "settings-changed") {
      setData((current) => ({ ...current, settings: event.settings }));
      return;
    }
    if (event.type === "auto-switch-decision") {
      setData((current) => ({ ...current, autoSwitch: event.autoSwitch }));
      return;
    }
    if (event.type === "update-state-changed") {
      setData((current) => ({ ...current, update: event.update }));
      return;
    }
    if ((event as { type: string }).type === "profile-usage-changed") {
      const profile = (event as { type: string; profile?: Profile }).profile;
      if (!profile) {
        void refreshSilently();
        return;
      }
      setData((current) => {
        const profiles = mergeProfileUsage(current.profiles, profile);
        if (profiles === current.profiles) return current;
        return { ...current, profiles };
      });
      return;
    }
    void refreshSilently();
    if (event.type === "gateway-state-changed") return;
    if (event.type === "auto-switch-error") {
      setToast({ kind: "error", message: event.message ?? m.current.toast.autoSwitchFailed });
      return;
    }
    if (event.type === "failure-switch") {
      if (event.switched && event.profileName) {
        setToast({
          kind: "info",
          message: fill(m.current.toast.failoverSwitched, {
            client: CLIENT_META[event.target].short,
            name: event.profileName,
          }),
        });
      } else {
        setToast({ kind: "error", message: event.message ?? m.current.toast.failoverFailed });
      }
      return;
    }
    if (event.switched && event.baseUrl) {
      setToast({
        kind: "info",
        message: fill(m.current.toast.autoSwitched, { url: event.baseUrl }),
      });
    }
  }), [refreshSilently]);

  useEffect(() => {
    if (!toast || toast.action) return undefined;

    const timer = window.setTimeout(() => setToast(undefined), DEFAULT_TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function saveProfile(input: SaveProfileInput): Promise<Profile | undefined> {
    if (commandLock.current) return undefined;
    commandLock.current = true;
    setBusy("save");
    try {
      const saved = await api.saveProfile(input);
      const completedMessage = fill(m.current.toast.saved, { name: saved.name });
      if (await refreshSilently(completedMessage)) {
        setToast({ kind: "success", message: completedMessage });
      }
      return saved;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return undefined;
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function duplicateProfile(profile: Profile): Promise<Profile | undefined> {
    if (commandLock.current) return undefined;
    commandLock.current = true;
    setBusy("duplicate");
    setBusyId(profile.id);
    try {
      const duplicate = await api.duplicateProfile(profile.id);
      const completedMessage = fill(m.current.toast.duplicated, { name: duplicate.name });
      if (await refreshSilently(completedMessage)) {
        setToast({ kind: "success", message: completedMessage });
      }
      return duplicate;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return undefined;
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function reorderProfiles(ids: string[]): Promise<void> {
    if (commandLock.current) return;
    if (!api.reorderProfiles) {
      setToast({ kind: "error", message: m.current.toast.orderFailed });
      return;
    }
    commandLock.current = true;
    const previous = data.profiles;
    const byId = new Map(previous.map((profile) => [profile.id, profile]));
    const optimistic = [
      ...ids.map((id) => byId.get(id)).filter((profile): profile is Profile => Boolean(profile)),
      ...previous.filter((profile) => !ids.includes(profile.id)),
    ];
    setData((current) => ({ ...current, profiles: optimistic }));
    try {
      await api.reorderProfiles(ids);
      await refreshSilently(m.current.toast.reordered);
    } catch (error) {
      setData((current) => ({ ...current, profiles: previous }));
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
    }
  }

  async function saveProfileGroup(
    group: ProfileGroup | undefined,
    name: string,
    profileIds: string[],
  ): Promise<boolean> {
    if (commandLock.current) return false;
    commandLock.current = true;
    setBusy("group");
    setBusyId(group?.id);
    try {
      if (group) {
        if (group.name !== name) await api.renameProfileGroup(group.id, name);
        await api.updateProfileGroupMembers(group.id, profileIds);
      } else {
        await api.createProfileGroup(name, profileIds);
      }
      const completedMessage = fill(m.current.toast.saved, { name });
      if (await refreshSilently(completedMessage)) {
        setToast({ kind: "success", message: completedMessage });
      }
      return true;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return false;
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function deleteProfileGroup(group: ProfileGroup): Promise<boolean> {
    if (commandLock.current) return false;
    commandLock.current = true;
    setBusy("group");
    setBusyId(group.id);
    try {
      await api.deleteProfileGroup(group.id);
      const completedMessage = fill(m.current.toast.deleted, { name: group.name });
      if (await refreshSilently(completedMessage)) {
        setToast({ kind: "success", message: completedMessage });
      }
      return true;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return false;
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function organizeProfiles(input: ProfileOrganizationInput): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    const previousProfiles = data.profiles;
    const previousGroups = data.profileGroups ?? [];
    const groupsById = new Map(previousGroups.map((group) => [group.id, group]));
    const profilesById = new Map(previousProfiles.map((profile) => [profile.id, profile]));
    const optimisticGroups = [
      ...input.groupIds.map((id) => groupsById.get(id)).filter((group): group is ProfileGroup => Boolean(group)),
      ...previousGroups.filter((group) => !input.groupIds.includes(group.id)),
    ];
    const optimisticProfiles = [
      ...input.profiles.map(({ id, groupId }) => {
        const profile = profilesById.get(id);
        if (!profile) return undefined;
        profilesById.delete(id);
        return { ...profile, groupId: groupId ?? undefined };
      }).filter((profile) => profile !== undefined),
      ...previousProfiles.filter((profile) => profilesById.has(profile.id)),
    ];
    setData((current) => ({
      ...current,
      profileGroups: optimisticGroups,
      profiles: optimisticProfiles,
    }));
    try {
      await api.organizeProfiles(input);
      await refreshSilently(m.current.toast.reordered);
    } catch (error) {
      setData((current) => ({
        ...current,
        profileGroups: previousGroups,
        profiles: previousProfiles,
      }));
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
    }
  }

  async function applyProfile(id: string, targets?: ClientTarget[]): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("apply");
    setBusyId(id);
    try {
      const result = await api.applyProfile(id, targets);
      const targetLabels = result.assignedTargets
        .map((target) => CLIENT_META[target].short)
        .join(", ");
      const resultMessage = fill(
        result.gateway.status === "running"
          ? m.current.toast.assignedRunning
          : m.current.toast.assignedStopped,
        { name: result.profile.name, targets: targetLabels },
      );
      if (await refreshSilently(resultMessage)) {
        setToast({ kind: "success", message: resultMessage });
      }
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  /**
   * 识别模型：请求上游模型列表并保存。
   *
   * @returns 识别到的模型列表；失败或被其他命令阻塞时返回 undefined。
   */
  async function testProfile(id: string): Promise<string[] | undefined> {
    if (commandLock.current) return undefined;
    commandLock.current = true;
    setBusy("test");
    setBusyId(id);
    try {
      const tested = await api.testProfile(id);
      await refreshSilently(m.current.keys.discoverModels);

      if (tested.availableModels.length > 0) {
        setToast({
          kind: "success",
          message: fill(m.current.toast.modelsFound, { count: tested.availableModels.length }),
        });
      } else {
        setToast({ kind: "info", message: m.current.toast.noModels });
      }
      return tested.availableModels;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return undefined;
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function testProfileDraft(input: SaveProfileInput): Promise<string[] | undefined> {
    if (commandLock.current) return undefined;
    if (!api.testProfileDraft) {
      setToast({ kind: "error", message: m.current.toast.unsupported });
      return undefined;
    }
    commandLock.current = true;
    setBusy("test");
    setBusyId(input.id);
    try {
      const models = await api.testProfileDraft(input);
      setToast(models.length > 0
        ? {
            kind: "success",
            message: fill(m.current.toast.modelsFound, { count: models.length }),
          }
        : { kind: "info", message: m.current.toast.noModels });
      return models;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return undefined;
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  /**
   * 执行单个方案的无凭据端点检测，维护行级检测状态。
   *
   * 检测是只读探测，不占用全局命令锁；检测期间的保存/删除由主进程的
   * revision 校验兜底，过期结果会被拒绝提交。
   *
   * @returns 可达与总端点数；该方案已在检测中时返回 undefined。
   */
  async function runHealthCheck(id: string): Promise<{ reachable: number; total: number } | undefined> {
    if (testingRef.current.has(id)) return undefined;
    testingRef.current.add(id);
    setTestingIds(new Set(testingRef.current));
    try {
      const tested = await api.checkProfileHealth(id);
      const reachable = tested.endpoints.filter((endpoint) => (
        endpoint.health?.status === "healthy" || endpoint.health?.status === "limited"
      )).length;
      return { reachable, total: tested.endpoints.length };
    } finally {
      testingRef.current.delete(id);
      setTestingIds(new Set(testingRef.current));
    }
  }

  async function checkProfileHealth(id: string): Promise<void> {
    try {
      const result = await runHealthCheck(id);
      if (!result) return;
      if (!await refreshSilently(m.current.keys.testEndpoints)) return;
      setToast({
        kind: result.reachable > 0 ? "success" : "error",
        message: fill(m.current.toast.healthDone, {
          reachable: result.reachable,
          total: result.total,
        }),
      });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function checkAllProfilesHealth(): Promise<void> {
    const ids = data.profiles
      .map((profile) => profile.id)
      .filter((id) => !testingRef.current.has(id));
    if (ids.length === 0) return;
    const results = await Promise.allSettled(ids.map((id) => runHealthCheck(id)));
    await refreshSilently(m.current.keys.testEndpoints);
    const settled = results
      .map((result) => (result.status === "fulfilled" ? result.value : undefined));
    const reachableProfiles = settled
      .filter((value) => value !== undefined && value.reachable > 0).length;
    setToast({
      kind: reachableProfiles > 0 ? "success" : "error",
      message: fill(m.current.toast.healthAllDone, {
        reachable: reachableProfiles,
        total: ids.length,
      }),
    });
  }

  async function deleteProfile(profile: Profile): Promise<boolean> {
    if (commandLock.current) return false;
    commandLock.current = true;
    setBusy("delete");
    setBusyId(profile.id);
    try {
      await api.deleteProfile(profile.id);
      const completedMessage = fill(m.current.toast.deleted, { name: profile.name });
      if (await refreshSilently(completedMessage)) {
        setToast({ kind: "success", message: completedMessage });
      }
      return true;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return false;
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function copyKey(profile: Profile): Promise<void> {
    try {
      await api.copyProfileKey(profile.id);
      setToast({
        kind: "info",
        message: fill(m.current.toast.keyCopied, { name: profile.name }),
      });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function openConfig(target: ClientTarget): Promise<void> {
    try {
      await api.openConfig(target);
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function startGateway(settings: GatewayStartSettings): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("gateway-start");
    try {
      // 命令前后都作废一次旧刷新：state-changed 可能在 await 期间启动一次全量读取。
      requestSequence.current += 1;
      const next = await api.startGateway(settings);
      requestSequence.current += 1;
      mergeBootstrap(next);
      setToast({ kind: "success", message: m.current.toast.gatewayStarted });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      await refreshSilently();
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function reassignPort(): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("gateway-start");
    try {
      // 端口重分配和启动/停止一样会触发 state-changed；命令返回的最终快照
      // 必须覆盖执行期间发起的旧全量读取。
      requestSequence.current += 1;
      const next = await api.reassignPort();
      requestSequence.current += 1;
      mergeBootstrap(next);
      setToast({
        kind: "success",
        message: fill(m.current.toast.portReassigned, { port: next.gateway.port }),
      });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function stopGateway(settings?: GatewayStopSettings): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("gateway-stop");
    try {
      // 与启动相同，命令返回的最终快照应覆盖执行期间取得的中间状态。
      requestSequence.current += 1;
      const next = await api.stopGateway(settings);
      requestSequence.current += 1;
      mergeBootstrap(next);
      const skipped = next.gatewayRecovery?.skippedTargets ?? [];
      const targets = skipped.map((target) => CLIENT_META[target].short).join(", ");
      setToast({
        kind: skipped.length > 0 ? "info" : "success",
        message: skipped.length > 0
          ? fill(m.current.toast.gatewaySkipped, { targets })
          : m.current.toast.gatewayStopped,
      });
    } catch (error) {
      const message = describeError(error);
      if (isCodexGatewayConflict(message)) {
        await refreshSilently();
        setToast({
          kind: "error",
          message: m.current.toast.codexGatewayConflict,
          action: {
            label: m.current.overview.restoreOfficial,
            onClick: () => {
              setToast(undefined);
              void restoreCodexOfficial();
            },
          },
        });
      } else {
        setToast({ kind: "error", message });
        await refreshSilently();
      }
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function restoreCodexOfficial(): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("restore-official");
    try {
      requestSequence.current += 1;
      const next = await api.restoreCodexOfficial();
      requestSequence.current += 1;
      mergeBootstrap(next);
      setToast({ kind: "success", message: m.current.toast.codexOfficialRestored });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      await refreshSilently();
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function undoHistory(entry: import("../types").HistoryEntry): Promise<boolean> {
    if (commandLock.current || !entry.canUndo) return false;
    commandLock.current = true;
    setBusy("undo");
    try {
      requestSequence.current += 1;
      const next = await api.undoHistory(entry.id);
      requestSequence.current += 1;
      mergeBootstrap(next);
      setToast({ kind: "success", message: m.current.toast.undone });
      return true;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      await refreshSilently();
      return false;
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function updateSettings(patch: Partial<AppSettings>): Promise<boolean> {
    if (commandLock.current) return false;
    if (!api.updateSettings) {
      setToast({ kind: "error", message: m.current.toast.unsupported });
      return false;
    }
    commandLock.current = true;
    setBusy("settings");
    const previous = data.settings ?? DEFAULT_SETTINGS;
    const optimistic = { ...previous, ...patch };
    setData((current) => ({ ...current, settings: optimistic }));
    try {
      const result = await api.updateSettings(patch);
      const nextSettings = "profiles" in result
        ? result.settings ?? optimistic
        : result;
      setData((current) => ({ ...current, settings: nextSettings }));
      setToast({ kind: "success", message: m.current.toast.settingsSaved });
      return true;
    } catch (error) {
      setData((current) => ({ ...current, settings: previous }));
      setToast({ kind: "error", message: describeError(error) });
      return false;
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function checkForUpdate(): Promise<void> {
    if (!api.checkForUpdate) {
      setToast({ kind: "error", message: m.current.toast.unsupported });
      return;
    }
    try {
      const state = await api.checkForUpdate();
      setData((current) => ({ ...current, update: state }));
      if (state.state === "up-to-date") {
        setToast({
          kind: "success",
          message: fill(m.current.toast.upToDate, { version: state.currentVersion ?? "" }),
        });
      } else if (state.state === "error") {
        setToast({ kind: "error", message: state.message ?? m.current.toast.updateCheckFailed });
      }
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function downloadUpdate(): Promise<void> {
    if (!api.downloadUpdate) return;
    try {
      const state = await api.downloadUpdate();
      setData((current) => ({ ...current, update: state }));
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function installUpdate(): Promise<void> {
    if (!api.installUpdate) return;
    try {
      await api.installUpdate();
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  return {
    data,
    busy,
    busyId,
    bootstrapError,
    toast,
    setToast,
    refresh,
    saveProfile,
    duplicateProfile,
    reorderProfiles,
    saveProfileGroup,
    deleteProfileGroup,
    organizeProfiles,
    applyProfile,
    testProfile,
    testProfileDraft,
    checkProfileHealth,
    checkAllProfilesHealth,
    testingIds,
    deleteProfile,
    copyKey,
    openConfig,
    startGateway,
    stopGateway,
    restoreCodexOfficial,
    reassignPort,
    updateSettings,
    checkForUpdate,
    downloadUpdate,
    installUpdate,
    undoHistory,
  };
}

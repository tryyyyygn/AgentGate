import packageJson from "../package.json";
import type {
  BootstrapData,
  ClientTarget,
  Protocol,
  SaveProfileInput,
} from "./types";
import type { AppSettings } from "./types";

export const APP_VERSION = packageJson.version;

export interface ProtocolMeta {
  label: string;
  short: string;
  tone: string;
  compatible: ClientTarget[];
}

export interface ClientMeta {
  label: string;
  short: string;
  /** 品牌色调：Claude 橙、Codex 绿、Gemini 蓝、OpenCode 紫。 */
  tone: string;
}

export const PROTOCOL_META: Record<Protocol, ProtocolMeta> = {
  anthropic: {
    label: "Anthropic Messages",
    short: "Anthropic",
    tone: "accent",
    compatible: ["claude", "claude-desktop", "opencode"],
  },
  "openai-responses": {
    label: "OpenAI Responses",
    short: "Responses",
    tone: "good",
    compatible: ["codex", "opencode"],
  },
  "openai-chat": {
    label: "OpenAI Chat Completions",
    short: "Chat",
    tone: "warn",
    compatible: ["codex", "opencode"],
  },
  gemini: {
    label: "Google Gemini",
    short: "Gemini",
    tone: "blue",
    compatible: ["gemini", "opencode"],
  },
};

export const CLIENT_META: Record<ClientTarget, ClientMeta> = {
  claude: { label: "Claude Code", short: "CLI", tone: "accent" },
  "claude-desktop": {
    label: "Claude Desktop",
    short: "Desktop",
    tone: "accent",
  },
  codex: { label: "Codex", short: "Codex", tone: "good" },
  opencode: { label: "OpenCode", short: "OpenCode", tone: "violet" },
  gemini: { label: "Gemini CLI", short: "Gemini", tone: "blue" },
};

export const CLIENT_TARGET_ORDER: ClientTarget[] = [
  "claude",
  "claude-desktop",
  "codex",
  "opencode",
  "gemini",
];

export const DEFAULT_SETTINGS: AppSettings = {
  launchAtLogin: false,
  closeToTray: true,
  startGatewayOnLaunch: true,
  theme: "system",
  language: "system",
  routing: { mode: "assignment", strategy: "fixed" },
  failover: {
    claude: { enabled: false, profileIds: [] },
    "claude-desktop": { enabled: false, profileIds: [] },
    codex: { enabled: false, profileIds: [] },
    opencode: { enabled: false, profileIds: [] },
    gemini: { enabled: false, profileIds: [] },
  },
};

export const EMPTY_BOOTSTRAP: BootstrapData = {
  profiles: [],
  profileGroups: [],
  clients: [],
  history: [],
  gateway: {
    status: "stopped",
    host: "127.0.0.1",
    port: 17863,
    targets: [],
    engaged: [],
    routes: [],
  },
  settings: DEFAULT_SETTINGS,
  autoSwitch: {
    profiles: {},
    failover: {
      claude: { enabled: false, failureCount: 0, failureThreshold: 3, reason: "idle", excluded: [], history: [] },
      "claude-desktop": { enabled: false, failureCount: 0, failureThreshold: 3, reason: "idle", excluded: [], history: [] },
      codex: { enabled: false, failureCount: 0, failureThreshold: 3, reason: "idle", excluded: [], history: [] },
      opencode: { enabled: false, failureCount: 0, failureThreshold: 3, reason: "idle", excluded: [], history: [] },
      gemini: { enabled: false, failureCount: 0, failureThreshold: 3, reason: "idle", excluded: [], history: [] },
    },
  },
  activeRequests: [],
};

export const BLANK_PROFILE_INPUT: SaveProfileInput = {
  name: "",
  protocol: "openai-responses",
  baseUrl: "",
  endpoints: [{ url: "" }],
  apiKey: "",
  model: "",
  modelRoutes: {},
  authMode: "bearer",
  targets: ["codex"],
  enableToolSearch: false,
  autoSwitch: {
    enabled: false,
    intervalMinutes: 2,
  },
};

export interface ProfilePreset {
  id: string;
  /** i18n 文案键在 messages.ts 的 editor.presets 下。 */
  input: Partial<SaveProfileInput> & Pick<SaveProfileInput, "protocol" | "baseUrl" | "authMode" | "targets">;
}

const KIMI_CODING_MODEL_ROUTES: SaveProfileInput["modelRoutes"] = {
  "claude-sonnet-5": { model: "k3", labelOverride: "k3", supports1m: true },
  "claude-opus-4-8": { model: "k3", labelOverride: "k3", supports1m: true },
  "claude-haiku-4-5": { model: "k3", labelOverride: "k3", supports1m: true },
  "claude-fable-5": { model: "k3", labelOverride: "k3", supports1m: true },
};

export const PROFILE_PRESETS: ProfilePreset[] = [{
  id: "kimi-coding",
  input: {
    name: "Kimi For Coding",
    protocol: "anthropic",
    baseUrl: "https://api.kimi.com/coding",
    model: "k3",
    modelRoutes: KIMI_CODING_MODEL_ROUTES,
    authMode: "bearer",
    targets: ["claude", "claude-desktop"],
  },
}];

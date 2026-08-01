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
    compatible: ["claude", "opencode"],
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
  claude: { label: "Claude Code", short: "Claude", tone: "accent" },
  codex: { label: "Codex", short: "Codex", tone: "good" },
  opencode: { label: "OpenCode", short: "OpenCode", tone: "violet" },
  gemini: { label: "Gemini CLI", short: "Gemini", tone: "blue" },
};

export const CLIENT_TARGET_ORDER: ClientTarget[] = [
  "claude",
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
  failover: {
    claude: { enabled: false, profileIds: [] },
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
  authMode: "bearer",
  targets: ["codex"],
  enableToolSearch: false,
  autoSwitch: {
    enabled: false,
    intervalMinutes: 2,
  },
};

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const TOML = require("@iarna/toml");
const { parse } = require("jsonc-parser");
const {
  GATEWAY_OWNERSHIP,
  createAdapters,
} = require("../electron/services/adapters.cjs");
const { resolveClientPaths } = require("../electron/services/paths.cjs");

let root;
let paths;
let adapters;

const baseProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Fixture",
  protocol: "anthropic",
  baseUrl: "https://relay.example",
  model: "",
  authMode: "bearer",
  targets: ["claude"],
  enableToolSearch: false,
};

async function seed(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function writeDrafts(drafts) {
  await Promise.all(drafts.map((item) => seed(item.path, item.content)));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "keydeck-adapters-"));
  paths = {
    claude: { config: path.join(root, ".claude", "settings.json") },
    codex: { config: path.join(root, ".codex", "config.toml") },
    opencode: {
      config: path.join(root, ".config", "opencode", "opencode.jsonc"),
      auth: path.join(root, ".local", "share", "opencode", "auth.json"),
    },
    gemini: {
      config: path.join(root, ".gemini", "settings.json"),
      env: path.join(root, ".gemini", ".env"),
    },
  };
  adapters = createAdapters(paths);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("client adapters", () => {
  it("patches only Claude-owned env keys and removes conflicting auth", async () => {
    const original = `{
  // 保留此注释
  "env": {
    "KEEP_ME": "yes",
    "ANTHROPIC_API_KEY": "old-key"
  },
  "permissions": { "allow": ["Bash"] }
}\n`;
    await seed(paths.claude.config, original);

    const [draft] = await adapters.claude.build(
      {
        ...baseProfile,
        model: "claude-sonnet-4-5",
        enableToolSearch: true,
      },
      "sk-claude-secret",
    );
    const parsed = parse(draft.content);

    expect(draft.content).toContain("// 保留此注释");
    expect(parsed.permissions.allow).toEqual(["Bash"]);
    expect(parsed.env.KEEP_ME).toBe("yes");
    expect(parsed.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-claude-secret");
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("https://relay.example");
    expect(parsed.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-5");
    expect(parsed.env.ENABLE_TOOL_SEARCH).toBe("true");
  });

  it("patches Claude VS Code launch variables and disables the redundant login prompt", async () => {
    const vscodeConfig = path.join(root, "Code", "User", "settings.json");
    await seed(vscodeConfig, `{
  "claudeCode.environmentVariables": [
    // Preserve this unrelated entry comment.
    { "name": "KEEP_ME", "value": "yes" },
    { "name": "ANTHROPIC_BASE_URL", "value": "http://127.0.0.1:8090/anthropic" },
    { "name": "ANTHROPIC_API_KEY", "value": "stale-api-key" },
    { "name": "ANTHROPIC_AUTH_TOKEN", "value": "stale-auth-token" },
    { "name": "ANTHROPIC_MODEL", "value": "stale-model" }
  ],
  "claudeCode.disableLoginPrompt": false,
  "workbench.colorTheme": "Keep Theme"
}\n`);
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, vscodeConfig },
    }).claude;
    const profile = {
      ...baseProfile,
      baseUrl: "http://127.0.0.1:17863/claude",
      model: "claude-sonnet-4-5",
    };

    const drafts = await adapter.build(profile, "gateway-secret", { gateway: true });
    const vscodeDraft = drafts.find((draft) => draft.path === vscodeConfig);
    const vscode = parse(vscodeDraft.content);
    const env = Object.fromEntries(vscode["claudeCode.environmentVariables"]
      .map((entry) => [entry.name, entry.value]));

    expect(env.KEEP_ME).toBe("yes");
    expect(env.ANTHROPIC_BASE_URL).toBe(profile.baseUrl);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("gateway-secret");
    expect(env.ANTHROPIC_MODEL).toBe(profile.model);
    expect(env.ENABLE_TOOL_SEARCH).toBe("");
    expect(vscode["claudeCode.disableLoginPrompt"]).toBe(true);
    expect(vscode["workbench.colorTheme"]).toBe("Keep Theme");
    expect(vscodeDraft.content).toContain("// Preserve this unrelated entry comment.");

    const apiKeyDrafts = await adapter.build(
      { ...profile, authMode: "api-key" },
      "api-key-secret",
      { gateway: true },
    );
    const apiKeyVsCode = parse(apiKeyDrafts
      .find((draft) => draft.path === vscodeConfig).content);
    const apiKeyEnv = Object.fromEntries(apiKeyVsCode["claudeCode.environmentVariables"]
      .map((entry) => [entry.name, entry.value]));
    expect(apiKeyEnv.ANTHROPIC_API_KEY).toBe("api-key-secret");
    expect(apiKeyEnv.ANTHROPIC_AUTH_TOKEN).toBe("");
  });

  it("preserves the VS Code model when the Claude profile does not specify one", async () => {
    const vscodeConfig = path.join(root, "Code", "User", "settings.json");
    await seed(vscodeConfig, JSON.stringify({
      "claudeCode.environmentVariables": [
        { name: "ANTHROPIC_MODEL", value: "existing-model" },
      ],
    }));
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, vscodeConfig },
    }).claude;

    const drafts = await adapter.build(baseProfile, "gateway-secret", { gateway: true });
    const vscode = parse(drafts.find((draft) => draft.path === vscodeConfig).content);
    const env = Object.fromEntries(vscode["claudeCode.environmentVariables"]
      .map((entry) => [entry.name, entry.value]));

    expect(env.ANTHROPIC_MODEL).toBe("existing-model");
  });

  it("restores Claude VS Code launch variables without erasing runtime additions", async () => {
    const vscodeConfig = path.join(root, "Code", "User", "settings.json");
    await seed(vscodeConfig, `{
  "claudeCode.environmentVariables": [
    { "name": "KEEP_ME", "value": "yes" },
    { "name": "ANTHROPIC_BASE_URL", "value": "https://before.example" },
    { "name": "ANTHROPIC_API_KEY", "value": "before-api-key" },
    { "name": "ANTHROPIC_MODEL", "value": "before-model" }
  ],
  "claudeCode.disableLoginPrompt": false
}\n`);
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, vscodeConfig },
    }).claude;
    const baseline = await adapter.captureManagedState();
    await writeDrafts(await adapter.build({
      ...baseProfile,
      baseUrl: "http://127.0.0.1:17863/claude",
      model: "gateway-model",
    }, "gateway-secret", { gateway: true }));

    const during = parse(await fs.readFile(vscodeConfig, "utf8"));
    during["claudeCode.environmentVariables"].push({ name: "RUNTIME_KEEP", value: "added" });
    during["editor.fontSize"] = 15;
    await fs.writeFile(vscodeConfig, `${JSON.stringify(during, null, 2)}\n`, "utf8");
    await writeDrafts(await adapter.buildRestore(baseline));

    const restored = parse(await fs.readFile(vscodeConfig, "utf8"));
    const env = Object.fromEntries(restored["claudeCode.environmentVariables"]
      .map((entry) => [entry.name, entry.value]));
    expect(env.KEEP_ME).toBe("yes");
    expect(env.RUNTIME_KEEP).toBe("added");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://before.example");
    expect(env.ANTHROPIC_API_KEY).toBe("before-api-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBe("before-model");
    expect(restored["claudeCode.disableLoginPrompt"]).toBe(false);
    expect(restored["editor.fontSize"]).toBe(15);
  });

  it("ignores newly managed VS Code fields when recovering an older gateway baseline", async () => {
    const vscodeConfig = path.join(root, "Code", "User", "settings.json");
    const profile = {
      ...baseProfile,
      baseUrl: "http://127.0.0.1:17863/claude",
      model: "gateway-model",
    };
    await seed(paths.claude.config, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: profile.baseUrl,
        ANTHROPIC_AUTH_TOKEN: "gateway-secret",
        ANTHROPIC_MODEL: profile.model,
      },
    }));
    await seed(vscodeConfig, JSON.stringify({
      "claudeCode.environmentVariables": [
        { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8090/anthropic" },
      ],
    }));
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, vscodeConfig },
    }).claude;
    const oldBaseline = {
      baseUrl: { present: false, value: null },
      apiKey: { present: false, value: null },
      authToken: { present: false, value: null },
      model: { present: false, value: null },
      toolSearch: { present: false, value: null },
    };

    expect(await adapter.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline: oldBaseline },
    )).toBe(GATEWAY_OWNERSHIP.OWNED);
    expect(await adapter.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      {
        gateway: true,
        baseline: {
          ...oldBaseline,
          vscodeEnvironmentVariables: { present: true, value: null },
          vscodeBaseUrl: { present: false, value: null },
        },
      },
    )).toBe(GATEWAY_OWNERSHIP.CONFLICT);

    const oldBaselineDrafts = await adapter.build(
      profile,
      "gateway-secret",
      { gateway: true, baseline: oldBaseline },
    );
    expect(oldBaselineDrafts.map((draft) => draft.path)).toEqual([paths.claude.config]);
  });

  it("reports a conflict while only VS Code still selects the Claude gateway", async () => {
    const vscodeConfig = path.join(root, "Code", "User", "settings.json");
    const profile = {
      ...baseProfile,
      baseUrl: "http://127.0.0.1:17863/claude",
      model: "gateway-model",
    };
    await seed(paths.claude.config, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://changed.example",
        ANTHROPIC_AUTH_TOKEN: "gateway-secret",
        ANTHROPIC_MODEL: profile.model,
      },
    }));
    await seed(vscodeConfig, JSON.stringify({
      "claudeCode.environmentVariables": [
        { name: "ANTHROPIC_BASE_URL", value: profile.baseUrl },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "gateway-secret" },
        { name: "ANTHROPIC_MODEL", value: profile.model },
      ],
      "claudeCode.disableLoginPrompt": true,
    }));
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, vscodeConfig },
    }).claude;

    expect(await adapter.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      {
        gateway: true,
        baseline: {
          vscodeEnvironmentVariables: { present: true, value: null },
        },
      },
    )).toBe(GATEWAY_OWNERSHIP.CONFLICT);
  });

  it("patches and restores the active Claude Desktop 3P profile", async () => {
    const desktopConfig = path.join(root, "Claude-3p", "configLibrary", "active.json");
    await seed(desktopConfig, `{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "https://login.example/cli/auth",
  "inferenceCredentialKind": "interactive",
  "inferenceGatewayOidc": { "issuer": "https://issuer.example" },
  "inferenceModels": ["before-model"],
  "keepMe": true
}\n`);
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, desktopConfig },
    }).claude;
    const baseline = await adapter.captureManagedState();
    const profile = {
      ...baseProfile,
      baseUrl: "http://127.0.0.1:17863/claude",
      model: "claude-sonnet-4-6",
    };

    await writeDrafts(await adapter.build(profile, "gateway-secret", {
      gateway: true,
      baseline,
    }));
    const configured = parse(await fs.readFile(desktopConfig, "utf8"));
    expect(configured.inferenceProvider).toBe("gateway");
    expect(configured.inferenceGatewayBaseUrl).toBe(profile.baseUrl);
    expect(configured.inferenceCredentialKind).toBe("static");
    expect(configured.inferenceGatewayApiKey).toBe("gateway-secret");
    expect(configured.inferenceGatewayAuthScheme).toBe("bearer");
    expect(configured.inferenceGatewayOidc).toBeUndefined();
    expect(configured.modelDiscoveryEnabled).toBe(true);
    expect(configured.inferenceModels).toEqual([profile.model]);
    expect(configured.disableDeploymentModeChooser).toBe(true);
    expect(configured.keepMe).toBe(true);
    expect(await adapter.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline },
    )).toBe(GATEWAY_OWNERSHIP.OWNED);

    configured.modelDiscoveryEnabled = false;
    await fs.writeFile(desktopConfig, `${JSON.stringify(configured, null, 2)}\n`, "utf8");
    expect(await adapter.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline },
    )).toBe(GATEWAY_OWNERSHIP.CONFLICT);
    expect(await adapter.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline, allowLegacyModelDiscovery: true },
    )).toBe(GATEWAY_OWNERSHIP.OWNED);

    configured.modelDiscoveryEnabled = true;
    configured.runtimeKeep = "added";
    await fs.writeFile(desktopConfig, `${JSON.stringify(configured, null, 2)}\n`, "utf8");
    await writeDrafts(await adapter.buildRestore(baseline));
    const restored = parse(await fs.readFile(desktopConfig, "utf8"));
    expect(restored.inferenceGatewayBaseUrl).toBe("https://login.example/cli/auth");
    expect(restored.inferenceCredentialKind).toBe("interactive");
    expect(restored.inferenceGatewayApiKey).toBeUndefined();
    expect(restored.inferenceGatewayOidc).toEqual({ issuer: "https://issuer.example" });
    expect(restored.inferenceModels).toEqual(["before-model"]);
    expect(restored.modelDiscoveryEnabled).toBeUndefined();
    expect(restored.disableDeploymentModeChooser).toBeUndefined();
    expect(restored.keepMe).toBe(true);
    expect(restored.runtimeKeep).toBe("added");

    const apiKeyDrafts = await adapter.build(
      { ...profile, authMode: "api-key", model: "" },
      "api-key-secret",
      { gateway: true, baseline },
    );
    const apiKeyDesktop = parse(apiKeyDrafts
      .find((draft) => draft.path === desktopConfig).content);
    expect(apiKeyDesktop.inferenceGatewayAuthScheme).toBe("x-api-key");
    expect(apiKeyDesktop.inferenceGatewayApiKey).toBe("api-key-secret");
    expect(apiKeyDesktop.inferenceModels).toEqual(["before-model"]);
    expect(apiKeyDesktop.modelDiscoveryEnabled).toBeUndefined();
  });

  it("inspects the active Claude Desktop profile when Claude Code has no endpoint", async () => {
    const desktopLibrary = path.join(root, "Claude-3p", "configLibrary");
    const desktopProfileId = "11111111-1111-4111-8111-111111111111";
    const desktopProfile = path.join(desktopLibrary, `${desktopProfileId}.json`);
    await seed(paths.claude.config, "{}\n");
    await seed(
      path.join(desktopLibrary, "_meta.json"),
      JSON.stringify({ appliedId: desktopProfileId }),
    );
    await seed(desktopProfile, JSON.stringify({
      inferenceGatewayBaseUrl: "https://desktop.example/anthropic",
      inferenceModels: [{ name: "claude-sonnet-4-6", supports1m: true }],
    }));
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, desktopLibrary },
    }).claude;
    const sources = new Map(await Promise.all(adapter.paths.map(async (filePath) => (
      [filePath, await fs.readFile(filePath, "utf8")]
    ))));

    expect(adapter.inspect(sources)).toEqual({
      baseUrl: "https://desktop.example/anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it.each([
    ["missing", null],
    ["malformed", "{ invalid metadata"],
  ])("ignores %s Claude Desktop metadata during capture and apply", async (_name, meta) => {
    const desktopLibrary = path.join(root, "Claude-3p", "configLibrary");
    const metaPath = path.join(desktopLibrary, "_meta.json");
    await seed(paths.claude.config, JSON.stringify({
      env: { KEEP_ME: "yes" },
    }));
    await fs.mkdir(desktopLibrary, { recursive: true });
    if (meta !== null) await seed(metaPath, meta);
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, desktopLibrary },
    }).claude;

    if (meta !== null) expect(() => adapter.validate(meta, metaPath)).not.toThrow();
    await expect(adapter.gatewayOwnership(baseProfile, "gateway-secret"))
      .resolves.toBe(GATEWAY_OWNERSHIP.RELEASED);
    const baseline = await adapter.captureManagedState();
    expect(baseline.desktopConfig).toBeUndefined();
    await expect(adapter.build(baseProfile, "gateway-secret", {
      gateway: true,
      baseline,
    })).resolves.toHaveLength(1);
  });

  it("ignores Claude Desktop when an older gateway baseline cannot restore it", async () => {
    const desktopConfig = path.join(root, "Claude-3p", "configLibrary", "active.json");
    await seed(desktopConfig, JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://before.example",
      inferenceCredentialKind: "interactive",
    }));
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, desktopConfig },
    }).claude;
    const oldBaseline = {
      baseUrl: { present: false, value: null },
      apiKey: { present: false, value: null },
      authToken: { present: false, value: null },
      model: { present: false, value: null },
      toolSearch: { present: false, value: null },
    };

    const drafts = await adapter.build(baseProfile, "gateway-secret", {
      gateway: true,
      baseline: oldBaseline,
    });
    expect(drafts.map((draft) => draft.path)).toEqual([paths.claude.config]);
  });

  it("does not parse invalid Claude Desktop metadata for an older gateway baseline", async () => {
    const desktopLibrary = path.join(root, "Claude-3p", "configLibrary");
    await seed(path.join(desktopLibrary, "_meta.json"), "{}\n");
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, desktopLibrary },
    }).claude;
    const oldBaseline = {
      baseUrl: { present: false, value: null },
      apiKey: { present: false, value: null },
      authToken: { present: false, value: null },
      model: { present: false, value: null },
      toolSearch: { present: false, value: null },
    };

    await expect(adapter.build(baseProfile, "gateway-secret", {
      gateway: true,
      baseline: oldBaseline,
    })).resolves.toHaveLength(1);
    await expect(adapter.buildRestore(oldBaseline)).resolves.toHaveLength(1);
  });

  it("keeps managing the captured Claude Desktop profile after appliedId changes", async () => {
    const desktopLibrary = path.join(root, "Claude-3p", "configLibrary");
    const desktopMeta = path.join(desktopLibrary, "_meta.json");
    const profileAId = "11111111-1111-4111-8111-111111111111";
    const profileBId = "22222222-2222-4222-8222-222222222222";
    const desktopProfileA = path.join(desktopLibrary, `${profileAId}.json`);
    const desktopProfileB = path.join(desktopLibrary, `${profileBId}.json`);
    const profile = {
      ...baseProfile,
      baseUrl: "http://127.0.0.1:17863/claude",
      model: "gateway-model",
    };
    const profileABefore = {
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://before.example",
      inferenceCredentialKind: "interactive",
      inferenceModels: ["profile-a-model"],
      profileMarker: "A",
    };
    const profileBGateway = `${JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: profile.baseUrl,
      inferenceCredentialKind: "static",
      inferenceGatewayApiKey: "other-secret",
      inferenceGatewayAuthScheme: "bearer",
      inferenceModels: ["profile-b-model"],
      profileMarker: "B",
    }, null, 2)}\n`;

    await seed(paths.claude.config, "{}\n");
    await seed(desktopMeta, JSON.stringify({ appliedId: profileAId }));
    await seed(desktopProfileA, `${JSON.stringify(profileABefore, null, 2)}\n`);
    await seed(desktopProfileB, profileBGateway);
    const adapter = createAdapters({
      ...paths,
      claude: {
        ...paths.claude,
        desktopConfig: desktopProfileA,
        desktopLibrary,
      },
    }).claude;
    const baseline = await adapter.captureManagedState();

    expect(baseline.desktopProfileId).toBe(profileAId);
    await seed(desktopMeta, JSON.stringify({ appliedId: profileBId }));

    const buildDrafts = await adapter.build(profile, "gateway-secret", {
      gateway: true,
      baseline,
    });
    expect(buildDrafts.map((draft) => draft.path)).toContain(desktopProfileA);
    expect(buildDrafts.map((draft) => draft.path)).not.toContain(desktopProfileB);
    await writeDrafts(buildDrafts);
    expect(parse(await fs.readFile(desktopProfileA, "utf8")).inferenceGatewayBaseUrl)
      .toBe(profile.baseUrl);
    expect(await fs.readFile(desktopProfileB, "utf8")).toBe(profileBGateway);
    expect(await adapter.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline },
    )).toBe(GATEWAY_OWNERSHIP.CONFLICT);

    const restoreDrafts = await adapter.buildRestore(baseline);
    expect(restoreDrafts.map((draft) => draft.path)).toContain(desktopProfileA);
    expect(restoreDrafts.map((draft) => draft.path)).not.toContain(desktopProfileB);
    await writeDrafts(restoreDrafts);
    expect(parse(await fs.readFile(desktopProfileA, "utf8"))).toEqual(profileABefore);
    expect(await fs.readFile(desktopProfileB, "utf8")).toBe(profileBGateway);
  });

  it("restores baseline models on an empty Claude profile and detects later model drift", async () => {
    const vscodeConfig = path.join(root, "Code", "User", "settings.json");
    const desktopConfig = path.join(root, "Claude-3p", "configLibrary", "active.json");
    await seed(paths.claude.config, JSON.stringify({
      env: { ANTHROPIC_MODEL: "native-before-model" },
    }));
    await seed(vscodeConfig, JSON.stringify({
      "claudeCode.environmentVariables": [
        { name: "ANTHROPIC_MODEL", value: "vscode-before-model" },
      ],
    }));
    await seed(desktopConfig, JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://before.example",
      inferenceCredentialKind: "interactive",
      modelDiscoveryEnabled: true,
      inferenceModels: [{ name: "desktop-before-model", supports1m: true }],
    }));
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, vscodeConfig, desktopConfig },
    }).claude;
    const baseline = await adapter.captureManagedState();
    const gatewayProfile = {
      ...baseProfile,
      baseUrl: "http://127.0.0.1:17863/claude",
      model: "gateway-model",
    };
    await writeDrafts(await adapter.build(gatewayProfile, "gateway-secret", {
      gateway: true,
      baseline,
    }));

    const emptyProfile = { ...gatewayProfile, model: "" };
    const emptyDrafts = await adapter.build(emptyProfile, "gateway-secret", {
      gateway: true,
      baseline,
    });
    await writeDrafts(emptyDrafts);

    const native = parse(await fs.readFile(paths.claude.config, "utf8"));
    expect(native.env.ANTHROPIC_MODEL).toBe("native-before-model");
    const vscode = parse(await fs.readFile(vscodeConfig, "utf8"));
    const vscodeEnvironment = Object.fromEntries(vscode["claudeCode.environmentVariables"]
      .map((entry) => [entry.name, entry.value]));
    expect(vscodeEnvironment.ANTHROPIC_MODEL).toBe("vscode-before-model");
    const desktop = parse(await fs.readFile(desktopConfig, "utf8"));
    expect(desktop.modelDiscoveryEnabled).toBe(true);
    expect(desktop.inferenceModels)
      .toEqual([{ name: "desktop-before-model", supports1m: true }]);
    expect(await adapter.gatewayOwnership(
      emptyProfile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline },
    )).toBe(GATEWAY_OWNERSHIP.OWNED);

    native.env.ANTHROPIC_MODEL = "native-runtime-model";
    await seed(paths.claude.config, `${JSON.stringify(native, null, 2)}\n`);
    expect(await adapter.gatewayOwnership(
      emptyProfile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline },
    )).toBe(GATEWAY_OWNERSHIP.CONFLICT);

    await writeDrafts(emptyDrafts);
    const changedVsCode = parse(await fs.readFile(vscodeConfig, "utf8"));
    changedVsCode["claudeCode.environmentVariables"]
      .find((entry) => entry.name === "ANTHROPIC_MODEL").value = "vscode-runtime-model";
    await seed(vscodeConfig, `${JSON.stringify(changedVsCode, null, 2)}\n`);
    expect(await adapter.gatewayOwnership(
      emptyProfile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline },
    )).toBe(GATEWAY_OWNERSHIP.CONFLICT);

    await writeDrafts(emptyDrafts);
    const changedDesktop = parse(await fs.readFile(desktopConfig, "utf8"));
    changedDesktop.inferenceModels = ["desktop-runtime-model"];
    await seed(desktopConfig, `${JSON.stringify(changedDesktop, null, 2)}\n`);
    expect(await adapter.gatewayOwnership(
      emptyProfile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline },
    )).toBe(GATEWAY_OWNERSHIP.CONFLICT);
  });

  it("treats Claude Desktop string and named-object models as equivalent ownership", async () => {
    const desktopConfig = path.join(root, "Claude-3p", "configLibrary", "active.json");
    await seed(paths.claude.config, "{}\n");
    await seed(desktopConfig, JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://before.example",
      inferenceCredentialKind: "interactive",
    }));
    const adapter = createAdapters({
      ...paths,
      claude: { ...paths.claude, desktopConfig },
    }).claude;
    const baseline = await adapter.captureManagedState();
    const profile = {
      ...baseProfile,
      baseUrl: "http://127.0.0.1:17863/claude",
      model: "claude-sonnet-4-6",
    };
    await writeDrafts(await adapter.build(profile, "gateway-secret", {
      gateway: true,
      baseline,
    }));

    expect(await adapter.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline },
    )).toBe(GATEWAY_OWNERSHIP.OWNED);

    const desktop = parse(await fs.readFile(desktopConfig, "utf8"));
    desktop.inferenceModels = [{ name: profile.model }];
    await seed(desktopConfig, `${JSON.stringify(desktop, null, 2)}\n`);
    expect(await adapter.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      { gateway: true, baseline },
    )).toBe(GATEWAY_OWNERSHIP.OWNED);
  });

  it("surgically replaces the managed Codex provider and preserves MCP config", async () => {
    const original = `# 保留顶层注释
model_provider = "old"
model = "old-model"
approval_policy = "on-request"

[model_providers.agentgate]
name = "Old managed"
base_url = "https://old.example/v1"
experimental_bearer_token = "old-secret"

[model_providers.agentgate.http_headers]
X_OLD = "remove-me"

[model_providers.other]
name = "Other provider"
base_url = "https://other.example/v1"

[mcp_servers.browser]
command = "node"
args = ["server.js"]
`;
    await seed(paths.codex.config, original);

    const [draft] = await adapters.codex.build(
      {
        ...baseProfile,
        protocol: "openai-responses",
        baseUrl: "https://new.example/v1",
        model: "gpt-5.2-codex",
        targets: ["codex"],
      },
      "sk-codex-secret",
    );
    const parsed = TOML.parse(draft.content);

    expect(draft.content).toContain("# 保留顶层注释");
    expect(draft.content).not.toContain("old-secret");
    expect(draft.content).not.toContain("X_OLD");
    expect(parsed.approval_policy).toBe("on-request");
    expect(parsed.mcp_servers.browser.command).toBe("node");
    expect(parsed.model_providers.other.base_url).toBe("https://other.example/v1");
    expect(parsed.model_provider).toBe("agentgate");
    expect(parsed.model).toBe("gpt-5.2-codex");
    expect(parsed.model_providers.agentgate.base_url).toBe("https://new.example/v1");
    expect(parsed.model_providers.agentgate.wire_api).toBe("responses");
    expect(parsed.model_providers.agentgate.experimental_bearer_token).toBe("sk-codex-secret");
  });

  it("恢复 Codex 官方模式时只移除 Agent;Gate provider 和顶层选择", async () => {
    const original = [
      "# 用户的 Codex 配置",
      'model_provider = "agentgate"',
      'model = "gpt-user-selected"',
      'approval_policy = "on-request"',
      "",
      "[model_providers.agentgate]",
      'base_url = "https://agentgate.example/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.agentgate.http_headers]",
      'X_AGENTGATE = "remove"',
      "",
      "[model_providers.agentgate_gateway]",
      'base_url = "http://127.0.0.1:17863/codex/token"',
      'wire_api = "responses"',
      "",
      "[model_providers.keydeck]",
      'base_url = "https://legacy.example/v1"',
      "",
      "[model_providers.keydeck_gateway]",
      'base_url = "http://127.0.0.1:17863/codex/legacy"',
      "",
      "[model_providers.custom]",
      'name = "用户自建"',
      'base_url = "https://custom.example/v1"',
      'wire_api = "responses"',
      "",
      "[mcp_servers.browser]",
      'command = "node"',
      'args = ["服务.js"]',
      "",
    ].join("\r\n");
    await seed(paths.codex.config, original);

    const [draft] = await adapters.codex.buildOfficialRestore();
    const parsed = TOML.parse(draft.content);

    expect(draft.content).toContain("# 用户的 Codex 配置\r\n");
    expect(draft.content).not.toMatch(/(^|[^\r])\n/);
    expect(parsed.model_provider).toBeUndefined();
    expect(parsed.model).toBe("gpt-user-selected");
    expect(parsed.approval_policy).toBe("on-request");
    expect(parsed.model_providers?.agentgate).toBeUndefined();
    expect(parsed.model_providers?.agentgate_gateway).toBeUndefined();
    expect(parsed.model_providers?.keydeck).toBeUndefined();
    expect(parsed.model_providers?.keydeck_gateway).toBeUndefined();
    expect(parsed.model_providers.custom).toEqual({
      name: "用户自建",
      base_url: "https://custom.example/v1",
      wire_api: "responses",
    });
    expect(parsed.mcp_servers.browser).toEqual({ command: "node", args: ["服务.js"] });
  });

  it("Codex 网关只改活跃 provider 的 base_url", async () => {
    const original = [
      "# 用户的 Codex 配置",
      'model_provider = "agentgate"',
      'model = "direct-model"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "",
      "[features]",
      "web_search_request = true",
      "",
      "[projects.'D:\\工作区\\中文项目']",
      'trust_level = "trusted"',
      "",
      "[model_providers.agentgate]",
      'name = "Agent;Gate - 直连方案"',
      'base_url = "https://direct.example/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      'experimental_bearer_token = "direct-secret"',
      "",
      "[model_providers.unknown]",
      'name = "未知供应商"',
      'base_url = "https://unknown.example/v1"',
      "",
      "[mcp_servers.browser]",
      'command = "node"',
      'args = ["服务.js"]',
      "",
    ].join("\r\n");
    await seed(paths.codex.config, original);

    const [draft] = await adapters.codex.build(
      {
        ...baseProfile,
        name: "不应写入显示名",
        protocol: "openai-responses",
        baseUrl: "http://127.0.0.1:19431/codex/persistent-route-token",
        model: "gpt-5.2-codex",
        targets: ["codex"],
      },
      "gateway-secret",
      { gateway: true },
    );
    const parsed = TOML.parse(draft.content);

    expect(draft.content).toContain("# 用户的 Codex 配置\r\n");
    expect(draft.content).not.toMatch(/(^|[^\r])\n/);
    expect(parsed.approval_policy).toBe("on-request");
    expect(parsed.sandbox_mode).toBe("workspace-write");
    expect(parsed.features.web_search_request).toBe(true);
    expect(parsed.projects["D:\\工作区\\中文项目"].trust_level).toBe("trusted");
    expect(parsed.mcp_servers.browser.args).toEqual(["服务.js"]);
    expect(parsed.model_provider).toBe("agentgate");
    expect(parsed.model).toBe("direct-model");
    expect(parsed.model_providers.agentgate).toEqual({
      name: "Agent;Gate - 直连方案",
      base_url: "http://127.0.0.1:19431/codex/persistent-route-token",
      wire_api: "responses",
      requires_openai_auth: false,
      experimental_bearer_token: "direct-secret",
    });
    expect(parsed.model_providers.unknown).toEqual({
      name: "未知供应商",
      base_url: "https://unknown.example/v1",
    });
    expect(parsed.model_providers.agentgate_gateway).toBeUndefined();
    expect(draft.content).not.toContain("gateway-secret");
  });

  it("recognizes Codex gateway ownership without treating unrelated settings as drift", async () => {
    const profile = {
      ...baseProfile,
      protocol: "openai-responses",
      baseUrl: "http://127.0.0.1:19431/codex/persistent-route-token",
      model: "gpt-5.2-codex",
      targets: ["codex"],
    };
    await seed(paths.codex.config, `model_provider = "custom"
model = "user-model"
approval_policy = "on-request"

[model_providers.custom]
name = "Custom"
base_url = "https://upstream.example/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "user-secret"

[mcp_servers.demo]
command = "node"
`);

    const baseline = await adapters.codex.captureManagedState();
    const [draft] = await adapters.codex.build(profile, "gateway-secret", { gateway: true });
    await fs.writeFile(paths.codex.config, draft.content, "utf8");
    expect(await adapters.codex.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      { baseline },
    ))
      .toBe(GATEWAY_OWNERSHIP.OWNED);

    await fs.appendFile(paths.codex.config, `
[projects.'D:\\Work']
trust_level = "trusted"
`, "utf8");
    expect(await adapters.codex.gatewayOwnership(profile, "gateway-secret", undefined, { baseline }))
      .toBe(GATEWAY_OWNERSHIP.OWNED);

    const extendedGateway = (await fs.readFile(paths.codex.config, "utf8"))
      .replace(
        'experimental_bearer_token = "user-secret"',
        'experimental_bearer_token = "changed-user-secret"\nrequest_max_retries = 7',
      );
    await fs.writeFile(paths.codex.config, extendedGateway, "utf8");
    expect(await adapters.codex.gatewayOwnership(profile, "gateway-secret", undefined, { baseline }))
      .toBe(GATEWAY_OWNERSHIP.OWNED);

    for (const userEdit of [
      extendedGateway.replace('model = "gpt-5.2-codex"', 'model = "runtime-selected-model"'),
      extendedGateway.replace(
        'experimental_bearer_token = "changed-user-secret"',
        'experimental_bearer_token = "another-user-secret"',
      ),
      extendedGateway.replace('wire_api = "responses"', 'wire_api = "chat"'),
    ]) {
      await fs.writeFile(paths.codex.config, userEdit, "utf8");
      expect(await adapters.codex.gatewayOwnership(
        profile,
        "gateway-secret",
        undefined,
        { baseline },
      )).toBe(GATEWAY_OWNERSHIP.OWNED);
    }

    const changedRoute = extendedGateway.replace(
      "persistent-route-token",
      "different-route-token",
    );
    await fs.writeFile(paths.codex.config, changedRoute, "utf8");
    expect(await adapters.codex.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      { baseline },
    )).toBe(GATEWAY_OWNERSHIP.CONFLICT);

    const movedEndpoint = extendedGateway.replace(
      'base_url = "http://127.0.0.1:19431/codex/persistent-route-token"',
      'base_url = "https://user.example/v1"',
    );
    await fs.writeFile(paths.codex.config, movedEndpoint, "utf8");
    expect(await adapters.codex.gatewayOwnership(
      profile,
      "gateway-secret",
      undefined,
      { baseline },
    ))
      .toBe(GATEWAY_OWNERSHIP.RELEASED);
  });

  it("Codex 恢复只还原首次接管 provider 的 base_url", async () => {
    const original = `model_provider = "vendor.with.dot"
model = "original-model"

[model_providers."vendor.with.dot"]
name = "Vendor"
base_url = "https://vendor.example/v1" # 保留行尾注释
wire_api = "responses"
experimental_bearer_token = "original-auth"

[model_providers.other]
name = "Other"
base_url = "https://other.example/v1"
wire_api = "chat"
`;
    await seed(paths.codex.config, original);
    const baseline = await adapters.codex.captureManagedState();
    const profile = {
      ...baseProfile,
      protocol: "openai-responses",
      baseUrl: "http://127.0.0.1:19431/codex/persistent-route-token",
      model: "ignored-profile-model",
      targets: ["codex"],
    };

    const [takeover] = await adapters.codex.build(
      profile,
      "ignored-local-key",
      { gateway: true, baseline },
    );
    const duringGateway = takeover.content
      .replace('model_provider = "vendor.with.dot"', 'model_provider = "other"')
      .replace('model = "original-model"', 'model = "runtime-model"')
      .replace('wire_api = "responses"', 'wire_api = "chat"')
      .replace('experimental_bearer_token = "original-auth"', 'experimental_bearer_token = "runtime-auth"');
    await fs.writeFile(paths.codex.config, duringGateway, "utf8");

    const [restore] = await adapters.codex.buildRestore(baseline);
    const restored = TOML.parse(restore.content);
    expect(restored.model_provider).toBe("other");
    expect(restored.model).toBe("runtime-model");
    expect(restored.model_providers["vendor.with.dot"].base_url)
      .toBe("https://vendor.example/v1");
    expect(restored.model_providers["vendor.with.dot"].wire_api).toBe("chat");
    expect(restored.model_providers["vendor.with.dot"].experimental_bearer_token)
      .toBe("runtime-auth");
    expect(restore.content).toContain("# 保留行尾注释");
    expect(await adapters.codex.verifyManagedState(
      baseline,
      new Map([[paths.codex.config, restore.content]]),
    )).toBe(true);
  });

  it("classifies owned, released, and conflicting gateway state for every client", async () => {
    const cases = [
      {
        target: "claude",
        profile: {
          ...baseProfile,
          baseUrl: "http://127.0.0.1:19431/claude",
          model: "claude-old",
        },
        async extendUnknown() {
          const source = await fs.readFile(paths.claude.config, "utf8");
          await fs.writeFile(
            paths.claude.config,
            source.replace('"env": {', '"env": {\n    "USER_EXTENSION": "keep",'),
            "utf8",
          );
        },
        async conflict() {
          const source = await fs.readFile(paths.claude.config, "utf8");
          await fs.writeFile(paths.claude.config, source.replace("gateway-secret", "changed"), "utf8");
        },
        async release() {
          const source = await fs.readFile(paths.claude.config, "utf8");
          await fs.writeFile(paths.claude.config, source.replace(
            "http://127.0.0.1:19431/claude",
            "https://user.example/claude",
          ), "utf8");
        },
      },
      {
        target: "opencode",
        profile: {
          ...baseProfile,
          protocol: "openai-responses",
          baseUrl: "http://127.0.0.1:19431/opencode",
          model: "gpt-old",
          targets: ["opencode"],
        },
        async extendUnknown() {
          const source = await fs.readFile(paths.opencode.config, "utf8");
          await fs.writeFile(
            paths.opencode.config,
            source.replace('"options": {', '"customField": true,\n      "options": {'),
            "utf8",
          );
        },
        async conflict() {
          const source = await fs.readFile(paths.opencode.auth, "utf8");
          await fs.writeFile(paths.opencode.auth, source.replace("gateway-secret", "changed"), "utf8");
        },
        async release() {
          const source = await fs.readFile(paths.opencode.config, "utf8");
          await fs.writeFile(
            paths.opencode.config,
            source.replace("agentgate_gateway/gpt-old", "other/gpt-old"),
            "utf8",
          );
        },
      },
      {
        target: "gemini",
        profile: {
          ...baseProfile,
          protocol: "gemini",
          baseUrl: "http://127.0.0.1:19431/gemini",
          model: "gemini-old",
          authMode: "api-key",
          targets: ["gemini"],
        },
        async extendUnknown() {
          const source = await fs.readFile(paths.gemini.env, "utf8");
          await fs.writeFile(
            paths.gemini.env,
            `${source}USER_EXTENSION="keep"\n`,
            "utf8",
          );
        },
        async conflict() {
          const source = await fs.readFile(paths.gemini.env, "utf8");
          await fs.writeFile(paths.gemini.env, source.replace("gateway-secret", "changed"), "utf8");
        },
        async release() {
          const source = await fs.readFile(paths.gemini.config, "utf8");
          await fs.writeFile(paths.gemini.config, source.replace("gemini-api-key", "oauth-personal"), "utf8");
        },
      },
    ];

    for (const item of cases) {
      const drafts = await adapters[item.target].build(
        item.profile,
        "gateway-secret",
        { gateway: true },
      );
      await Promise.all(drafts.map((itemDraft) => seed(itemDraft.path, itemDraft.content)));
      await item.extendUnknown();
      expect(await adapters[item.target].gatewayOwnership(item.profile, "gateway-secret"))
        .toBe(GATEWAY_OWNERSHIP.OWNED);

      await item.conflict();
      expect(await adapters[item.target].gatewayOwnership(item.profile, "gateway-secret"))
        .toBe(GATEWAY_OWNERSHIP.CONFLICT);

      await item.release();
      expect(await adapters[item.target].gatewayOwnership(item.profile, "gateway-secret"))
        .toBe(GATEWAY_OWNERSHIP.RELEASED);
    }
  });

  it("writes an additive OpenCode provider and preserves unrelated auth", async () => {
    await seed(paths.opencode.config, `{
  // 保留已有插件
  "plugin": ["oh-my-opencode"],
  "provider": { "other": { "npm": "@ai-sdk/anthropic" } }
}\n`);
    await seed(paths.opencode.auth, `{
  "other": { "type": "oauth", "refresh": "keep-me" }
}\n`);

    const drafts = await adapters.opencode.build(
      {
        ...baseProfile,
        protocol: "openai-responses",
        baseUrl: "https://responses.example/v1",
        model: "gpt-5.2",
        targets: ["opencode"],
      },
      "sk-opencode-secret",
    );
    const config = parse(drafts.find((draft) => draft.path === paths.opencode.config).content);
    const auth = parse(drafts.find((draft) => draft.path === paths.opencode.auth).content);

    expect(drafts[0].content).toContain("// 保留已有插件");
    expect(config.plugin).toEqual(["oh-my-opencode"]);
    expect(config.provider.other).toBeDefined();
    expect(config.provider.agentgate.npm).toBe("@ai-sdk/openai");
    expect(config.provider.agentgate.options.baseURL).toBe("https://responses.example/v1");
    expect(config.model).toBe("agentgate/gpt-5.2");
    expect(auth.other.refresh).toBe("keep-me");
    expect(auth.agentgate).toEqual({ type: "api", key: "sk-opencode-secret" });
  });

  it("writes OpenCode gateway state without replacing the direct provider", async () => {
    await seed(paths.opencode.config, `{
  "provider": {
    "agentgate": {
      "name": "Agent;Gate - Direct",
      "options": { "baseURL": "https://direct.example/v1" }
    }
  },
  "model": "agentgate/direct-model"
}\n`);
    await seed(paths.opencode.auth, `{
  "agentgate": { "type": "api", "key": "direct-secret" }
}\n`);

    const drafts = await adapters.opencode.build(
      {
        ...baseProfile,
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:19431/v1",
        model: "gateway-model",
        targets: ["opencode"],
      },
      "gateway-secret",
      { gateway: true },
    );
    const config = parse(drafts.find((draft) => draft.path === paths.opencode.config).content);
    const auth = parse(drafts.find((draft) => draft.path === paths.opencode.auth).content);

    expect(config.provider.agentgate.options.baseURL).toBe("https://direct.example/v1");
    expect(config.provider.agentgate_gateway.name).toBe("Agent;Gate Local Gateway");
    expect(config.provider.agentgate_gateway.options.baseURL).toBe("http://127.0.0.1:19431/v1");
    expect(config.model).toBe("agentgate_gateway/gateway-model");
    expect(auth.agentgate).toEqual({ type: "api", key: "direct-secret" });
    expect(auth.agentgate_gateway).toEqual({ type: "api", key: "gateway-secret" });
  });

  it("patches Gemini env without dropping comments or unrelated settings", async () => {
    await seed(paths.gemini.env, `# 保留注释
OTHER_VALUE=1
GEMINI_API_KEY=old-one
GEMINI_API_KEY=old-two
`);
    await seed(paths.gemini.config, `{
  "mcpServers": { "demo": { "command": "node" } }
}\n`);

    const drafts = await adapters.gemini.build(
      {
        ...baseProfile,
        protocol: "gemini",
        baseUrl: "https://gemini-relay.example",
        model: "gemini-2.5-flash",
        targets: ["gemini"],
      },
      "gemini-secret",
    );
    const envContent = drafts.find((draft) => draft.path === paths.gemini.env).content;
    const settings = parse(drafts.find((draft) => draft.path === paths.gemini.config).content);

    expect(envContent).toContain("# 保留注释");
    expect(envContent).toContain("OTHER_VALUE=1");
    expect(envContent.match(/^GEMINI_API_KEY=/gm)).toHaveLength(1);
    expect(envContent).toContain('GEMINI_API_KEY="gemini-secret"');
    expect(envContent).toContain('GOOGLE_GEMINI_BASE_URL="https://gemini-relay.example"');
    expect(settings.mcpServers.demo.command).toBe("node");
    expect(settings.security.auth.selectedType).toBe("gemini-api-key");
  });

  it("restores existing managed fields while preserving runtime configuration additions", async () => {
    await seed(paths.claude.config, `{
  "env": {
    "ANTHROPIC_BASE_URL": "https://claude.before",
    "ANTHROPIC_API_KEY": "claude-before-secret",
    "ANTHROPIC_AUTH_TOKEN": null,
    "ANTHROPIC_MODEL": "claude-before",
    "ENABLE_TOOL_SEARCH": "false"
  },
  "permissions": { "allow": ["Read"] }
}\n`);
    await seed(paths.codex.config, `model_provider = "custom-before"
model = "codex-before"
approval_policy = "on-request"

[model_providers.custom-before]
name = "Existing gateway"
base_url = "https://codex.before/v1"
wire_api = "chat"
requires_openai_auth = false
experimental_bearer_token = "codex-before-secret"

[mcp_servers.before]
command = "before"
`);
    await seed(paths.opencode.config, `{
  "model": "agentgate_gateway/opencode-before",
  "provider": {
    "agentgate_gateway": {
      "name": "Existing gateway",
      "options": { "baseURL": "https://opencode.before/v1" }
    },
    "other": { "keep": true }
  }
}\n`);
    await seed(paths.opencode.auth, `{
  "agentgate_gateway": { "type": "api", "key": "opencode-before-secret" },
  "other": { "type": "oauth", "refresh": "keep" }
}\n`);
    await seed(paths.gemini.env, `GEMINI_API_KEY="gemini-before-secret"
GOOGLE_GEMINI_BASE_URL="https://gemini.before"
GEMINI_MODEL="gemini-before"
`);
    await seed(paths.gemini.config, `{
  "security": { "auth": { "selectedType": null } },
  "mcpServers": { "before": { "command": "before" } }
}\n`);

    const baselines = Object.fromEntries(await Promise.all(
      Object.entries(adapters).map(async ([target, adapter]) => (
        [target, JSON.parse(JSON.stringify(await adapter.captureManagedState()))]
      )),
    ));
    expect(baselines.claude.authToken).toEqual({ present: true, value: null });
    expect(baselines.gemini.selectedType).toEqual({ present: true, value: null });

    const gatewayProfiles = {
      claude: {
        ...baseProfile,
        baseUrl: "http://127.0.0.1:17863/claude",
        model: "claude-gateway",
      },
      codex: {
        ...baseProfile,
        protocol: "openai-responses",
        baseUrl: "http://127.0.0.1:17863/codex",
        model: "codex-gateway",
        targets: ["codex"],
      },
      opencode: {
        ...baseProfile,
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:17863/opencode",
        model: "opencode-gateway",
        targets: ["opencode"],
      },
      gemini: {
        ...baseProfile,
        protocol: "gemini",
        baseUrl: "http://127.0.0.1:17863/gemini",
        model: "gemini-gateway",
        authMode: "api-key",
        targets: ["gemini"],
      },
    };
    for (const [target, profile] of Object.entries(gatewayProfiles)) {
      await writeDrafts(await adapters[target].build(profile, "runtime-gateway-secret", {
        gateway: true,
      }));
    }

    await fs.appendFile(paths.codex.config, `
[projects.'D:\\Runtime']
trust_level = "trusted"
`, "utf8");
    await fs.appendFile(paths.gemini.env, "RUNTIME_GEMINI=keep\n", "utf8");
    await fs.writeFile(
      paths.claude.config,
      (await fs.readFile(paths.claude.config, "utf8")).replace(
        '"permissions":', '"runtimeAdded": { "keep": true },\n  "permissions":',
      ),
      "utf8",
    );
    await fs.writeFile(
      paths.opencode.config,
      (await fs.readFile(paths.opencode.config, "utf8")).replace(
        '"provider":', '"runtimeAdded": { "keep": true },\n  "provider":',
      ),
      "utf8",
    );
    await fs.writeFile(
      paths.gemini.config,
      (await fs.readFile(paths.gemini.config, "utf8")).replace(
        '"security":', '"runtimeAdded": { "keep": true },\n  "security":',
      ),
      "utf8",
    );

    for (const [target, baseline] of Object.entries(baselines)) {
      await writeDrafts(await adapters[target].buildRestore(baseline));
    }

    const claude = parse(await fs.readFile(paths.claude.config, "utf8"));
    expect(claude.env.ANTHROPIC_BASE_URL).toBe("https://claude.before");
    expect(claude.env.ANTHROPIC_API_KEY).toBe("claude-before-secret");
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBeNull();
    expect(claude.runtimeAdded.keep).toBe(true);

    const codex = TOML.parse(await fs.readFile(paths.codex.config, "utf8"));
    expect(codex.model_provider).toBe("custom-before");
    expect(codex.model).toBe("codex-before");
    expect(codex.model_providers["custom-before"].experimental_bearer_token)
      .toBe("codex-before-secret");
    expect(codex.mcp_servers.before.command).toBe("before");
    expect(codex.projects["D:\\Runtime"].trust_level).toBe("trusted");

    const openCode = parse(await fs.readFile(paths.opencode.config, "utf8"));
    const openCodeAuth = parse(await fs.readFile(paths.opencode.auth, "utf8"));
    expect(openCode.model).toBe("agentgate_gateway/opencode-before");
    expect(openCode.provider.agentgate_gateway.options.baseURL).toBe("https://opencode.before/v1");
    expect(openCode.runtimeAdded.keep).toBe(true);
    expect(openCodeAuth.agentgate_gateway.key).toBe("opencode-before-secret");
    expect(openCodeAuth.other.refresh).toBe("keep");

    const geminiEnv = await fs.readFile(paths.gemini.env, "utf8");
    const gemini = parse(await fs.readFile(paths.gemini.config, "utf8"));
    expect(geminiEnv).toContain('GEMINI_API_KEY="gemini-before-secret"');
    expect(geminiEnv).toContain('GOOGLE_GEMINI_BASE_URL="https://gemini.before"');
    expect(geminiEnv).toContain("RUNTIME_GEMINI=keep");
    expect(gemini.security.auth.selectedType).toBeNull();
    expect(gemini.runtimeAdded.keep).toBe(true);
  });

  it("removes gateway-managed fields that were absent before takeover", async () => {
    await seed(paths.claude.config, `{
  "env": { "KEEP": "claude" },
  "runtime": true
}\n`);
    await seed(paths.codex.config, `model_provider = "other"
approval_policy = "never"

[model_providers.other]
wire_api = "responses"
`);
    await seed(paths.opencode.config, `{
  "provider": { "other": { "keep": true } },
  "plugin": ["keep"]
}\n`);
    await seed(paths.opencode.auth, `{ "other": { "key": "keep" } }\n`);
    await seed(paths.gemini.env, "KEEP_GEMINI=1\n");
    await seed(paths.gemini.config, `{ "mcpServers": { "keep": {} } }\n`);

    const baselines = Object.fromEntries(await Promise.all(
      Object.entries(adapters).map(async ([target, adapter]) => (
        [target, await adapter.captureManagedState()]
      )),
    ));
    for (const [target, baseline] of Object.entries(baselines)) {
      if (target === "codex") {
        expect(baseline).toMatchObject({
          providerId: "other",
          wireApi: "responses",
          baseUrl: { present: false, value: null },
        });
        continue;
      }
      if (target === "opencode") {
        expect(baseline.providerId).toBe("agentgate_gateway");
      }
      for (const [key, state] of Object.entries(baseline)) {
        if (key === "providerId") continue;
        expect(state.present).toBe(false);
      }
    }

    const profiles = {
      claude: { ...baseProfile, baseUrl: "http://127.0.0.1:17863/claude" },
      codex: {
        ...baseProfile,
        protocol: "openai-responses",
        baseUrl: "http://127.0.0.1:17863/codex",
        model: "codex-gateway",
        targets: ["codex"],
      },
      opencode: {
        ...baseProfile,
        protocol: "openai-responses",
        baseUrl: "http://127.0.0.1:17863/opencode",
        model: "opencode-gateway",
        targets: ["opencode"],
      },
      gemini: {
        ...baseProfile,
        protocol: "gemini",
        baseUrl: "http://127.0.0.1:17863/gemini",
        model: "gemini-gateway",
        authMode: "api-key",
        targets: ["gemini"],
      },
    };
    for (const [target, profile] of Object.entries(profiles)) {
      await writeDrafts(await adapters[target].build(profile, "runtime-secret", { gateway: true }));
      await writeDrafts(await adapters[target].buildRestore(baselines[target]));
    }

    const claude = parse(await fs.readFile(paths.claude.config, "utf8"));
    expect(claude.env).toEqual({ KEEP: "claude" });
    expect(claude.runtime).toBe(true);

    const codex = TOML.parse(await fs.readFile(paths.codex.config, "utf8"));
    expect(codex.model_provider).toBe("other");
    expect(codex.model).toBeUndefined();
    expect(codex.model_providers.agentgate_gateway).toBeUndefined();
    expect(codex.model_providers.other.base_url).toBeUndefined();
    expect(codex.model_providers.other.wire_api).toBe("responses");
    expect(codex.approval_policy).toBe("never");

    const openCode = parse(await fs.readFile(paths.opencode.config, "utf8"));
    const openCodeAuth = parse(await fs.readFile(paths.opencode.auth, "utf8"));
    expect(openCode.model).toBeUndefined();
    expect(openCode.provider.agentgate_gateway).toBeUndefined();
    expect(openCode.provider.other.keep).toBe(true);
    expect(openCode.plugin).toEqual(["keep"]);
    expect(openCodeAuth.agentgate_gateway).toBeUndefined();
    expect(openCodeAuth.other.key).toBe("keep");

    const geminiEnv = await fs.readFile(paths.gemini.env, "utf8");
    const gemini = parse(await fs.readFile(paths.gemini.config, "utf8"));
    expect(geminiEnv).toBe("KEEP_GEMINI=1\n");
    expect(gemini.security?.auth?.selectedType).toBeUndefined();
    expect(gemini.mcpServers.keep).toEqual({});
  });

  it("does not write captured secrets to adapter logs", async () => {
    await seed(paths.opencode.auth, `{
  "agentgate_gateway": { "type": "api", "key": "baseline-must-not-be-logged" }
}\n`);
    const spies = ["log", "info", "warn", "error"].map((method) => (
      vi.spyOn(console, method).mockImplementation(() => {})
    ));

    const baseline = await adapters.opencode.captureManagedState();
    await adapters.opencode.buildRestore(baseline);

    const output = spies.flatMap((spy) => spy.mock.calls.flat()).join(" ");
    expect(output).not.toContain("baseline-must-not-be-logged");
    spies.forEach((spy) => spy.mockRestore());
  });

  it("honors config root overrides and prefers OpenCode JSONC", async () => {
    const configRoot = path.join(root, "xdg-config");
    const appData = path.join(root, "app-data");
    const localAppData = path.join(root, "local-app-data");
    const desktopProfileId = "1c10ccd0-49ef-493d-8126-53e097457adf";
    const openCodeDir = path.join(configRoot, "opencode");
    await seed(path.join(openCodeDir, "opencode.json"), "{}\n");
    await seed(path.join(openCodeDir, "opencode.jsonc"), "{}\n");
    await seed(path.join(appData, "Code", "User", "settings.json"), "{}\n");
    await seed(
      path.join(localAppData, "Claude-3p", "configLibrary", "_meta.json"),
      JSON.stringify({ appliedId: desktopProfileId }),
    );
    await seed(
      path.join(localAppData, "Claude-3p", "configLibrary", `${desktopProfileId}.json`),
      "{}\n",
    );

    const resolved = resolveClientPaths(
      {
        CLAUDE_CONFIG_DIR: path.join(root, "claude-custom"),
        CODEX_HOME: path.join(root, "codex-custom"),
        GEMINI_CLI_HOME: path.join(root, "gemini-custom"),
        XDG_CONFIG_HOME: configRoot,
        XDG_DATA_HOME: path.join(root, "xdg-data"),
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
      },
      root,
    );

    expect(resolved.claude.config).toBe(path.join(root, "claude-custom", "settings.json"));
    expect(resolved.claude.vscodeConfig)
      .toBe(path.join(appData, "Code", "User", "settings.json"));
    expect(resolved.claude.desktopConfig).toBe(path.join(
      localAppData,
      "Claude-3p",
      "configLibrary",
      `${desktopProfileId}.json`,
    ));
    expect(resolved.claude.desktopLibrary)
      .toBe(path.join(localAppData, "Claude-3p", "configLibrary"));
    expect(resolved.codex.config).toBe(path.join(root, "codex-custom", "config.toml"));
    expect(resolved.gemini.env).toBe(path.join(root, "gemini-custom", ".env"));
    expect(resolved.opencode.config).toBe(path.join(openCodeDir, "opencode.jsonc"));
    expect(resolved.opencode.auth).toBe(path.join(root, "xdg-data", "opencode", "auth.json"));
  });

  it("ignores an unsafe Claude Desktop applied profile id", async () => {
    const localAppData = path.join(root, "local-app-data");
    const desktopLibrary = path.join(localAppData, "Claude-3p", "configLibrary");
    await seed(
      path.join(desktopLibrary, "_meta.json"),
      JSON.stringify({ appliedId: "..\\..\\settings" }),
    );

    const resolved = resolveClientPaths({ LOCALAPPDATA: localAppData }, root);

    expect(resolved.claude.desktopConfig).toBeUndefined();
    expect(resolved.claude.desktopLibrary).toBe(desktopLibrary);
  });

  it.each([
    ["missing", null],
    ["malformed", "{ invalid metadata"],
  ])("keeps the Claude Desktop library when metadata is %s", async (_name, meta) => {
    const localAppData = path.join(root, "local-app-data");
    const desktopLibrary = path.join(localAppData, "Claude-3p", "configLibrary");
    await fs.mkdir(desktopLibrary, { recursive: true });
    if (meta !== null) {
      await seed(path.join(desktopLibrary, "_meta.json"), meta);
    }

    const resolved = resolveClientPaths({ LOCALAPPDATA: localAppData }, root);

    expect(resolved.claude.desktopConfig).toBeUndefined();
    expect(resolved.claude.desktopLibrary).toBe(desktopLibrary);
  });
});

describe("旧版兼容", () => {
  it("识别 0.8.0 及更早版本写入的 OpenCode provider", async () => {
    await seed(paths.opencode.config, `{
  "provider": {
    "keydeck_gateway": {
      "name": "Keydeck Local Gateway",
      "options": { "baseURL": "http://127.0.0.1:17863/opencode/v1" }
    }
  },
  "model": "keydeck_gateway/gpt-5.2"
}\n`);

    const sources = new Map([
      [paths.opencode.config, await fs.readFile(paths.opencode.config, "utf8")],
    ]);
    const inspected = adapters.opencode.inspect(sources);

    expect(inspected.baseUrl).toBe("http://127.0.0.1:17863/opencode/v1");
    expect(inspected.model).toBe("gpt-5.2");
  });

  it("识别并恢复旧版 OpenCode 网关 provider", async () => {
    const localBaseUrl = "http://127.0.0.1:17863/opencode";
    await seed(paths.opencode.config, `{
  "provider": {
    "keydeck_gateway": {
      "npm": "@ai-sdk/openai",
      "name": "Keydeck Local Gateway",
      "options": { "baseURL": "${localBaseUrl}" },
      "models": { "gpt-5.2": { "name": "gpt-5.2" } }
    },
    "other": { "keep": true }
  },
  "model": "keydeck_gateway/gpt-5.2"
}\n`);
    await seed(paths.opencode.auth, `{
  "keydeck_gateway": { "type": "api", "key": "gateway-secret" },
  "other": { "type": "oauth", "refresh": "keep" }
}\n`);
    const profile = {
      ...baseProfile,
      protocol: "openai-responses",
      baseUrl: localBaseUrl,
      model: "gpt-5.2",
      targets: ["opencode"],
    };

    expect(await adapters.opencode.gatewayOwnership(profile, "gateway-secret"))
      .toBe(GATEWAY_OWNERSHIP.OWNED);

    const drafts = await adapters.opencode.buildRestore({
      model: { present: true, value: "other/default" },
      provider: { present: false, value: null },
      auth: { present: false, value: null },
    });
    const config = parse(drafts.find((draft) => draft.path === paths.opencode.config).content);
    const auth = parse(drafts.find((draft) => draft.path === paths.opencode.auth).content);
    expect(config.model).toBe("other/default");
    expect(config.provider.keydeck_gateway).toBeUndefined();
    expect(config.provider.other.keep).toBe(true);
    expect(auth.keydeck_gateway).toBeUndefined();
    expect(auth.other.refresh).toBe("keep");
  });

  it("旧版 OpenCode provider 的 capture 与新 provider 接管后仍能恢复", async () => {
    const localBaseUrl = "http://127.0.0.1:17863/opencode";
    await seed(paths.opencode.config, JSON.stringify({
      provider: {
        keydeck_gateway: {
          npm: "@ai-sdk/openai",
          name: "Keydeck Local Gateway",
          options: { baseURL: localBaseUrl },
          models: { "gpt-5.2": { name: "gpt-5.2" } },
        },
        other: { keep: true },
      },
      model: "keydeck_gateway/gpt-5.2",
    }));
    await seed(paths.opencode.auth, JSON.stringify({
      keydeck_gateway: { type: "api", key: "gateway-secret" },
      other: { type: "oauth", refresh: "keep" },
    }));

    const captured = await adapters.opencode.captureManagedState();
    const takeover = await adapters.opencode.build({
      ...baseProfile,
      protocol: "openai-responses",
      baseUrl: localBaseUrl,
      model: "gpt-5.2",
      targets: ["opencode"],
    }, "new-gateway-secret", { gateway: true });
    await writeDrafts(takeover);
    const duringTakeover = parse(await fs.readFile(paths.opencode.config, "utf8"));
    expect(duringTakeover.model).toBe("agentgate_gateway/gpt-5.2");
    expect(duringTakeover.provider.keydeck_gateway).toBeDefined();
    expect(duringTakeover.provider.agentgate_gateway).toBeDefined();

    const drafts = await adapters.opencode.buildRestore(captured);
    await writeDrafts(drafts);
    const config = parse(await fs.readFile(paths.opencode.config, "utf8"));
    const auth = parse(await fs.readFile(paths.opencode.auth, "utf8"));

    expect(captured.providerId).toBe("keydeck_gateway");
    expect(config.provider.keydeck_gateway).toBeDefined();
    expect(config.provider.keydeck_gateway.name).toBe("Keydeck Local Gateway");
    expect(config.provider.other.keep).toBe(true);
    expect(config.provider.agentgate_gateway).toBeUndefined();
    expect(auth.keydeck_gateway.key).toBe("gateway-secret");
    expect(auth.other.refresh).toBe("keep");
    expect(auth.agentgate_gateway).toBeUndefined();
  });
});

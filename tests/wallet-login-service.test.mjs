import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { WalletLoginService } = require("../electron/services/wallet-login-service.cjs");

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.clearStorageData = vi.fn(async () => {});
    this.clearCache = vi.fn(async () => {});
    this.clearAuthCache = vi.fn(async () => {});
    this.setPermissionCheckHandler = vi.fn((handler) => { this.permissionCheckHandler = handler; });
    this.setPermissionRequestHandler = vi.fn((handler) => { this.permissionRequestHandler = handler; });
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.session = new FakeSession();
    this.url = "about:blank";
    this.executeJavaScript = vi.fn(async () => null);
  }

  getURL() {
    return this.url;
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

class FakeBrowserWindow extends EventEmitter {
  static last;

  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.title = options.title;
    this.webContents = new FakeWebContents();
    this.loadURL = vi.fn(async (url) => { this.webContents.url = url; });
    FakeBrowserWindow.last = this;
  }

  removeMenu() {}
  show() {}
  focus() {}
  setTitle(title) { this.title = title; }
  isDestroyed() { return this.destroyed; }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

describe("钱包网页登录窗口", () => {
  it("显示真实域名，并阻止跨站、网页权限和下载", async () => {
    const openExternal = vi.fn(async () => {});
    const walletService = {
      getLoginTarget: vi.fn(async () => ({
        id: "wallet-id",
        siteUrl: "https://relay.example",
        loginUrl: "https://relay.example/login",
      })),
      importSub2ApiSession: vi.fn(),
    };
    const service = new WalletLoginService({
      BrowserWindow: FakeBrowserWindow,
      walletService,
      getParentWindow: () => undefined,
      openExternal,
    });

    const pending = service.login("wallet-id");
    await vi.waitFor(() => expect(FakeBrowserWindow.last).toBeDefined());
    const window = FakeBrowserWindow.last;
    const loginSession = window.webContents.session;

    expect(window.options.title).toContain("relay.example");
    expect(window.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    });
    expect(loginSession.permissionCheckHandler(null, "media", "https://relay.example")).toBe(false);
    const permissionCallback = vi.fn();
    loginSession.permissionRequestHandler(window.webContents, "media", permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);

    const sameOriginEvent = { preventDefault: vi.fn() };
    window.webContents.emit("will-navigate", sameOriginEvent, "https://relay.example/reset");
    expect(sameOriginEvent.preventDefault).not.toHaveBeenCalled();

    const crossOriginEvent = { preventDefault: vi.fn() };
    window.webContents.emit("will-navigate", crossOriginEvent, "https://phishing.example/login");
    expect(crossOriginEvent.preventDefault).toHaveBeenCalledOnce();

    const redirectEvent = { preventDefault: vi.fn() };
    window.webContents.emit("will-redirect", redirectEvent, "https://phishing.example/login");
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce();

    window.webContents.url = "https://relay.example/api/v1/auth/oauth/linuxdo/start";
    const oauthRedirectEvent = { preventDefault: vi.fn() };
    window.webContents.emit("will-redirect", oauthRedirectEvent, "https://connect.linux.do/oauth2/authorize");
    expect(oauthRedirectEvent.preventDefault).not.toHaveBeenCalled();
    expect(window.title).toContain("connect.linux.do");

    window.webContents.url = "https://connect.linux.do/oauth2/authorize";
    const oauthChainEvent = { preventDefault: vi.fn() };
    window.webContents.emit("will-redirect", oauthChainEvent, "https://id.linux.do/consent");
    expect(oauthChainEvent.preventDefault).not.toHaveBeenCalled();

    const oauthCallbackEvent = { preventDefault: vi.fn() };
    window.webContents.emit("will-redirect", oauthCallbackEvent, "https://relay.example/oauth/callback");
    expect(oauthCallbackEvent.preventDefault).not.toHaveBeenCalled();
    expect(window.title).toContain("relay.example");

    expect(window.webContents.windowOpenHandler({ url: "https://relay.example/help" })).toEqual({ action: "deny" });
    expect(window.loadURL).toHaveBeenLastCalledWith("https://relay.example/help");
    expect(window.webContents.windowOpenHandler({ url: "https://docs.example/help" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://docs.example/help");

    const downloadEvent = { preventDefault: vi.fn() };
    loginSession.emit("will-download", downloadEvent);
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();

    window.close();
    await expect(pending).resolves.toEqual({ cancelled: true });
    await vi.waitFor(() => expect(loginSession.clearStorageData).toHaveBeenCalledOnce());
    expect(loginSession.clearCache).toHaveBeenCalledOnce();
    expect(loginSession.clearAuthCache).toHaveBeenCalledOnce();
  });

  it("Electron 销毁登录窗口后，手动关闭仍安全取消", async () => {
    let rejectImport;
    const importPending = new Promise((_, reject) => {
      rejectImport = reject;
    });
    const walletService = {
      getLoginTarget: vi.fn(async () => ({
        id: "wallet-id",
        siteUrl: "https://relay.example",
        loginUrl: "https://relay.example/login",
      })),
      importSub2ApiSession: vi.fn(() => importPending),
    };
    const service = new WalletLoginService({
      BrowserWindow: FakeBrowserWindow,
      walletService,
      getParentWindow: () => undefined,
      openExternal: vi.fn(async () => {}),
    });

    const pending = service.login("wallet-id");
    await vi.waitFor(() => expect(FakeBrowserWindow.last).toBeDefined());
    const window = FakeBrowserWindow.last;
    const webContents = window.webContents;
    const loginSession = webContents.session;
    webContents.url = "https://relay.example/dashboard";
    webContents.executeJavaScript.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    webContents.emit("did-finish-load");
    await vi.waitFor(() => expect(walletService.importSub2ApiSession).toHaveBeenCalledOnce());

    Object.defineProperty(window, "webContents", {
      configurable: true,
      get() {
        if (window.destroyed) throw new Error("Object has been destroyed");
        return webContents;
      },
    });
    for (const method of ["clearStorageData", "clearCache", "clearAuthCache"]) {
      loginSession[method].mockImplementation(() => {
        throw new Error("Object has been destroyed");
      });
    }

    expect(() => window.close()).not.toThrow();
    rejectImport(new Error("late verification failure"));
    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(loginSession.clearStorageData).toHaveBeenCalledOnce();
    expect(loginSession.clearCache).toHaveBeenCalledOnce();
    expect(loginSession.clearAuthCache).toHaveBeenCalledOnce();
  });

  it("账户验证暂时失败时保留登录窗口并限频重试", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    try {
      const wallet = { id: "wallet-id", name: "Sub2", credentialStatus: "ready" };
      const walletService = {
        getLoginTarget: vi.fn(async () => ({
          id: "wallet-id",
          siteUrl: "https://relay.example",
          loginUrl: "https://relay.example/login",
        })),
        importSub2ApiSession: vi.fn()
          .mockRejectedValueOnce(new Error("temporary upstream failure"))
          .mockResolvedValueOnce(wallet),
      };
      const service = new WalletLoginService({
        BrowserWindow: FakeBrowserWindow,
        walletService,
        getParentWindow: () => undefined,
        openExternal: vi.fn(async () => {}),
      });

      const pending = service.login("wallet-id");
      await Promise.resolve();
      await Promise.resolve();
      const window = FakeBrowserWindow.last;
      window.webContents.url = "https://relay.example/dashboard";
      window.webContents.executeJavaScript.mockResolvedValue({
        accessToken: "access-token",
        refreshToken: "refresh-token",
      });

      window.webContents.emit("did-finish-load");
      await Promise.resolve();
      await Promise.resolve();
      expect(walletService.importSub2ApiSession).toHaveBeenCalledTimes(1);
      expect(window.isDestroyed()).toBe(false);

      window.webContents.emit("did-finish-load");
      await Promise.resolve();
      expect(walletService.importSub2ApiSession).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-07-28T00:00:05.000Z"));
      window.webContents.emit("did-finish-load");
      await Promise.resolve();
      await Promise.resolve();

      await expect(pending).resolves.toEqual({ cancelled: false, wallet });
      expect(walletService.importSub2ApiSession).toHaveBeenCalledTimes(2);
      expect(window.isDestroyed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

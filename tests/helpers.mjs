import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  HistoryStoreSchema,
  ProfileStoreSchema,
} = require("../electron/services/schemas.cjs");
const { JsonFileStore } = require("../electron/services/storage.cjs");

export const testVault = {
  encrypt(value) {
    return Buffer.from(`test-vault:${value}`, "utf8").toString("base64");
  },
  decrypt(value) {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (!decoded.startsWith("test-vault:")) {
      throw new Error("测试密文无效");
    }
    return decoded.slice("test-vault:".length);
  },
  hint(value) {
    return `****${value.slice(-4)}`;
  },
};

/**
 * 为服务测试创建隔离的方案与历史存储。
 *
 * @param {string} root 当前测试临时目录。
 * @returns {{profileStore: object, historyStore: object}} 两个 JSON 存储实例。
 */
export function createTestStores(root) {
  const dataDirectory = path.join(root, "data");
  return {
    profileStore: new JsonFileStore(
      path.join(dataDirectory, "profiles.json"),
      ProfileStoreSchema,
      () => ({ version: 3, groups: [], profiles: [] }),
    ),
    historyStore: new JsonFileStore(
      path.join(dataDirectory, "history.json"),
      HistoryStoreSchema,
      () => ({ version: 1, entries: [] }),
    ),
  };
}

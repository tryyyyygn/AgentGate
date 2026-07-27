/**
 * 整理 Windows 交付件：从 release/ 收集本版本产物到 deliverables/，
 * 生成源码包与 SHA256 校验和，并清理旧版本文件。
 *
 * latest.yml 是 electron-updater 的更新清单，发 Release 时必须一并上传，
 * 否则已安装的客户端无法发现新版本。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = require(path.join(root, "package.json"));
const { version } = packageMetadata;
const releaseLabel = packageMetadata.build?.buildVersion || version;

if (typeof releaseLabel !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(releaseLabel)) {
  throw new Error(`无效的交付版本标签：${String(releaseLabel)}`);
}

const RELEASE_DIR = path.join(root, "release");
const OUTPUT_DIR = path.join(root, "deliverables");
const SOURCE_ENTRIES = [
  ".gitignore", "LICENSE", "README.md", "README.en.md", "README.ja.md", "README.zh-TW.md",
  "index.html", "package.json", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "tsconfig.json", "vite.config.ts", "vitest.config.mts",
  "assets", "docs", "electron", "public", "scripts", "src", "tests",
];
const SKIP_DIRS = new Set(["node_modules", "__pycache__"]);

const artifacts = [
  `AgentGate-Portable-${releaseLabel}-x64.exe`,
  `AgentGate-Setup-${releaseLabel}-x64.exe`,
  `AgentGate-Setup-${releaseLabel}-x64.exe.blockmap`,
  "latest.yml",
];
const sourceZip = `AgentGate-${releaseLabel}-source.zip`;

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 删除 deliverables 与 release 中不属于本版本的产物；被占用的文件跳过并报告。 */
async function pruneOldVersions() {
  const locked = [];
  for (const [dir, isStale] of [
    [OUTPUT_DIR, (name) => !name.includes(releaseLabel)],
    [RELEASE_DIR, (name) => name.startsWith("AgentGate-") && !name.includes(releaseLabel)],
  ]) {
    const entries = await fs.readdir(dir).catch(() => []);
    for (const name of entries) {
      if (!isStale(name)) continue;
      try {
        await fs.rm(path.join(dir, name), { recursive: true });
      } catch (error) {
        if (error.code === "EBUSY" || error.code === "EPERM") locked.push(`${path.basename(dir)}/${name}`);
        else throw error;
      }
    }
  }
  return locked;
}

async function collectSourceFiles() {
  const files = [];
  for (const entry of SOURCE_ENTRIES) {
    const target = path.join(root, entry);
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) continue;
    if (stat.isFile()) {
      files.push(entry);
      continue;
    }
    const stack = [entry];
    while (stack.length > 0) {
      const current = stack.pop();
      const children = await fs.readdir(path.join(root, current), { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (SKIP_DIRS.has(child.name) || child.name.endsWith(".pyc")) continue;
        const relative = `${current}/${child.name}`;
        if (child.isDirectory()) stack.push(relative);
        else files.push(relative);
      }
    }
  }
  return files.sort();
}

/**
 * 用系统 tar 打 zip（Windows 10+ 自带），避免引入压缩依赖。
 *
 * 全部使用相对路径：tar 会把 `D:\...` 里的冒号解析为远程主机分隔符。
 */
async function buildSourceZip(files) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const listFile = ".source-files.tmp";
  await fs.writeFile(path.join(root, listFile), files.join("\n"), "utf8");
  try {
    await run("tar", [
      "-a", "-c", "-f", `deliverables/${sourceZip}`,
      "-T", listFile,
    ], { cwd: root });
  } finally {
    await fs.rm(path.join(root, listFile), { force: true });
  }
}

const locked = await pruneOldVersions();
await fs.mkdir(OUTPUT_DIR, { recursive: true });

for (const name of artifacts) {
  const source = path.join(RELEASE_DIR, name);
  if (!await fs.stat(source).catch(() => undefined)) {
    throw new Error(`缺少构建产物：${name}（先执行 pnpm dist）`);
  }
  await fs.copyFile(source, path.join(OUTPUT_DIR, name));
}

await buildSourceZip(await collectSourceFiles());

const checksumTargets = [
  `AgentGate-Portable-${releaseLabel}-x64.exe`,
  `AgentGate-Setup-${releaseLabel}-x64.exe`,
  sourceZip,
];
const lines = [];
for (const name of checksumTargets) {
  const digest = await sha256(path.join(OUTPUT_DIR, name));
  lines.push(`${digest} *${name}`);
}
await fs.writeFile(path.join(OUTPUT_DIR, `SHA256SUMS-${releaseLabel}.txt`), `${lines.join("\n")}\n`, "utf8");

console.log(`交付件已整理到 deliverables/（内部 v${version}，交付标签 ${releaseLabel}）`);
for (const line of lines) console.log(`  ${line}`);
console.log("  latest.yml（更新清单，发 Release 时必须上传）");
if (locked.length > 0) console.log(`旧文件被占用未删除：${locked.join(", ")}`);

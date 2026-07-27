import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const ROOT_FILES = [
  "LICENSE",
  "README.md",
  "README.en.md",
  "README.ja.md",
  "README.zh-TW.md",
];

describe("发布清单", () => {
  it("应用包和源码包都包含许可证与四语 README", async () => {
    const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
    const releaseSource = await fs.readFile("scripts/release.mjs", "utf8");

    expect(packageJson.build.files).toContain("LICENSE");
    expect(packageJson.build.files).toContain("README*.md");
    for (const file of ROOT_FILES) expect(releaseSource).toContain(`"${file}"`);
    expect(releaseSource).toContain('"docs"');
  });

  it("使用合法的内部 SemVer 作为所有发布产物标签", async () => {
    const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
    const releaseSource = await fs.readFile("scripts/release.mjs", "utf8");

    expect(packageJson.version).toBe("1.8.0");
    expect(packageJson.build.buildVersion).toBeUndefined();
    expect(packageJson.build.nsis.artifactName).toContain("${version}");
    expect(packageJson.build.portable.artifactName).toContain("${version}");
    expect(releaseSource).toContain("const releaseLabel = packageMetadata.build?.buildVersion || version;");
    expect(releaseSource).toContain("AgentGate-Portable-${releaseLabel}-x64.exe");
    expect(releaseSource).toContain("SHA256SUMS-${releaseLabel}.txt");
  });
});

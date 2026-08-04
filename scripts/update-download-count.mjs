import fs from "node:fs/promises";
import path from "node:path";

const repository = process.env.GITHUB_REPOSITORY ?? "trygn35-ui/agentgate";
const outputPath = path.resolve(
  process.env.DOWNLOAD_COUNT_FILE ?? "docs/download-count.json",
);
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "agentgate-download-count",
};

if (token) headers.Authorization = `Bearer ${token}`;

async function getJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}): ${url}`);
  }
  return response.json();
}

const assets = [];
for (let page = 1; ; page += 1) {
  const releases = await getJson(
    `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
  );
  if (!Array.isArray(releases)) throw new Error("GitHub releases response is invalid");
  for (const release of releases) assets.push(...(release.assets ?? []));
  if (releases.length < 100) break;
}

const counts = { setup: 0, portable: 0 };
for (const asset of assets) {
  const match = /^AgentGate-(Setup|Portable)-.+\.exe$/i.exec(asset.name ?? "");
  if (!match) continue;
  counts[match[1].toLowerCase()] += Number(asset.download_count) || 0;
}

const output = {
  schemaVersion: 1,
  label: "downloads",
  message: String(counts.setup + counts.portable),
  color: "2F78D0",
  cacheSeconds: 3600,
  setup: counts.setup,
  portable: counts.portable,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
const previous = await fs.readFile(outputPath, "utf8").catch(() => undefined);

if (previous === serialized) {
  console.log(`Download count unchanged: ${output.message}`);
} else {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, serialized, "utf8");
  console.log(
    `Download count updated: ${output.message} (setup ${counts.setup}, portable ${counts.portable})`,
  );
}

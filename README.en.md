<div align="center">

# Agent;Gate

A local API key manager and loopback gateway for Windows AI clients.

[简体中文](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/trygn35-ui/agentgate?style=flat-square)](https://github.com/trygn35-ui/agentgate/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-2F78D0?style=flat-square)](#download)
[![License](https://img.shields.io/badge/license-Community%20Use-FF9100?style=flat-square)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/overview-dark.png">
  <img src="docs/images/overview.png" width="820" alt="Agent;Gate overview">
</picture>

</div>

## What it does

When you use several desktop AI clients and more than one API provider, the annoying part is usually the configuration: editing several files, keeping track of keys, and finding out which route still works.

Agent;Gate keeps that work in one local Windows app:

- Store API URLs, keys, models, and fallback endpoints as profiles, organized in collapsible groups.
- Run one gateway for several clients while keeping an independent route for each client.
- Point clients at `127.0.0.1` once, then switch profiles without rewriting their config every time.
- Track relay balances and daily subscription quotas in a separate Wallet page, then import supported keys when needed.
- Probe channels with the real key and show availability, latency, and recent results.
- Watch live request state, TTFB/TTFT, token usage, and cache hits.
- Browse and remove local sessions created by Claude Code, Codex, and OpenCode.

Agent;Gate is not a hosted service or a shared proxy. It has no account system, backend, or telemetry.

## Client support

| Client | Status | Protocols |
| --- | --- | --- |
| Codex | Stable | OpenAI Responses, Chat Completions |
| Claude Code | Experimental | Anthropic Messages |
| OpenCode | Experimental | Anthropic, OpenAI, Gemini |
| Gemini CLI | Experimental | Gemini |

Experimental clients may change their configuration format. Agent;Gate limits edits to fields it owns and restores them when a client is released, but it is still worth checking the config after a major client update.

## Wallet and key groups

Wallet currently supports Sub2API, New API, and One API templates. Sub2API can sign in through an isolated browser window, refresh balances every 5 minutes, and show the real daily subscription allowance and its next reset time. Wallet totals stay separate from gateway request accounting; profiles are created only when you explicitly import keys.

Imports create or reuse a group named after the wallet. Unsupported platforms are skipped, and a Sub2API account with more than 500 keys is rejected instead of partially imported. The Keys page can create, rename, delete, collapse, and expand groups, with immediate drag ordering for both groups and profiles.

## Channel status

Automatic probes run every 2 minutes by default, with 5 and 10 minute options. The schedule uses a fixed clock; running an immediate probe does not postpone the next automatic one.

| Result | Rule |
| --- | --- |
| Healthy | Successful in 5 seconds or less |
| Smooth | Successful in more than 5 and no more than 10 seconds |
| High latency | Successful in more than 10 seconds |
| Down | Failed, timed out, or otherwise unavailable |

Each channel can be excluded from monitoring, use its own probe model, and be selected directly from the status page.

## Download

Get the latest build from [Releases](https://github.com/trygn35-ui/agentgate/releases/latest):

| File | Use |
| --- | --- |
| `AgentGate-Setup-<version>-x64.exe` | Installer build with in-app updates; recommended |
| `AgentGate-Portable-<version>-x64.exe` | Portable build; cannot replace itself during updates |
| `SHA256SUMS-<version>.txt` | SHA-256 checksums |

Requires Windows 10 1809+ or Windows 11 on x64.

The binaries are not commercially code-signed, so SmartScreen may report an unknown publisher. Verify the SHA-256 from the release, then use “More info → Run anyway” if you trust the build.

## Quick start

1. Create a profile on the Keys page. New profiles default to OpenAI Responses.
2. Select the clients that profile should serve.
3. Assign it from the Overview or Status page.
4. Engage the client card. The client continues to work normally through the local gateway.

Releasing a client restores the fields Agent;Gate changed. Switching profiles only changes the gateway route and does not interrupt requests already in flight.

```text
Claude Code ─┐
Codex ───────┤
OpenCode ────┼──> 127.0.0.1:17863 ──> per-client routes ──> different upstreams
Gemini CLI ──┘
```

## Data and security

- Keys are encrypted with Windows DPAPI for the current Windows user.
- Real upstream URLs and keys are not written to client configuration files.
- The gateway listens on loopback only and is not exposed to the LAN.
- Activity history stores request metadata, not prompts or response bodies.
- Session management reads each client's own local store. Deletion is previewed first and cannot be undone.
- Sub2API sign-in runs in a temporary Electron session limited to the target site and official OAuth HTTPS redirects. Cookies, cache, and authentication data are cleared when the window closes.
- Imported wallet session tokens are encrypted with Windows DPAPI. If the site expires or revokes the refresh token, sign in again.

Data lives under:

```text
%APPDATA%\agentgate\data\
├── profiles.json
├── gateway.json
├── gateway-recovery.json
├── settings.json
├── requests.json
├── wallets.json
└── window-state.json
```

## Screenshots

<details open>
<summary>Overview</summary>
<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/overview-dark.png">
  <img src="docs/images/overview.png" width="820" alt="Overview">
</picture>
</details>

<details>
<summary>Wallet</summary>
<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/wallet-dark.png">
  <img src="docs/images/wallet.png" width="820" alt="Wallet">
</picture>
</details>

<details>
<summary>Key management</summary>
<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/keyring-dark.png">
  <img src="docs/images/keyring.png" width="820" alt="Key management">
</picture>
</details>

<details>
<summary>Channel status</summary>
<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/status-dark.png">
  <img src="docs/images/status.png" width="820" alt="Channel status">
</picture>
</details>

<details>
<summary>Request activity</summary>
<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/activity-dark.png">
  <img src="docs/images/activity.png" width="820" alt="Request activity">
</picture>
</details>

<details>
<summary>Settings</summary>
<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png">
  <img src="docs/images/settings.png" width="820" alt="Settings">
</picture>
</details>

## Development

Node.js 22 and pnpm are required.

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm dev
pnpm dist
pnpm release
```

The Electron main process owns file writes, DPAPI, and the gateway. The React renderer has no direct filesystem access.

## License

[AgentGate Community Use License 1.0](LICENSE)

AgentGate may be downloaded and used for personal, educational, research, and other non-commercial purposes while retaining the author and license notices. Commercial use, sale, hosting, redistribution, publication of modified versions, and presenting another build as official require prior written permission. Private non-commercial modifications are allowed. This is source-available software, not OSI-defined open source.

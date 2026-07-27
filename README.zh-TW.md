<div align="center">

# Agent;Gate

給 Windows 桌面 AI Client 使用的本機 API Key 管理器與 Loopback Gateway。

[简体中文](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/trygn35-ui/agentgate?style=flat-square)](https://github.com/trygn35-ui/agentgate/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-2F78D0?style=flat-square)](#下載)
[![License](https://img.shields.io/github/license/trygn35-ui/agentgate?style=flat-square)](LICENSE)

<img src="docs/images/overview.png" width="820" alt="Agent;Gate 總覽">

</div>

## 它處理什麼

同時使用 Codex、Claude Code、OpenCode 或 Gemini CLI，又有好幾組官方 API 或中轉服務時，最麻煩的通常是設定：反覆改檔案、找 Key，還要確認哪條線路目前能用。

Agent;Gate 把這些工作收進一個本機 Windows App：

- 以 Profile 保存 API URL、Key、Model 與備用 Endpoint。
- 一個 Gateway 同時服務多個 Client，每個 Client 都有獨立路由，可以使用不同 Key。
- Client 只需連到一次 `127.0.0.1`，之後切換 Profile 不必反覆改設定。
- 使用真正的 Key 定期送出最小請求，顯示可用率、延遲與近期結果。
- 即時查看請求狀態、TTFB/TTFC、Token 與 Cache 命中。
- 瀏覽及刪除 Claude Code、Codex、OpenCode 留在本機的 Session。

它不是雲端服務，也不是共用 Proxy；沒有帳號、後端或 Telemetry。

## Client 支援狀態

| Client | 狀態 | 協定 |
| --- | --- | --- |
| Codex | 穩定 | OpenAI Responses、Chat Completions |
| Claude Code | 實驗性 | Anthropic Messages |
| OpenCode | 實驗性 | Anthropic、OpenAI、Gemini |
| Gemini CLI | 實驗性 | Gemini |

「實驗性」表示 Client 的設定格式仍可能變動。Agent;Gate 只會修改自己負責的欄位，解除接管時也會還原；Client 大版本更新後仍建議先檢查一次設定。

## Channel Status

自動檢測預設每 2 分鐘執行，也可選 5 或 10 分鐘。排程使用固定時鐘；按下「立即檢測」不會延後下一次自動檢測。

| 結果 | 判定 |
| --- | --- |
| 正常 | 成功，總耗時不超過 5 秒 |
| 流暢 | 成功，超過 5 秒且不超過 10 秒 |
| 延遲 | 成功，超過 10 秒 |
| 故障 | 失敗、逾時或其他不可用結果 |

每個 Channel 都能個別關閉監測、選擇檢測 Model，並直接從狀態頁切換成目前使用的 Key。

## 下載

到 [Releases](https://github.com/trygn35-ui/agentgate/releases/latest) 取得最新版：

| 檔案 | 用途 |
| --- | --- |
| `AgentGate-Setup-<version>-x64.exe` | 安裝版，支援 App 內更新，建議使用 |
| `AgentGate-Portable-<version>-x64.exe` | 免安裝版，無法在更新時自行取代執行檔 |
| `SHA256SUMS-<version>.txt` | SHA-256 校驗值 |

需求為 Windows 10 1809+ 或 Windows 11，x64。

目前執行檔沒有商業程式碼簽章，SmartScreen 可能顯示未知發行者。可先核對 Release 中的 SHA-256，再選擇「其他資訊 → 仍要執行」。

## 快速開始

1. 在「API Key」頁新增 Profile。新 Profile 預設使用 OpenAI Responses。
2. 選擇這個 Profile 要服務的 Client。
3. 從「總覽」或「狀態」頁指定 Profile。
4. 點擊 Client 卡片開始接管；Client 之後照原本方式使用即可。

解除接管時，Agent;Gate 會還原自己修改過的欄位。切換 Profile 只會更新 Gateway 路由，不會中斷已送出的請求。

```text
Claude Code ─┐
Codex ───────┤
OpenCode ────┼──> 127.0.0.1:17863 ──> 各 Client 獨立路由 ──> 不同上游
Gemini CLI ──┘
```

## 資料與安全

- Key 使用 Windows DPAPI 加密，綁定目前的 Windows 使用者。
- 真正的上游 URL 與 Key 不會寫進 Client 設定檔。
- Gateway 只監聽 Loopback，不會開放給區域網路。
- 動態紀錄只保存請求 Metadata，不保存 Prompt 或回覆本文。
- Session 管理直接讀取各 Client 的本機資料庫；刪除前會先顯示計畫，刪除後無法復原。

資料目錄：

```text
%APPDATA%\agentgate\data\
├── profiles.json
├── gateway.json
├── gateway-recovery.json
├── settings.json
├── requests.json
└── window-state.json
```

## 畫面

<details open>
<summary>API Key 管理</summary>
<br>
<img src="docs/images/keyring.png" width="820" alt="API Key 管理">
</details>

<details>
<summary>請求動態</summary>
<br>
<img src="docs/images/activity.png" width="820" alt="請求動態">
</details>

<details>
<summary>設定</summary>
<br>
<img src="docs/images/settings.png" width="820" alt="設定">
</details>

## 開發

需要 Node.js 22 與 pnpm。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm dev
pnpm dist
pnpm release
```

Electron Main Process 負責檔案寫入、DPAPI 與 Gateway；React Renderer 沒有直接存取檔案系統的權限。

## License

[MIT](LICENSE)

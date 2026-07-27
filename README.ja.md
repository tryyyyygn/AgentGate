<div align="center">

# Agent;Gate

Windows のデスクトップ AI クライアント向け、ローカル API キー管理ツール兼ループバックゲートウェイ。

[简体中文](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/trygn35-ui/agentgate?style=flat-square)](https://github.com/trygn35-ui/agentgate/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-2F78D0?style=flat-square)](#ダウンロード)
[![License](https://img.shields.io/github/license/trygn35-ui/agentgate?style=flat-square)](LICENSE)

<img src="docs/images/overview.png" width="820" alt="Agent;Gate 概要">

</div>

## できること

Codex、Claude Code、OpenCode、Gemini CLI を併用し、API や中継サービスも複数あると、面倒なのは設定です。ファイルを書き換え、キーを探し、どの回線が生きているか確認する作業が増えていきます。

Agent;Gate は、その作業をローカルの Windows アプリにまとめます。

- API URL、キー、モデル、予備エンドポイントをプロファイルとして保存。
- 1 つのゲートウェイで複数クライアントを処理し、クライアントごとに別のルートとキーを使用。
- クライアント側は一度 `127.0.0.1` に向ければ、以後の切り替えで設定ファイルを何度も編集しない。
- 実際のキーで最小リクエストを定期送信し、可用率、レイテンシ、直近の結果を表示。
- リクエスト状態、TTFB/TTFC、Token、キャッシュヒットをリアルタイム表示。
- Claude Code、Codex、OpenCode がローカルに残したセッションを閲覧・削除。

クラウドサービスでも共用プロキシでもありません。アカウント、バックエンド、テレメトリはありません。

## クライアント対応状況

| クライアント | 状態 | プロトコル |
| --- | --- | --- |
| Codex | 安定 | OpenAI Responses、Chat Completions |
| Claude Code | 実験的 | Anthropic Messages |
| OpenCode | 実験的 | Anthropic、OpenAI、Gemini |
| Gemini CLI | 実験的 | Gemini |

「実験的」は、クライアント側の設定形式が今後変わる可能性があるという意味です。Agent;Gate は管理対象のフィールドだけを書き換え、解除時に戻しますが、クライアントの大型アップデート後は設定を一度確認してください。

## チャネル状態

自動チェックは既定で 2 分ごと。5 分、10 分にも変更できます。固定スケジュールで動くため、「今すぐチェック」を実行しても次回の自動チェック時刻はずれません。

| 結果 | 判定 |
| --- | --- |
| 正常 | 成功、5 秒以内 |
| 快適 | 成功、5 秒超 10 秒以内 |
| 遅延 | 成功、10 秒超 |
| 障害 | 失敗、タイムアウト、その他の利用不可結果 |

チャネルごとに監視の停止、チェック用モデルの選択、状態ページからのキー切り替えができます。

## ダウンロード

[Releases](https://github.com/trygn35-ui/agentgate/releases/latest) から最新版を取得できます。

| ファイル | 用途 |
| --- | --- |
| `AgentGate-Setup-<version>-x64.exe` | インストーラー版。アプリ内更新対応、推奨 |
| `AgentGate-Portable-<version>-x64.exe` | ポータブル版。更新時の自己置換は不可 |
| `SHA256SUMS-<version>.txt` | SHA-256 チェックサム |

Windows 10 1809+ または Windows 11、x64 が必要です。

現在のバイナリには商用コード署名がないため、SmartScreen が「不明な発行元」と表示する場合があります。Release の SHA-256 を確認したうえで、「詳細情報 → 実行」を選択してください。

## 使い方

1. 「API キー」ページでプロファイルを追加。新規プロファイルの既定は OpenAI Responses。
2. そのプロファイルを使うクライアントを選択。
3. 「概要」または「状態」ページから割り当て。
4. クライアントカードをクリックして引き受け。以後はクライアントを普段どおり使います。

解除時は Agent;Gate が変更したフィールドを復元します。プロファイルの切り替えはゲートウェイルートだけを更新し、送信済みのリクエストは中断しません。

```text
Claude Code ─┐
Codex ───────┤
OpenCode ────┼──> 127.0.0.1:17863 ──> クライアント別ルート ──> 別々の上流
Gemini CLI ──┘
```

## データと安全性

- キーは Windows DPAPI で暗号化し、現在の Windows ユーザーに紐付けて保存。
- 実際の上流 URL とキーはクライアント設定に書き込まない。
- ゲートウェイはループバックだけで待ち受け、LAN には公開しない。
- アクティビティ履歴に保存するのはメタデータだけ。プロンプトや応答本文は保存しない。
- セッション管理は各クライアントのローカル DB を直接読み取る。削除前に対象を表示し、削除後の復元は不可。

データディレクトリ：

```text
%APPDATA%\agentgate\data\
├── profiles.json
├── gateway.json
├── gateway-recovery.json
├── settings.json
├── requests.json
└── window-state.json
```

## スクリーンショット

<details open>
<summary>キー管理</summary>
<br>
<img src="docs/images/keyring.png" width="820" alt="キー管理">
</details>

<details>
<summary>リクエスト履歴</summary>
<br>
<img src="docs/images/activity.png" width="820" alt="リクエスト履歴">
</details>

<details>
<summary>設定</summary>
<br>
<img src="docs/images/settings.png" width="820" alt="設定">
</details>

## 開発

Node.js 22 と pnpm が必要です。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm dev
pnpm dist
pnpm release
```

ファイル書き込み、DPAPI、ゲートウェイは Electron の Main Process が担当します。React Renderer からファイルシステムへ直接アクセスしません。

## License

[MIT](LICENSE)

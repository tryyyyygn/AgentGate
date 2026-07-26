"""通过 CDP 验证打包版 Codex URL-only 接管、热切换和字段级恢复。"""

import json
import os
import re
import socket
import tomllib
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright


cdp_url = os.environ["KEYDECK_CDP_URL"]
smoke_root = Path(os.environ["KEYDECK_SMOKE_ROOT"])
upstream_origin = os.environ["KEYDECK_SMOKE_BASE_URL"].rstrip("/")
codex_home = Path(os.environ["CODEX_HOME"])
codex_home.mkdir(parents=True, exist_ok=True)
codex_config = codex_home / "config.toml"
secret_a = "sk-packaged-smoke-secret-a"
secret_b = "sk-packaged-smoke-secret-b"

original = f'''# 用户运行配置必须完整保留
model_provider = "custom"
model = "user-model"
approval_policy = "never"

[features]
web_search_request = true

[model_providers.custom]
name = "Custom"
base_url = "https://user-original.example/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "user-owned-auth"

[mcp_servers.demo]
command = "node"
'''
codex_config.write_text(original, encoding="utf-8")

with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    gateway_port = probe.getsockname()[1]


def gateway_request(base_url: str) -> dict:
    request = urllib.request.Request(
        f"{base_url}/responses",
        data=b'{"model":"client-owned-model","input":"ping"}',
        method="POST",
        headers={
            "Authorization": "Bearer incoming-client-auth-is-ignored",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(cdp_url)
    contexts = browser.contexts
    assert contexts and contexts[0].pages, "打包版未创建浏览器页面"
    page = contexts[0].pages[0]
    page.locator(".brand-mark").wait_for()

    created = page.evaluate(
        """
        async ({secretA, secretB, upstreamOrigin}) => {
          const common = {
            protocol: 'openai-responses',
            model: 'discovery-only-model',
            authMode: 'bearer',
            targets: ['codex'],
            enableToolSearch: false,
            autoSwitch: {enabled: false, intervalMinutes: 2}
          };
          const urlA = `${upstreamOrigin}/a/v1`;
          const urlB = `${upstreamOrigin}/b/v1`;
          const profileA = await window.agentgate.saveProfile({
            ...common, name: '打包方案 A', baseUrl: urlA,
            endpoints: [{url: urlA}], apiKey: secretA
          });
          const profileB = await window.agentgate.saveProfile({
            ...common, name: '打包方案 B', baseUrl: urlB,
            endpoints: [{url: urlB}], apiKey: secretB
          });
          const assigned = await window.agentgate.applyProfile(profileA.id, ['codex']);
          return {profileA, profileB, assigned};
        }
        """,
        {"secretA": secret_a, "secretB": secret_b, "upstreamOrigin": upstream_origin},
    )
    serialized = json.dumps(created, ensure_ascii=False)
    assert secret_a not in serialized and secret_b not in serialized
    assert created["assigned"]["gateway"]["status"] == "stopped"
    assert codex_config.read_text(encoding="utf-8") == original

    page.evaluate("port => window.agentgate.startGateway({port})", gateway_port)
    taken_over = codex_config.read_text(encoding="utf-8")
    parsed = tomllib.loads(taken_over)
    local_base_url = parsed["model_providers"]["custom"]["base_url"]
    assert re.fullmatch(rf"http://127\.0\.0\.1:{gateway_port}/codex/[A-Za-z0-9_-]{{40,}}", local_base_url)
    assert parsed["model_provider"] == "custom"
    assert parsed["model"] == "user-model"
    assert parsed["model_providers"]["custom"]["wire_api"] == "responses"
    assert parsed["model_providers"]["custom"]["experimental_bearer_token"] == "user-owned-auth"
    assert "keydeck_gateway" not in parsed.get("model_providers", {})
    assert secret_a not in taken_over and secret_b not in taken_over
    assert gateway_request(local_base_url) == {"route": "a"}

    runtime_edit = taken_over.replace(
        "[features]",
        "runtime_added = true\n\n[features]",
        1,
    )
    codex_config.write_text(runtime_edit, encoding="utf-8")
    before_hot_switch = codex_config.read_bytes()
    page.evaluate(
        "id => window.agentgate.applyProfile(id, ['codex'])",
        created["profileB"]["id"],
    )
    assert codex_config.read_bytes() == before_hot_switch
    assert gateway_request(local_base_url) == {"route": "b"}

    recovery_store = smoke_root / "user-data" / "data" / "gateway-recovery.json"
    recovery_text = recovery_store.read_text(encoding="utf-8")
    assert "https://user-original.example" not in recovery_text
    assert "user-owned-auth" not in recovery_text

    stopped = page.evaluate("() => window.agentgate.stopGateway()")
    assert stopped["gateway"]["status"] == "stopped"
    restored = tomllib.loads(codex_config.read_text(encoding="utf-8"))
    assert restored["model_provider"] == "custom"
    assert restored["model"] == "user-model"
    assert restored["runtime_added"] is True
    assert restored["model_providers"]["custom"]["base_url"] == "https://user-original.example/v1"
    assert restored["model_providers"]["custom"]["wire_api"] == "responses"
    assert restored["model_providers"]["custom"]["experimental_bearer_token"] == "user-owned-auth"
    assert restored["mcp_servers"]["demo"]["command"] == "node"
    assert json.loads(recovery_store.read_text(encoding="utf-8"))["baselines"] == {}
    browser.close()

data_directory = smoke_root / "user-data" / "data"
for filename in ("profiles.json", "gateway.json", "gateway-recovery.json", "settings.json"):
    store = data_directory / filename
    assert store.exists(), f"打包版未生成 {filename}"
    source = store.read_text(encoding="utf-8")
    assert secret_a not in source and secret_b not in source
    assert "user-owned-auth" not in source

assert tomllib.loads(codex_config.read_text(encoding="utf-8"))["model_provider"] == "custom"

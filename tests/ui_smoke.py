"""在隔离浏览器预览中验证 Agent;Gate 主要页面、三语切换、返回交互与紧凑布局。"""

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import ConsoleMessage, sync_playwright


OUTPUT_DIR = Path(__file__).resolve().parents[1] / "output" / "playwright"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
console_errors: list[str] = []


def record_console_error(message: ConsoleMessage) -> None:
    if message.type == "error":
        console_errors.append(message.text)


def select_language(page, label: str) -> None:
    """在设置页选择界面语言；界面默认跟随系统，断言前必须固定语言。"""
    page.get_by_role("radio", name=label, exact=True).click()
    page.wait_for_timeout(400)


def assert_layout(page, width: int, height: int, name: str) -> dict:
    page.set_viewport_size({"width": width, "height": height})
    page.wait_for_timeout(100)
    layout = page.evaluate(
        """
        () => {
          const shell = document.querySelector('.app-shell').getBoundingClientRect();
          const topbar = document.querySelector('.topbar').getBoundingClientRect();
          const footer = document.querySelector('.status-footer').getBoundingClientRect();
          return {
            body: [document.body.scrollWidth, document.body.scrollHeight],
            viewport: [innerWidth, innerHeight],
            shell: [shell.left, shell.right, shell.bottom],
            topbar: [topbar.left, topbar.right, topbar.bottom],
            footer: [footer.left, footer.right, footer.top, footer.bottom],
          };
        }
        """
    )
    assert layout["body"] == layout["viewport"]
    assert layout["shell"] == [0, width, height]
    assert layout["topbar"][1] == width
    assert layout["topbar"][2] == 54
    assert layout["footer"][1:] == [width, height - 24, height]
    page.screenshot(path=str(OUTPUT_DIR / f"{name}.png"), full_page=False)
    return layout


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    )
    page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
    page.on("console", record_console_error)
    page.goto(URL, wait_until="networkidle")
    page.locator(".hero h1").wait_for()

    # 四语切换：每种语言下导航栏都必须有文字，且 <html lang> 同步
    page.get_by_role("button", name="设置", exact=True).click()
    languages = {}
    for label, expected_lang, nav_first in (
        ("繁體中文", "zh-TW", "總覽"),
        ("日本語", "ja", "概要"),
        ("English", "en", "OVERVIEW"),
        ("简体中文", "zh", "概览"),
    ):
        select_language(page, label)
        html_lang = page.evaluate("() => document.documentElement.lang")
        nav = page.eval_on_selector_all(".top-nav button", "els => els.map(e => e.textContent.trim())")
        assert html_lang == expected_lang, (label, html_lang)
        assert nav[0] == nav_first, (label, nav)
        assert all(nav), (label, nav)
        languages[expected_lang] = nav

    # 其余断言固定在英文下跑，避免受系统语言影响
    select_language(page, "English")
    page.get_by_role("radio", name="α FIELD", exact=True).click()
    page.wait_for_timeout(250)
    settings_page = page.locator('main[aria-label="Config"]')
    settings_page.evaluate("node => { node.dataset.mountProbe = 'settings'; }")

    # 概览：hero 标题 + 五张客户端卡片
    page.get_by_role("button", name="OVERVIEW", exact=True).click()
    page.locator(".hero h1").wait_for()
    assert settings_page.get_attribute("data-mount-probe") == "settings"
    overview_page = page.locator('main[aria-label="OVERVIEW"]')
    overview_page.evaluate("node => { node.dataset.mountProbe = 'overview'; }")
    assert page.locator(".socket-card").count() == 5
    assert page.locator(".socket-title small").count() == 4
    assert page.locator(".socket-title small").all_inner_texts() == [
        "(EXPERIMENTAL)",
        "(EXPERIMENTAL)",
        "(EXPERIMENTAL)",
        "(EXPERIMENTAL)",
    ]
    assert page.locator(".meter").count() == 1  # DIVERGENCE METER
    assert "0.529341" in page.locator(".meter-cell").nth(1).inner_text()
    assert "RESET 00:00" in page.locator(".meter-cell").nth(1).inner_text()

    # 密钥页：三个方案行，展开首行
    page.get_by_role("button", name="KEYS", exact=True).click()
    page.get_by_role("heading", name="Attractor Fields", exact=True).wait_for()
    assert page.locator(".keyring-row").count() == 3
    assert page.locator(".keyring-tools button").count() == 6
    assert page.locator(".keyring-assign").count() == 3
    assert page.locator(".keyring-assign").first.inner_text() == "ASSIGN"
    assert page.locator(".keyring-row").first.evaluate(
        "node => getComputedStyle(node).animationName"
    ) == "none"
    assert page.locator(".keyring-group-head").count() == 2
    assert page.locator(".keyring-group-tools").count() == 2
    assert "1.25B" in page.locator(".keyring-row").first.inner_text()
    first_group_toggle = page.locator(".keyring-group-toggle").first
    assert first_group_toggle.get_attribute("aria-expanded") == "true"
    first_group_toggle.click()
    page.wait_for_function("() => document.querySelectorAll('.keyring-row').length === 1")
    assert first_group_toggle.get_attribute("aria-expanded") == "false"
    first_group_toggle.click()
    page.wait_for_function("() => document.querySelectorAll('.keyring-row').length === 3")
    key_columns = page.evaluate(
        """
        () => [...document.querySelectorAll('.keyring-head')].map(head => [
          ...head.querySelectorAll('.keyring-usage, .health-bars, .keyring-stat, .keyring-tools'),
        ].map(node => Math.round(node.getBoundingClientRect().left)))
        """
    )
    assert len({tuple(column) for column in key_columns}) == 1, key_columns
    page.screenshot(path=str(OUTPUT_DIR / "keyring-1280x800.png"), full_page=False)
    page.set_viewport_size({"width": 1000, "height": 620})
    page.wait_for_timeout(100)
    assert page.evaluate("() => document.body.scrollWidth === innerWidth")
    page.screenshot(path=str(OUTPUT_DIR / "keyring-1000x620.png"), full_page=False)
    page.locator(".keyring-head").first.click()
    page.locator(".keyring-expand.open").wait_for()
    page.wait_for_timeout(350)
    assert page.evaluate(
        "() => [...document.querySelectorAll('.keyring-actions')].every(node => node.scrollWidth <= node.clientWidth)"
    )
    page.screenshot(path=str(OUTPUT_DIR / "keyring-expanded-1000x620.png"), full_page=False)
    page.locator(".keyring-expand.open").get_by_role("button", name="COPY", exact=True).click()
    page.wait_for_function("() => document.querySelectorAll('.keyring-row').length === 4")
    expanded = page.locator(".keyring-expand.open")
    assert expanded.count() == 1
    expanded_name = expanded.locator("xpath=ancestor::article").locator(".keyring-name strong").inner_text()
    assert "副本" in expanded_name
    page.keyboard.press("Escape")
    assert expanded.count() == 0
    page.set_viewport_size({"width": 1280, "height": 800})

    # 放弃新建方案后，应用背景必须恢复交互
    page.get_by_role("button", name="NEW", exact=True).first.click()
    editor = page.get_by_role("dialog", name="New connection profile")
    editor.wait_for()
    assert editor.get_by_role("combobox", name="API protocol").input_value() == "openai-responses"
    editor.get_by_role("textbox", name="Profile name", exact=True).fill("discard regression")
    editor.get_by_role("button", name="CANCEL", exact=True).click()
    discard = page.get_by_role("alertdialog", name="Discard unsaved changes?")
    discard.get_by_role("button", name="DISCARD", exact=True).click()
    assert editor.count() == 0
    assert page.locator(".topbar").evaluate(
        "node => !node.inert && node.getAttribute('aria-hidden') === null"
    )
    assert page.get_by_role("main", name="Attractor Fields").evaluate(
        "node => !node.inert && node.getAttribute('aria-hidden') === null"
    )

    # 原生拖放：悬停到目标下半区时先预览顺序，落下后仍须保留到末尾。
    page.get_by_role("button", name="KEYS", exact=True).click()
    page.get_by_role("heading", name="Attractor Fields", exact=True).wait_for()
    profile_rows = page.locator(".keyring-row")

    # 相邻下移：预览换位后鼠标会落到源行，松手仍须提交已经显示的顺序。
    adjacent_source_id = profile_rows.first.get_attribute("data-flip-id")
    adjacent_target_id = profile_rows.nth(1).get_attribute("data-flip-id")
    assert adjacent_source_id is not None and adjacent_target_id is not None
    adjacent_source = page.locator(f'.keyring-row[data-flip-id="{adjacent_source_id}"]')
    adjacent_target = page.locator(f'.keyring-row[data-flip-id="{adjacent_target_id}"]')
    adjacent_box = adjacent_target.bounding_box()
    assert adjacent_box is not None
    adjacent_x = adjacent_box["x"] + adjacent_box["width"] / 2
    adjacent_y = adjacent_box["y"] + adjacent_box["height"] - 2
    adjacent_transfer = page.evaluate_handle("new DataTransfer()")
    adjacent_source.dispatch_event("dragstart", {"dataTransfer": adjacent_transfer})
    adjacent_target.dispatch_event("dragover", {
        "dataTransfer": adjacent_transfer,
        "clientX": adjacent_x,
        "clientY": adjacent_y,
    })
    page.wait_for_function(
        "id => document.querySelectorAll('.keyring-row')[1]?.dataset.flipId === id",
        arg=adjacent_source_id,
    )
    adjacent_source.dispatch_event("dragover", {
        "dataTransfer": adjacent_transfer,
        "clientX": adjacent_x,
        "clientY": adjacent_y,
    })
    adjacent_source.dispatch_event("drop", {
        "dataTransfer": adjacent_transfer,
        "clientX": adjacent_x,
        "clientY": adjacent_y,
    })
    adjacent_source.dispatch_event("dragend", {"dataTransfer": adjacent_transfer})
    page.wait_for_function(
        "([first, second]) => { const rows = document.querySelectorAll('.keyring-row'); return rows[0]?.dataset.flipId === first && rows[1]?.dataset.flipId === second; }",
        arg=[adjacent_target_id, adjacent_source_id],
    )

    profile_rows = page.locator(".keyring-row")
    source_id = profile_rows.first.get_attribute("data-flip-id")
    target_id = profile_rows.last.get_attribute("data-flip-id")
    assert source_id is not None and target_id is not None
    source_row = page.locator(f'.keyring-row[data-flip-id="{source_id}"]')
    target_row = page.locator(f'.keyring-row[data-flip-id="{target_id}"]')
    source_name = source_row.locator(".keyring-name strong").inner_text()
    target_box = target_row.bounding_box()
    assert target_box is not None
    profile_transfer = page.evaluate_handle("new DataTransfer()")
    source_row.dispatch_event("dragstart", {"dataTransfer": profile_transfer})
    target_row.dispatch_event("dragover", {
        "dataTransfer": profile_transfer,
        "clientY": target_box["y"] + target_box["height"] - 2,
    })
    target_row.wait_for(state="attached")
    page.wait_for_timeout(100)
    assert "drop-after" in target_row.get_attribute("class")
    assert profile_rows.last.locator(".keyring-name strong").inner_text() == source_name
    target_row.dispatch_event("drop", {
        "dataTransfer": profile_transfer,
        "clientY": target_box["y"] + target_box["height"] - 2,
    })
    source_row.dispatch_event("dragend", {"dataTransfer": profile_transfer})
    page.wait_for_function(
        "name => document.querySelector('.keyring-row:last-of-type .keyring-name strong')?.textContent.trim() === name",
        arg=source_name,
    )

    group_heads = page.locator(".keyring-group-head")
    first_group_id = group_heads.first.get_attribute("data-flip-id")
    second_group_id = group_heads.nth(1).get_attribute("data-flip-id")
    assert first_group_id is not None and second_group_id is not None
    first_group = page.locator(f'.keyring-group-head[data-flip-id="{first_group_id}"]')
    second_group = page.locator(f'.keyring-group-head[data-flip-id="{second_group_id}"]')
    first_group_name = first_group.locator(".keyring-group-toggle strong").inner_text()
    second_box = second_group.bounding_box()
    assert second_box is not None
    group_transfer = page.evaluate_handle("new DataTransfer()")
    first_group.locator(".keyring-group-grip").dispatch_event(
        "dragstart", {"dataTransfer": group_transfer},
    )
    second_group.dispatch_event("dragover", {
        "dataTransfer": group_transfer,
        "clientY": second_box["y"] + second_box["height"] - 2,
    })
    page.wait_for_timeout(100)
    assert "drop-after" in second_group.get_attribute("class")
    assert group_heads.last.locator(".keyring-group-toggle strong").inner_text() == first_group_name
    first_group.dispatch_event("dragover", {
        "dataTransfer": group_transfer,
        "clientY": second_box["y"] + second_box["height"] - 2,
    })
    first_group.dispatch_event("drop", {
        "dataTransfer": group_transfer,
        "clientY": second_box["y"] + second_box["height"] - 2,
    })
    first_group.locator(".keyring-group-grip").dispatch_event(
        "dragend", {"dataTransfer": group_transfer},
    )
    page.wait_for_function(
        "name => [...document.querySelectorAll('.keyring-group-toggle strong')].at(-1)?.textContent.trim() === name",
        arg=first_group_name,
    )
    page.get_by_role("button", name="OVERVIEW", exact=True).click()
    page.locator(".hero h1").wait_for()
    assert overview_page.get_attribute("data-mount-probe") == "overview"

    # 动态：实时请求流（活跃请求徽标会并入按钮可访问名，不能精确匹配）
    page.locator(".top-nav").get_by_role("button", name="STREAM").click()
    stream = page.get_by_role("main", name="Stream", exact=True)
    stream.get_by_role("heading", name="Stream", exact=True).wait_for()
    assert stream.evaluate("node => getComputedStyle(node).getPropertyValue('--cool').trim().toUpperCase()") == "#1F5F6B"
    assert page.locator(".request-row").count() == 3
    assert stream.locator(".request-transport").count() == 3
    assert stream.locator(".request-model small").count() == 0
    assert stream.locator(".request-reasoning").count() == 3
    assert stream.locator(".request-time").count() == 3
    assert stream.locator(".request-state-label").count() == 0
    assert stream.locator(".request-timing small[title]").count() == 0
    assert stream.locator(".request-row [data-hint]").count() == 0
    assert stream.locator(".request-row").first.evaluate(
        "node => getComputedStyle(node).animationName"
    ) == "none"
    assert "LAST 3 DAYS" in stream.locator(".head-note").inner_text()
    page.get_by_role("radio", name="DONE", exact=True).click()
    assert page.locator(".request-row .tint-complete").count() == 1
    page.screenshot(path=str(OUTPUT_DIR / "activity-complete-1280x800.png"), full_page=False)
    page.get_by_role("radio", name="FAIL", exact=True).click()
    assert page.locator(".request-row").count() == 1
    page.get_by_role("radio", name="ALL", exact=True).click()

    # 状态：固定时钟倒计时、四级状态与行尾切换按钮
    page.get_by_role("button", name="STATUS", exact=True).click()
    status = page.get_by_role("main", name="CHANNEL STATUS", exact=True)
    status.get_by_role("heading", name="CHANNEL STATUS", exact=True).wait_for()
    console_text = status.locator(".status-console").inner_text()
    assert console_text.count("AUTO PROBE") == 1
    assert re.search(r"\b\d{1,3}s\b", console_text), console_text
    assert status.locator(".status-row-action").count() == page.locator(".status-row").count()
    assert status.locator(".status-row.current").count() == 0
    assert status.locator(".status-row-availability").count() == 0
    assert status.locator(".status-row-p95").count() == page.locator(".status-row").count()
    assert status.locator(".status-row-name small").count() == 0
    assert status.locator(".status-row-action .assigned").count() == 1
    assert status.locator(".status-row-latency small").count() == 0
    assert status.locator(".status-row").nth(1).evaluate(
        "node => getComputedStyle(node).backgroundColor"
    ) != status.locator(".status-row").nth(2).evaluate(
        "node => getComputedStyle(node).backgroundColor"
    )
    assert status.evaluate("node => getComputedStyle(node).getPropertyValue('--cool').trim().toUpperCase()") == "#1F5F6B"
    assert status.evaluate(
        "() => [...document.querySelectorAll('.status-row')].every(row => row.querySelectorAll('.status-pulse-bar').length === 30)"
    )
    assert "RESPONSES" not in status.locator(".status-table").inner_text()
    page.set_viewport_size({"width": 1000, "height": 620})
    page.wait_for_timeout(700)
    assert status.locator(".status-table").evaluate("node => node.scrollWidth <= node.clientWidth")
    page.screenshot(path=str(OUTPUT_DIR / "status-1000x620.png"), full_page=False)
    page.set_viewport_size({"width": 1280, "height": 800})

    # 钱包：紧凑操作列、Sub2API 登录态导入，以及同名分组选择。
    page.get_by_role("button", name="WALLET", exact=True).click()
    wallet = page.get_by_role("main", name="Wallet", exact=True)
    wallet.get_by_role("heading", name="Wallet", exact=True).wait_for()
    assert wallet.locator(".wallet-row").count() == 3
    assert wallet.locator('.wallet-row').first.locator('button[data-hint="Import keys"]').count() == 1
    page.set_viewport_size({"width": 1000, "height": 620})
    page.wait_for_timeout(100)
    assert wallet.locator(".wallet-table").evaluate("node => node.scrollWidth <= node.clientWidth")
    assert wallet.locator(".wallet-actions").evaluate_all(
        "nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)"
    )
    page.screenshot(path=str(OUTPUT_DIR / "wallet-1000x620.png"), full_page=False)
    import_button = wallet.locator('.wallet-row').first.locator('button[data-hint="Import keys"]')
    import_button.click()
    page.get_by_text(re.compile(r"Imported into .*1 new")).wait_for()
    import_button.click()
    conflict = page.get_by_role("dialog", name="Group already exists")
    conflict.wait_for()
    conflict.get_by_role("button", name="CANCEL", exact=True).click()
    assert conflict.count() == 0
    page.get_by_role("button", name="KEYS", exact=True).click()
    assert page.locator(".keyring-group-head", has_text="主力余额").count() == 1
    page.set_viewport_size({"width": 1280, "height": 800})

    # 动态页常驻；切走再回来，筛选不会重置。
    page.locator(".top-nav").get_by_role("button", name="STREAM").click()
    page.get_by_role("radio", name="DONE", exact=True).click()
    page.get_by_role("button", name="STATUS", exact=True).click()
    page.locator(".top-nav").get_by_role("button", name="STREAM").click()
    assert page.get_by_role("radio", name="DONE", exact=True).get_attribute("aria-checked") == "true"
    page.get_by_role("radio", name="ALL", exact=True).click()

    # 会话：默认保留更新时间和 ID 尾号，选中后才计算消息数且时间不消失
    page.get_by_role("button", name="Sessions", exact=True).click()
    page.locator(".sessions-page").wait_for()
    first_session = page.locator(".index-item").first
    assert "f784efa6" in first_session.locator(".index-main code").inner_text()
    assert first_session.locator(".index-count .rolling").count() == 0
    first_session.click()
    first_session.locator(".index-count .rolling").wait_for()
    assert first_session.locator(".index-when").is_visible()
    session_columns = page.evaluate(
        """
        () => [...document.querySelectorAll('.index-item')].map(item => ({
          side: Math.round(item.querySelector('.index-side').getBoundingClientRect().left),
          when: Math.round(item.querySelector('.index-when').getBoundingClientRect().right),
          total: Math.round(item.querySelector('.index-message-total').getBoundingClientRect().left),
        }))
        """
    )
    assert len({row["side"] for row in session_columns}) == 1, session_columns
    assert len({row["when"] for row in session_columns}) == 1, session_columns
    assert len({row["total"] for row in session_columns}) == 1, session_columns
    page.screenshot(path=str(OUTPUT_DIR / "sessions-selected-1280x800.png"), full_page=False)
    page.set_viewport_size({"width": 1000, "height": 620})
    page.wait_for_timeout(100)
    assert page.evaluate("() => document.body.scrollWidth === innerWidth")
    session_shell = page.evaluate(
        """
        () => ({
          topbarRight: Math.round(document.querySelector('.topbar').getBoundingClientRect().right),
          portRight: Math.round(document.querySelector('.port-chip').getBoundingClientRect().right),
          footerRight: Math.round(document.querySelector('.status-footer').getBoundingClientRect().right),
          viewportRight: innerWidth,
        })
        """
    )
    assert session_shell["topbarRight"] == session_shell["viewportRight"], session_shell
    assert session_shell["portRight"] <= session_shell["viewportRight"], session_shell
    assert session_shell["footerRight"] == session_shell["viewportRight"], session_shell
    page.screenshot(path=str(OUTPUT_DIR / "sessions-selected-1000x620.png"), full_page=False)
    page.set_viewport_size({"width": 1280, "height": 800})

    # 设置
    page.get_by_role("button", name="CONFIG", exact=True).click()
    page.get_by_role("heading", name="Config", exact=True).wait_for()
    assert page.get_by_text("Codex tool bridge").count() == 0
    assert page.locator(".settings-row-copy small").count() == 0
    assert page.get_by_text("Current version 1.9.0", exact=True).is_visible()

    # 深色主题恢复原有的高对比信息蓝。
    page.get_by_role("radio", name="β FIELD", exact=True).click()
    page.wait_for_timeout(250)
    page.set_viewport_size({"width": 1000, "height": 620})
    page.get_by_role("button", name="STATUS", exact=True).click()
    dark_status = page.get_by_role("main", name="CHANNEL STATUS", exact=True)
    dark_status.locator(".status-table").wait_for()
    page.wait_for_timeout(500)
    assert dark_status.evaluate(
        "node => getComputedStyle(node).getPropertyValue('--cool').trim().toUpperCase()"
    ) == "#00B3FF"
    page.screenshot(path=str(OUTPUT_DIR / "status-dark-1000x620.png"), full_page=False)
    page.locator(".top-nav").get_by_role("button", name="STREAM").click()
    dark_stream = page.get_by_role("main", name="Stream", exact=True)
    dark_stream.locator(".request-row").first.wait_for()
    page.wait_for_timeout(500)
    assert dark_stream.evaluate(
        "node => getComputedStyle(node).getPropertyValue('--cool').trim().toUpperCase()"
    ) == "#00B3FF"
    page.screenshot(path=str(OUTPUT_DIR / "activity-dark-1000x620.png"), full_page=False)

    page.get_by_role("button", name="OVERVIEW", exact=True).click()
    layouts = {
        "wide": assert_layout(page, 1280, 800, "overview-1280x800"),
        "compact": assert_layout(page, 1000, 620, "overview-1000x620"),
    }

    sys.stdout.write(json.dumps(
        {"layouts": layouts, "languages": languages, "console_errors": console_errors},
        ensure_ascii=False,
    ) + "\n")
    assert not console_errors
    browser.close()

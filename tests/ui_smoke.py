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

    # 概览：hero 标题 + 四张客户端卡片
    page.get_by_role("button", name="OVERVIEW", exact=True).click()
    page.locator(".hero h1").wait_for()
    assert page.locator(".socket-card").count() == 4
    assert page.locator(".socket-title small").count() == 3
    assert page.locator(".socket-title small").all_inner_texts() == [
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
    assert "1.25B" in page.locator(".keyring-row").first.inner_text()
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
    page.get_by_role("button", name="OVERVIEW", exact=True).click()
    page.locator(".hero h1").wait_for()

    # 动态：实时请求流（活跃请求徽标会并入按钮可访问名，不能精确匹配）
    page.locator(".top-nav").get_by_role("button", name="STREAM").click()
    stream = page.get_by_role("main", name="Stream", exact=True)
    stream.get_by_role("heading", name="Stream", exact=True).wait_for()
    assert page.locator(".request-row").count() == 3
    assert "LAST 3 DAYS" in stream.locator(".head-note").inner_text()
    page.get_by_role("radio", name="DONE", exact=True).click()
    assert page.locator(".request-row .tint-complete").count() == 2
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
    assert status.locator(".status-row-name small").count() == 0
    assert "RESPONSES" not in status.locator(".status-table").inner_text()
    page.set_viewport_size({"width": 1000, "height": 620})
    page.wait_for_timeout(700)
    assert status.locator(".status-table").evaluate("node => node.scrollWidth <= node.clientWidth")
    page.screenshot(path=str(OUTPUT_DIR / "status-1000x620.png"), full_page=False)
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
    assert page.get_by_text("Current version 1.7.2", exact=True).is_visible()

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

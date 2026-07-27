"""为 README 拍摄界面截图（浅色与深色主题各一组）。"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUTPUT_DIR = Path(__file__).resolve().parents[1] / "docs" / "images"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5241"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    )
    page = browser.new_page(
        viewport={"width": 1280, "height": 800},
        device_scale_factor=1,
        reduced_motion="reduce",
    )
    page.goto(URL, wait_until="networkidle")
    page.locator(".hero h1").wait_for()

    # README 面向英文读者：先固定英文，之后才能按英文按钮名定位
    page.get_by_role("button", name="设置", exact=True).click()
    page.get_by_role("radio", name="English", exact=True).click()
    page.wait_for_timeout(300)

    def shoot(name: str) -> None:
        toast_close = page.locator(".toast-close")
        if toast_close.count() > 0:
            toast_close.click()
        page.wait_for_timeout(700)  # 等入场动画结束
        assert page.evaluate("() => document.body.scrollWidth === innerWidth")
        page.screenshot(path=str(OUTPUT_DIR / f"{name}.png"), full_page=False)
        print("shot", name)

    for theme, suffix in (("α FIELD", ""), ("β FIELD", "-dark")):
        page.get_by_role("button", name="CONFIG", exact=True).click()
        page.get_by_role("radio", name=theme, exact=True).click()
        page.wait_for_timeout(300)

        page.get_by_role("button", name="OVERVIEW", exact=True).click()
        shoot(f"overview{suffix}")

        page.get_by_role("button", name="WALLET", exact=True).click()
        page.get_by_role("heading", name="Wallet", exact=True).wait_for()
        shoot(f"wallet{suffix}")

        page.get_by_role("button", name="KEYS", exact=True).click()
        page.get_by_role("heading", name="Attractor Fields", exact=True).wait_for()
        shoot(f"keyring{suffix}")

        page.get_by_role("button", name="STATUS", exact=True).click()
        page.get_by_role("heading", name="CHANNEL STATUS", exact=True).wait_for()
        shoot(f"status{suffix}")

        page.locator(".top-nav").get_by_role("button", name="STREAM").click()
        page.get_by_role("heading", name="Stream", exact=True).wait_for()
        shoot(f"activity{suffix}")

        page.get_by_role("button", name="CONFIG", exact=True).click()
        shoot(f"settings{suffix}")

    browser.close()

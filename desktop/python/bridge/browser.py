"""基于 Playwright（同步 API）驱动本机 Chrome 的登录 / 生图自动化。

为什么用同步 API：Windows 上 asyncio 默认事件循环与 Playwright 子进程存在兼容坑，
而 FastAPI 的同步路由会在线程池中执行（线程内无 running loop），此时 Playwright
sync API 最稳定。每个账号使用独立的 user-data-dir，调用本机 Chrome 二进制
(channel="chrome")，既贴近真人、反检测好，又能多账号隔离。
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import Callable, List, Optional, Tuple
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

from .providers import get_provider

CHROME_CHANNEL = "chrome"
_LAUNCH_ARGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
]
_VIEWPORT = {"width": 1360, "height": 900}

# 结果图最小字节数：过滤站点 logo / 头像 / 图标 / 表情等无关小图。
# AI 生成的 512–1024 图通常 > 100KB，取 50KB 作为安全下限。
MIN_RESULT_BYTES = 50_000


def _ensure_proactor_loop() -> None:
    """Windows 上 uvicorn 会把 asyncio 事件循环策略设成 Selector，而 Selector 循环
    不支持子进程（Playwright 启动浏览器需要），会抛 NotImplementedError。这里在调用
    Playwright 前把策略切回 Proactor——只影响之后新建的事件循环，不动 uvicorn 已在
    运行的主循环。"""
    if sys.platform != "win32":
        return
    try:
        policy = asyncio.get_event_loop_policy()
        if not isinstance(policy, asyncio.WindowsProactorEventLoopPolicy):
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass


def _has_session(context, session_cookies) -> bool:
    names = {c.get("name") for c in context.cookies()}
    return any(s in names for s in session_cookies)


def _launch(p, user_data_dir: str, headless: bool):
    return p.chromium.launch_persistent_context(
        user_data_dir,
        channel=CHROME_CHANNEL,
        headless=headless,
        args=_LAUNCH_ARGS,
        viewport=_VIEWPORT,
    )


def open_login(user_data_dir: str, platform: str, timeout_s: int = 240) -> bool:
    """打开有界面的 Chrome 让用户手动登录；检测到登录态即返回 True。"""
    _ensure_proactor_loop()
    prov = get_provider(platform)
    if not prov:
        raise ValueError(f"未知平台：{platform}")
    with sync_playwright() as p:
        context = _launch(p, user_data_dir, headless=False)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(prov["home"], wait_until="domcontentloaded")
            deadline = time.time() + timeout_s
            while time.time() < deadline:
                if _has_session(context, prov["session_cookies"]):
                    time.sleep(1.0)  # 等 cookie 落盘
                    return True
                time.sleep(2)
            return False
        finally:
            context.close()


def check_login(user_data_dir: str, platform: str) -> bool:
    """无界面快速检测登录态。"""
    _ensure_proactor_loop()
    prov = get_provider(platform)
    if not prov:
        raise ValueError(f"未知平台：{platform}")
    with sync_playwright() as p:
        context = _launch(p, user_data_dir, headless=True)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(prov["home"], wait_until="domcontentloaded")
            time.sleep(2)
            return _has_session(context, prov["session_cookies"])
        finally:
            context.close()


def _fill_prompt(page, selectors, prompt: str) -> bool:
    for sel in selectors:
        try:
            el = page.wait_for_selector(sel, timeout=2500, state="visible")
        except Exception:
            el = None
        if not el:
            continue
        try:
            el.click()
            tag = (el.evaluate("e => e.tagName") or "").lower()
            if tag in ("textarea", "input"):
                el.fill(prompt)
            else:
                page.keyboard.type(prompt, delay=5)
            return True
        except Exception:
            continue
    return False


def _submit(page, selectors) -> None:
    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el:
                el.click()
                return
        except Exception:
            continue
    try:
        page.keyboard.press("Enter")
    except Exception:
        pass


def _grab_dom_images(
    page, context, min_bytes: int, max_n: int = 6
) -> List[Tuple[str, bytes]]:
    """DOM 兜底：下载页面上所有 http 图片，返回达标的若干张 (url, bytes)，按体积降序。

    不依赖具体 selector / 域名——只要页面已渲染出结果图，这里就能把它们抓回。
    """
    try:
        srcs = page.eval_on_selector_all(
            "img",
            "els => els.map(e => e.currentSrc || e.src)"
            ".filter(s => s && s.startsWith('http'))",
        )
    except Exception:
        srcs = []
    found: List[Tuple[str, bytes]] = []
    seen = set()
    for src in srcs:
        if src in seen:
            continue
        seen.add(src)
        try:
            r = context.request.get(src)
            b = r.body()
            if b and len(b) >= min_bytes:
                found.append((src, b))
        except Exception:
            continue
    found.sort(key=lambda kv: len(kv[1]), reverse=True)
    return found[:max_n]


def generate_images(
    user_data_dir: str,
    platform: str,
    prompt: str,
    timeout_s: int = 180,
    headless: bool = False,
    on_log: Optional[Callable[[str], None]] = None,
    keep_open_s: int = 20,
    settle_s: float = 8.0,
    max_images: int = 6,
    ignore_first_s: float = 5.0,
    min_wait_s: float = 15.0,
) -> List[Tuple[str, bytes]]:
    """自动化生图：填提示词 → 提交 → 收集结果图（可多张）。

    返回候选 [(url, body), ...]，按 (命中字节CDN, 体积) 降序、去重、最多 max_images 张。

    鲁棒性措施：
    - 提交后才收集，且「提交初期 ignore_first_s 内出现的非 CDN 图」直接忽略——
      豆包等平台提交后会先冒出加载 / 占位 / UI 图标，它们不是结果；
    - 至少收集到提交后 min_wait_s，给平台真正生成留足时间，避免过早拿到中间图；
    - 收尾再跑一次 DOM 兜底，把页面已渲染的图并入，避免网络层漏抓；
    - 选择时 CDN 命中优先、其次体积最大；日志打印各候选域名，便于联调精确匹配。

    等待期间必须用 page.wait_for_timeout（而非 time.sleep）来派发 response 事件回调。

    on_log: 进度回调。keep_open_s: 未出图时保留窗口秒数。settle_s: 收尾收集时长。
    """
    _ensure_proactor_loop()
    prov = get_provider(platform)
    if not prov:
        raise ValueError(f"未知平台：{platform}")

    def _log(msg: str) -> None:
        if on_log:
            try:
                on_log(msg)
            except Exception:
                pass

    patterns = prov.get("result_url_patterns", [])
    candidates: dict = {}  # url -> (body, matched)
    submit_t = [0.0]  # 提交时刻（列表以便闭包内可写）；为 0 时表示尚未提交、不收集

    def _consider(url: str, body: Optional[bytes]) -> None:
        if not body or len(body) < MIN_RESULT_BYTES or url in candidates:
            return
        matched = any(k in url for k in patterns)
        try:
            host = urlparse(url).netloc
        except Exception:
            host = ""
        # 提交初期冒出的非 CDN 图多为加载 / 占位 / UI 图标，忽略
        if submit_t[0] and not matched and (time.time() - submit_t[0]) < ignore_first_s:
            _log(f"忽略初期图（{len(body) // 1024} KB · {host}）")
            return
        candidates[url] = (body, matched)
        _log(
            f"候选 #{len(candidates)}：约 {len(body) // 1024} KB · {host}"
            f"{'（CDN 命中）' if matched else ''}"
        )

    with sync_playwright() as p:
        _log("启动本机 Chrome…")
        context = _launch(p, user_data_dir, headless=headless)
        page = context.pages[0] if context.pages else context.new_page()

        def on_response(resp):
            if not submit_t[0]:
                return
            try:
                ct = resp.headers.get("content-type", "")
                if ct.startswith("image/"):
                    _consider(resp.url, resp.body())
            except Exception:
                pass

        page.on("response", on_response)

        try:
            _log("打开站点首页，检测登录态…")
            page.goto(prov["home"], wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
            if not _has_session(context, prov["session_cookies"]):
                raise RuntimeError("该账号未登录或登录态已失效，请先在「账号」页重新登录。")

            _log("打开生图页…")
            page.goto(prov["generate_url"], wait_until="domcontentloaded")
            page.wait_for_timeout(3000)

            _log("填写提示词…")
            if not _fill_prompt(page, prov["prompt_selectors"], prompt):
                raise RuntimeError(
                    "未找到提示词输入框：页面结构可能已变化，"
                    f"请在 bridge/providers.py 调整 [{platform}].prompt_selectors。"
                )

            page.wait_for_timeout(500)
            _log("提交生成请求…")
            submit_t[0] = time.time()  # 提交后才开始收集结果图
            _submit(page, prov["submit_selectors"])

            _log(f"等待结果图（最短 {min_wait_s:.0f}s · 最长 {timeout_s}s）…")
            deadline = submit_t[0] + timeout_s
            settle_from: Optional[float] = None
            while time.time() < deadline:
                elapsed = time.time() - submit_t[0]
                if elapsed >= min_wait_s and candidates:
                    if settle_from is None:
                        settle_from = time.time()
                        _log(f"已收集 {elapsed:.0f}s，再 {settle_s:.0f}s 收尾…")
                    elif time.time() - settle_from >= settle_s:
                        break
                # 必须用 Playwright 的等待来派发 response 事件回调（关键修复）
                page.wait_for_timeout(1000)

            # 收尾兜底：把页面已渲染的图并入，避免网络层漏抓真图
            _log("收尾：从页面 DOM 补充候选…")
            for url, body in _grab_dom_images(page, context, MIN_RESULT_BYTES, max_images):
                _consider(url, body)

            if not candidates and not headless and keep_open_s > 0:
                _log(
                    f"未捕获到结果图，保留浏览器窗口 {keep_open_s}s 供你观察。"
                    "若页面其实已出图，请把上方日志（含各候选域名）发我。"
                )
                page.wait_for_timeout(keep_open_s * 1000)
        finally:
            context.close()

    if not candidates:
        raise RuntimeError(
            "未捕获到结果图。可能：①发送按钮未命中、未真正生成；"
            "②积分不足 / 生成较慢（可调大 min_wait_s）；③结果图体积过小。"
        )

    items = sorted(
        candidates.items(), key=lambda kv: (kv[1][1], len(kv[1][0])), reverse=True
    )[:max_images]
    _log(f"共获取 {len(items)} 张候选图")
    return [(url, body) for url, (body, _m) in items]

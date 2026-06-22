"""平台页面配置（即梦 / 豆包）。

把易变的页面细节集中在这里，登录后若页面结构变化，只需调整本文件即可，
无需改动 browser.py 的自动化逻辑。

各字段说明：
- home               站点首页（用于登录与登录态检测）
- generate_url       生图页地址
- session_cookies    判断"已登录"的 cookie 名候选（字节系常见 sessionid 等）
- prompt_selectors   提示词输入框的候选选择器（按顺序尝试）
- submit_selectors   生成/提交按钮候选
- result_image_selectors  结果图在 DOM 中的候选选择器（兜底）
- result_url_patterns     结果图网络响应 URL 里可能包含的关键字（优先靠拦截网络拿原图）
"""

from __future__ import annotations

from typing import Optional

PROVIDERS = {
    "jimeng": {
        "label": "即梦",
        "home": "https://jimeng.jianying.com",
        "generate_url": "https://jimeng.jianying.com/ai-tool/image/generate",
        "session_cookies": ["sessionid", "sessionid_ss", "sid_tt", "sid_guard"],
        "prompt_selectors": [
            "textarea",
            "[contenteditable='true']",
            "div[role='textbox']",
        ],
        "submit_selectors": [
            "button:has-text('生成')",
            "button:has-text('立即生成')",
            "button[type='submit']",
        ],
        "result_image_selectors": [
            "img[src*='byteimg']",
            "img[src*='tos']",
            ".image-card img",
            "img[src^='http']",
        ],
        "result_url_patterns": ["byteimg", "tos-cn", "image", "jimeng"],
    },
    "doubao": {
        "label": "豆包",
        "home": "https://www.doubao.com",
        "generate_url": "https://www.doubao.com/chat/",
        "session_cookies": ["sessionid", "sessionid_ss", "sid_tt", "sid_guard"],
        "prompt_selectors": [
            "textarea",
            "[contenteditable='true']",
            "div[role='textbox']",
        ],
        "submit_selectors": [
            "button:has-text('发送')",
            "button[type='submit']",
            "[data-testid='chat_input_send_button']",
        ],
        "result_image_selectors": [
            "img[src*='byteimg']",
            "img[src*='tos']",
            "img[src^='http']",
        ],
        # 只认字节系图片 CDN 特征；不要放域名自身的 "doubao" 或过宽的 "image"，
        # 否则页面 logo / 头像 / 表情等任意图都会被误判成结果图。
        "result_url_patterns": ["byteimg", "tos", "pstatp"],
    },
}


def get_provider(platform: str) -> Optional[dict]:
    return PROVIDERS.get(platform)

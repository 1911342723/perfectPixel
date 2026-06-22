"""豆包 / 即梦 生图桥接模块。

- store: 账号元数据本地存储与多账号隔离（每账号独立 Chrome user-data-dir）
- providers: 各平台（即梦/豆包）页面配置（URL + selector 候选，便于联调维护）
- browser: 基于 Playwright 驱动本机 Chrome 的登录 / 生图自动化

注意：实际生图依赖目标站点实时页面结构，selector 在 providers.py 中集中维护，
真实登录后可能需要按当前页面微调。仅供个人使用，请遵守对应平台 ToS。
"""

from .store import AccountStore, APP_DIR, OUTPUT_DIR
from .providers import PROVIDERS, get_provider

__all__ = ["AccountStore", "APP_DIR", "OUTPUT_DIR", "PROVIDERS", "get_provider"]

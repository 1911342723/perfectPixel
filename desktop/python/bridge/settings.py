"""应用设置的本地持久化。

存储位置：~/.perfectpixel/settings.json（与账号、生图结果同目录）。
设置项写盘后重启依然有效，避免「重启就没了」。

目前支持：
- output_dir   AI 生图结果的保存目录（默认 ~/.perfectpixel/generated）
"""

from __future__ import annotations

import json
from typing import Any, Dict

from .store import APP_DIR, OUTPUT_DIR

SETTINGS_FILE = APP_DIR / "settings.json"

_DEFAULTS: Dict[str, Any] = {
    "output_dir": str(OUTPUT_DIR),
}

# 仅允许持久化下列已知键，避免写入脏数据
_ALLOWED = set(_DEFAULTS.keys())


def load_settings() -> Dict[str, Any]:
    """读取设置；缺失项用默认值补全。"""
    data: Dict[str, Any] = dict(_DEFAULTS)
    if SETTINGS_FILE.exists():
        try:
            saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                data.update({k: v for k, v in saved.items() if k in _ALLOWED})
        except Exception:
            pass
    if not data.get("output_dir"):
        data["output_dir"] = str(OUTPUT_DIR)
    return data


def save_settings(patch: Dict[str, Any]) -> Dict[str, Any]:
    """合并保存设置，返回保存后的完整设置。"""
    data = load_settings()
    for k, v in patch.items():
        if k in _ALLOWED and v is not None:
            data[k] = v
    APP_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return data


def get_output_dir() -> str:
    """生图结果保存目录（始终返回一个可用路径）。"""
    return load_settings().get("output_dir") or str(OUTPUT_DIR)

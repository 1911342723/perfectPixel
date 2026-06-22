"""账号元数据本地存储 + 多账号隔离。

存储位置：用户目录下 ~/.perfectpixel/
- accounts.json    账号元数据（不含明文凭据）
- accounts/<id>/   每个账号独立的 Chrome user-data-dir（登录态由 Chrome + 系统 DPAPI 保护）
- generated/       生图结果落地目录

安全说明：真正的登录凭据（cookies）保存在各账号的 Chrome user-data-dir 内，
由 Chrome 配合操作系统加密（Windows 上为 DPAPI），不会被本软件上传或明文导出。
"""

from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Optional

APP_DIR = Path.home() / ".perfectpixel"
ACCOUNTS_DIR = APP_DIR / "accounts"
OUTPUT_DIR = APP_DIR / "generated"
DB_FILE = APP_DIR / "accounts.json"

_PLATFORM_LABELS = {"jimeng": "即梦", "doubao": "豆包"}


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _default_name(platform: str) -> str:
    return f"{_PLATFORM_LABELS.get(platform, platform)}账号"


def _ensure_dirs() -> None:
    for d in (APP_DIR, ACCOUNTS_DIR, OUTPUT_DIR):
        d.mkdir(parents=True, exist_ok=True)


class AccountStore:
    """账号池：增删改查 + 为每个账号分配独立的 Chrome 资料目录。"""

    def __init__(self) -> None:
        _ensure_dirs()
        self._accounts = self._load()

    def _load(self) -> list:
        if DB_FILE.exists():
            try:
                return json.loads(DB_FILE.read_text(encoding="utf-8"))
            except Exception:
                return []
        return []

    def _save(self) -> None:
        DB_FILE.write_text(
            json.dumps(self._accounts, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def list(self) -> list:
        return self._accounts

    def get(self, account_id: str) -> Optional[dict]:
        return next((a for a in self._accounts if a["id"] == account_id), None)

    def user_data_dir(self, account_id: str) -> str:
        return str(ACCOUNTS_DIR / account_id)

    def add(self, platform: str, name: Optional[str] = None) -> dict:
        acc = {
            "id": "acc_" + uuid.uuid4().hex[:10],
            "platform": platform,
            "name": name or _default_name(platform),
            "created_at": _now(),
            "last_check": None,
            "status": "unknown",  # unknown / logged_in / logged_out
            "note": "",
        }
        self._accounts.append(acc)
        self._save()
        Path(self.user_data_dir(acc["id"])).mkdir(parents=True, exist_ok=True)
        return acc

    def update(self, account_id: str, **fields) -> Optional[dict]:
        acc = self.get(account_id)
        if not acc:
            return None
        for k, v in fields.items():
            if v is not None:
                acc[k] = v
        self._save()
        return acc

    def remove(self, account_id: str) -> bool:
        acc = self.get(account_id)
        if not acc:
            return False
        self._accounts = [a for a in self._accounts if a["id"] != account_id]
        self._save()
        d = Path(self.user_data_dir(account_id))
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
        return True

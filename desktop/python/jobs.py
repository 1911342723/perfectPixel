"""轻量「后台任务 + 日志」中心（线程版，无需 WebSocket）。

- 长任务（抠图模型下载、视频处理）放到后台线程跑，立即返回 job_id；
- 前端轮询 `/api/job/{id}` 拿进度/阶段/结果，UI 不被阻塞；
- 全局日志环形缓冲，前端轮询 `/api/logs?since=` 增量拉取，展示后端成功/失败。
"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Optional

_LOCK = threading.Lock()
_LOGS: Deque[Dict[str, Any]] = deque(maxlen=600)
_LOG_SEQ = 0
_JOBS: Dict[str, Dict[str, Any]] = {}


def log(msg: str, level: str = "info") -> None:
    """记一条后端日志（level: info / ok / warn / error）。"""
    global _LOG_SEQ
    with _LOCK:
        _LOG_SEQ += 1
        _LOGS.append({"seq": _LOG_SEQ, "ts": time.time(), "level": level, "msg": str(msg)})


def get_logs(since: int = 0) -> Dict[str, Any]:
    with _LOCK:
        items: List[Dict[str, Any]] = [x for x in _LOGS if x["seq"] > int(since)]
        return {"seq": _LOG_SEQ, "logs": items}


def new_job(kind: str) -> str:
    jid = uuid.uuid4().hex[:12]
    with _LOCK:
        _JOBS[jid] = {
            "id": jid,
            "kind": kind,
            "status": "running",  # running / done / error
            "percent": 0.0,
            "stage": "",
            "message": "",
            "result": None,
            "error": None,
            "ts": time.time(),
        }
    # 简单回收：超过 40 个旧 job 时清掉最老的已完成项
    _gc()
    return jid


def _gc() -> None:
    with _LOCK:
        if len(_JOBS) <= 40:
            return
        done = sorted(
            (j for j in _JOBS.values() if j["status"] != "running"),
            key=lambda j: j["ts"],
        )
        for j in done[: len(_JOBS) - 40]:
            _JOBS.pop(j["id"], None)


def update_job(jid: str, **kw: Any) -> None:
    with _LOCK:
        if jid in _JOBS:
            _JOBS[jid].update(kw)


def get_job(jid: str) -> Optional[Dict[str, Any]]:
    with _LOCK:
        j = _JOBS.get(jid)
        return dict(j) if j else None


def run_async(kind: str, target: Callable[[str], Any]) -> str:
    """启动后台线程执行 target(job_id)。返回值写入 job.result；异常写入 job.error。"""
    jid = new_job(kind)

    def _wrap() -> None:
        try:
            res = target(jid)
            update_job(jid, status="done", percent=100.0, result=res, message="完成")
        except Exception as e:  # noqa: BLE001
            log(f"{kind} 失败：{e}", "error")
            traceback.print_exc()
            update_job(jid, status="error", error=str(e), message=f"失败：{e}")

    threading.Thread(target=_wrap, daemon=True).start()
    return jid

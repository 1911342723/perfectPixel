"""一键抠图引擎。

封装 [rembg](https://github.com/danielgatis/rembg)（底层 ONNX Runtime）做背景移除：
- 输入 RGB，输出带软 alpha 的 RGBA；
- 模型按需下载到 `~/.u2net`（首次使用时，体积较大）；
- session 缓存，避免重复加载模型。

抠图得到的是「软 alpha」（边缘半透明、抗锯齿），交给 engine 的
`run_pixelate_rgba(..., alpha_threshold=...)` 做硬化，得到像素图友好的硬边缘。
"""

from __future__ import annotations

import os
import shutil
import urllib.request
from typing import Callable, Dict, List, Optional

import numpy as np
from PIL import Image

try:
    import cv2 as _cv2
except Exception:  # pragma: no cover - 无 cv2 时 decontaminate 原样返回
    _cv2 = None

# 默认 u2net（通用、体积适中）。birefnet-* 质量更高但更大、更慢。
DEFAULT_MODEL = "u2net"

# 暴露给前端的可选模型（名称需与 rembg 支持的一致）
AVAILABLE_MODELS: List[Dict[str, str]] = [
    {"id": "u2net", "label": "U2Net · 通用（默认）"},
    {"id": "u2netp", "label": "U2NetP · 极轻量（快）"},
    {"id": "isnet-general-use", "label": "ISNet · 通用增强"},
    {"id": "silueta", "label": "Silueta · 轻量"},
    {"id": "birefnet-general", "label": "BiRefNet · 高质量（大）"},
    {"id": "birefnet-portrait", "label": "BiRefNet · 人像（大）"},
]

# 各模型下载源（与 rembg 内置一致）。文件统一存为 ~/.u2net/<name>.onnx，
# 用同一 URL 自行带进度下载后，rembg 校验哈希一致即不会重复下载。
MODEL_URLS: Dict[str, str] = {
    "u2net": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx",
    "u2netp": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
    "isnet-general-use": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx",
    "silueta": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx",
    "birefnet-general": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-epoch_244.onnx",
    "birefnet-portrait": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-portrait-epoch_150.onnx",
}

_SESSIONS: Dict[str, object] = {}


def u2net_home() -> str:
    """rembg 模型目录（与其内部逻辑一致）。"""
    return os.path.expanduser(
        os.getenv("U2NET_HOME", os.path.join(os.getenv("XDG_DATA_HOME", "~"), ".u2net"))
    )


def model_path(model: str) -> str:
    return os.path.join(u2net_home(), f"{model}.onnx")


def is_model_ready(model: str) -> bool:
    """模型文件是否已存在（按 >1MB 粗判，避免半截文件）。"""
    p = model_path(model)
    try:
        return os.path.exists(p) and os.path.getsize(p) > 1_000_000
    except OSError:
        return False


def ensure_model(model: str, on_progress: Optional[Callable[[int, int], None]] = None) -> None:
    """确保模型就绪；缺失则下载（带字节进度）。

    on_progress(downloaded_bytes, total_bytes)；total 未知时为 0。
    已知 URL 的模型自行下载以获得精确进度；未知模型回退给 rembg 下载。
    """
    if is_model_ready(model):
        return
    url = MODEL_URLS.get(model)
    home = u2net_home()
    os.makedirs(home, exist_ok=True)

    if not url:
        # 回退：交给 rembg（pooch）下载，无精确进度
        _get_session(model)
        return

    target = model_path(model)
    tmp = target + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "perfectpixel-desktop"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = r.read(262144)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if on_progress:
                on_progress(done, total)
    shutil.move(tmp, target)


def is_available() -> bool:
    """rembg 是否已安装。"""
    try:
        import rembg  # noqa: F401

        return True
    except Exception:
        return False


def providers() -> List[str]:
    """当前 ONNX Runtime 可用的执行后端（用于 UI 显示 GPU/CPU）。"""
    try:
        import onnxruntime as ort

        return list(ort.get_available_providers())
    except Exception:
        return []


def _get_session(model: str):
    try:
        from rembg import new_session
    except Exception as e:  # pragma: no cover
        raise RuntimeError(
            "未安装抠图依赖 rembg。请在 sidecar 的 Python 环境执行：pip install rembg"
        ) from e
    if model not in _SESSIONS:
        _SESSIONS[model] = new_session(model)
    return _SESSIONS[model]


def remove_background(
    rgb: np.ndarray,
    model: str = DEFAULT_MODEL,
    alpha_matting: bool = False,
) -> np.ndarray:
    """移除背景。

    Args:
        rgb: (H, W, 3) uint8 RGB。
        model: rembg 模型名（见 AVAILABLE_MODELS）。
        alpha_matting: 是否启用 alpha matting 精修边缘（更慢、发丝更好）。

    Returns:
        (H, W, 4) uint8 RGBA，含软 alpha。
    """
    from rembg import remove

    session = _get_session(model or DEFAULT_MODEL)
    arr = np.asarray(rgb, dtype=np.uint8)[..., :3]
    img = Image.fromarray(arr, mode="RGB")
    out = remove(
        img,
        session=session,
        alpha_matting=bool(alpha_matting),
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=10,
        alpha_matting_erode_size=10,
    )
    return np.asarray(out.convert("RGBA"), dtype=np.uint8)


def decontaminate(rgba: np.ndarray, fg_threshold: int = 200) -> np.ndarray:
    """去色边 / 收边：用可信前景（alpha 高）的颜色填充其余像素的 RGB，去除抠图边缘
    残留的背景色溢出（color spill / fringe），使 alpha 硬化后边缘呈纯前景色。

    仅改写 RGB、不动 alpha；无 cv2 或图中无明显前景时原样返回（容错，不抛异常）。

    Args:
        rgba: (H, W, 4) uint8。
        fg_threshold: alpha ≥ 此值的像素视为「可信前景」种子（0-255）。
    """
    arr = np.asarray(rgba)
    if _cv2 is None or arr.ndim != 3 or arr.shape[2] != 4:
        return rgba
    out = np.ascontiguousarray(arr, dtype=np.uint8)
    fg = out[..., 3] >= int(fg_threshold)
    if not fg.any() or fg.all():
        return out
    try:
        # 以前景像素为种子(0)，对其余像素求最近前景像素并复用其颜色
        src = np.where(fg, 0, 255).astype(np.uint8)
        _, labels = _cv2.distanceTransformWithLabels(
            src, _cv2.DIST_L2, 5, labelType=_cv2.DIST_LABEL_PIXEL
        )
        rgb = out[..., :3]
        lut = np.zeros((int(labels.max()) + 1, 3), dtype=np.uint8)
        lut[labels[fg]] = rgb[fg]
        out[..., :3] = lut[labels]
    except Exception:  # pragma: no cover - 去色边失败不应影响主流程
        return np.ascontiguousarray(arr, dtype=np.uint8)
    return out

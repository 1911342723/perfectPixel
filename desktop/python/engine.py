"""完美像素引擎封装。

复用仓库根 `src/perfect_pixel` 的核心算法，向上层 FastAPI 提供：
- 从文件路径 / base64 读入 RGB / RGBA 图（用 PIL，兼容 Windows 中文路径）
- 运行完美像素化（支持 RGB 与 RGBA：网格用 RGB 检测，alpha 随网格一起采样）
- 结果转 PNG base64（供前端预览，自动处理透明）
- 最近邻放大导出
"""

from __future__ import annotations

import base64
import io
import sys
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
from PIL import Image

# 复用现有算法内核：把仓库根的 src 加入模块搜索路径
_SRC = Path(__file__).resolve().parents[2] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from perfect_pixel import get_perfect_pixel  # type: ignore  # noqa: E402

# 直接复用内部函数，以便对 RGBA 做「RGB 检测网格 + 多通道采样」
try:
    from perfect_pixel.perfect_pixel import (  # type: ignore  # noqa: E402
        detect_grid_scale,
        refine_grids,
        sample_center,
        sample_majority,
        sample_median,
    )

    _HAS_CORE = True
except Exception:  # pragma: no cover - 无 cv2 时退化
    _HAS_CORE = False

try:
    import cv2  # noqa: F401

    _BACKEND = "opencv"
except Exception:  # pragma: no cover
    _BACKEND = "numpy"


def backend_name() -> str:
    """当前生效的算法后端（opencv / numpy）。"""
    return _BACKEND


# --------------------------------------------------------------------------- #
# 读图
# --------------------------------------------------------------------------- #
def load_rgb_from_path(path: str) -> np.ndarray:
    """从本地文件读入 RGB 数组。用 PIL 以兼容中文路径。"""
    with Image.open(path) as img:
        return np.asarray(img.convert("RGB"))


def load_rgb_from_base64(data: str) -> np.ndarray:
    """从 base64（可带 data: 前缀）读入 RGB 数组。"""
    raw = _b64_to_bytes(data)
    with Image.open(io.BytesIO(raw)) as img:
        return np.asarray(img.convert("RGB"))


def load_rgba_from_path(path: str) -> np.ndarray:
    """从本地文件读入 RGBA 数组（保留/补齐 alpha 通道）。"""
    with Image.open(path) as img:
        return np.asarray(img.convert("RGBA"))


def load_rgba_from_base64(data: str) -> np.ndarray:
    """从 base64 读入 RGBA 数组。"""
    raw = _b64_to_bytes(data)
    with Image.open(io.BytesIO(raw)) as img:
        return np.asarray(img.convert("RGBA"))


def _b64_to_bytes(data: str) -> bytes:
    if "," in data:
        data = data.split(",", 1)[1]
    return base64.b64decode(data)


# --------------------------------------------------------------------------- #
# 输出
# --------------------------------------------------------------------------- #
def _to_pil(arr: np.ndarray) -> Image.Image:
    """numpy 数组 -> PIL 图，自动按通道数选择 RGB / RGBA。"""
    a = np.asarray(arr, dtype=np.uint8)
    if a.ndim == 3 and a.shape[2] == 4:
        return Image.fromarray(a, mode="RGBA")
    return Image.fromarray(a[..., :3] if a.ndim == 3 else a, mode="RGB")


def to_png_base64(arr: np.ndarray) -> str:
    """任意 RGB/RGBA 数组 -> data URL（PNG, base64）。"""
    buf = io.BytesIO()
    _to_pil(arr).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# 兼容旧调用名
def rgb_to_png_base64(rgb: np.ndarray) -> str:
    """RGB/RGBA 数组 -> data URL（PNG, base64）。"""
    return to_png_base64(rgb)


def rgb_to_thumb_base64(rgb: np.ndarray, max_side: int = 640) -> str:
    """原图缩略图 data URL（最长边限制到 max_side），用于前端对比预览。"""
    img = _to_pil(rgb)
    w, h = img.size
    scale = min(1.0, max_side / float(max(w, h)))
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# --------------------------------------------------------------------------- #
# 完美像素化
# --------------------------------------------------------------------------- #
def _fix_square(scaled: np.ndarray, refined_x: int, refined_y: int) -> np.ndarray:
    """与 get_perfect_pixel 一致的「近正方形对齐」修正，泛化到任意通道。"""
    if abs(refined_x - refined_y) != 1:
        return scaled
    if refined_x > refined_y:
        if refined_x % 2 == 1:
            return scaled[:, :-1]
        return np.concatenate([scaled[:1, :], scaled], axis=0)
    if refined_y % 2 == 1:
        return scaled[:-1, :]
    return np.concatenate([scaled[:, :1], scaled], axis=1)


def pixelate_core(
    image: np.ndarray,
    sample_method: str = "center",
    refine_intensity: float = 0.25,
    grid_size: Optional[Tuple[int, int]] = None,
    fix_square: bool = True,
) -> Tuple[Optional[int], Optional[int], np.ndarray]:
    """对 RGB 或 RGBA 图做完美像素化。

    - 网格检测/对齐只用前 3 个通道（RGB）；
    - 采样阶段用全部通道（含 alpha），使 alpha 随网格一起被采样。

    返回 (grid_w, grid_h, out)；检测失败返回 (None, None, image)。
    """
    arr = np.asarray(image)
    if arr.ndim == 2:
        arr = arr[..., None]
    channels = arr.shape[2]

    # 3 通道时直接复用经过验证的 get_perfect_pixel，行为完全一致
    if channels == 3 or not _HAS_CORE:
        w, h, out = get_perfect_pixel(
            np.ascontiguousarray(arr[..., :3]),
            sample_method=sample_method,
            refine_intensity=float(refine_intensity),
            grid_size=grid_size,
            fix_square=fix_square,
            debug=False,
        )
        return w, h, out

    rgb = np.ascontiguousarray(arr[..., :3].astype(np.uint8))
    if grid_size is not None:
        scale_col, scale_row = grid_size
    else:
        scale_col, scale_row = detect_grid_scale(
            rgb, peak_width=6, max_ratio=1.5, min_size=4.0
        )
        if scale_col is None or scale_row is None:
            return None, None, arr

    size_x = int(round(scale_col))
    size_y = int(round(scale_row))
    x_coords, y_coords = refine_grids(rgb, size_x, size_y, float(refine_intensity))
    refined_x = len(x_coords) - 1
    refined_y = len(y_coords) - 1

    samp = np.ascontiguousarray(arr)
    if sample_method == "majority":
        out = sample_majority(samp, x_coords, y_coords)
    elif sample_method == "median":
        out = sample_median(samp, x_coords, y_coords)
    else:
        out = sample_center(samp, x_coords, y_coords)

    if fix_square:
        out = _fix_square(out, refined_x, refined_y)

    h2, w2 = out.shape[:2]
    return int(w2), int(h2), np.asarray(out, dtype=np.uint8)


def pixelate_uniform(
    image: np.ndarray,
    grid_w: int,
    grid_h: int,
    sample_method: str = "center",
) -> np.ndarray:
    """用**严格锁定的均匀网格**采样，输出恒为 (grid_h, grid_w, C)。

    供视频/GIF 逐帧使用：网格完全锁定、不做 per-frame 对齐，保证每帧尺寸一致、
    无像素漂移（这是消除「像素沸腾」的基础）。支持 RGB / RGBA。
    """
    if not _HAS_CORE:
        raise RuntimeError("缺少 opencv 内核，无法进行锁定网格采样。")
    arr = np.ascontiguousarray(np.asarray(image))
    if arr.ndim == 2:
        arr = arr[..., None]
    h, w = arr.shape[:2]
    gw = max(1, int(grid_w))
    gh = max(1, int(grid_h))
    x_coords = np.linspace(0, w, gw + 1)
    y_coords = np.linspace(0, h, gh + 1)
    if sample_method == "majority":
        out = sample_majority(arr, x_coords, y_coords)
    elif sample_method == "median":
        out = sample_median(arr, x_coords, y_coords)
    else:
        out = sample_center(arr, x_coords, y_coords)
    return np.asarray(out, dtype=np.uint8)


def detect_grid(rgb: np.ndarray) -> Tuple[Optional[int], Optional[int]]:
    """仅检测网格尺寸（不采样），返回 (grid_w, grid_h) 或 (None, None)。"""
    if not _HAS_CORE:
        w, h, _ = get_perfect_pixel(np.ascontiguousarray(np.asarray(rgb)[..., :3]))
        return (w, h)
    arr = np.ascontiguousarray(np.asarray(rgb)[..., :3].astype(np.uint8))
    return detect_grid_scale(arr, peak_width=6, max_ratio=1.5, min_size=4.0)


def run_pixelate(
    rgb: np.ndarray,
    sample_method: str = "center",
    refine_intensity: float = 0.25,
    grid_size: Optional[Tuple[int, int]] = None,
) -> Tuple[int, int, np.ndarray]:
    """运行完美像素化（RGB），返回 (grid_w, grid_h, 小图RGB)。失败抛异常。"""
    w, h, out = pixelate_core(rgb, sample_method, refine_intensity, grid_size)
    if w is None or h is None or out is None:
        raise RuntimeError(
            "网格检测失败：可尝试更换采样方式 / 调整细化强度，或手动指定网格尺寸。"
        )
    return int(w), int(h), np.asarray(out, dtype=np.uint8)


def run_pixelate_rgba(
    rgba: np.ndarray,
    sample_method: str = "center",
    refine_intensity: float = 0.25,
    grid_size: Optional[Tuple[int, int]] = None,
    alpha_threshold: Optional[int] = None,
) -> Tuple[int, int, np.ndarray]:
    """运行完美像素化（RGBA），alpha 随网格采样。失败抛异常。

    alpha_threshold: 若给定（0-255），对输出 alpha 做二值化（>=阈值→255，否则→0），
    得到像素化友好的硬边缘。
    """
    w, h, out = pixelate_core(rgba, sample_method, refine_intensity, grid_size)
    if w is None or h is None or out is None:
        raise RuntimeError(
            "网格检测失败：可尝试更换采样方式 / 调整细化强度，或手动指定网格尺寸。"
        )
    out = np.asarray(out, dtype=np.uint8)
    if out.ndim == 3 and out.shape[2] == 4 and alpha_threshold is not None:
        out = harden_alpha(out, int(alpha_threshold))
    return int(w), int(h), out


def harden_alpha(rgba: np.ndarray, threshold: int = 128) -> np.ndarray:
    """把软 alpha 二值化为硬 mask（像素图友好）：alpha>=阈值→255，否则→0。"""
    out = np.array(rgba, dtype=np.uint8)
    a = out[..., 3]
    out[..., 3] = np.where(a >= int(threshold), 255, 0).astype(np.uint8)
    return out


# --------------------------------------------------------------------------- #
# 放大 / 保存
# --------------------------------------------------------------------------- #
def upscale_nearest(arr: np.ndarray, scale: int) -> Image.Image:
    """最近邻整数放大（像素图放大必须用 NEAREST，禁止平滑）。自动处理 RGBA。"""
    scale = max(1, int(scale))
    img = _to_pil(arr)
    w, h = img.size
    return img.resize((w * scale, h * scale), Image.NEAREST)

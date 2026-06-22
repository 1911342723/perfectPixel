"""视频 / GIF 完美像素化引擎。

核心管线（对抗「像素沸腾 / 颜色闪烁」是关键）：

    视频/GIF → 解码抽帧
        → 多帧投票，检测并**锁定网格**（全片复用同一网格）
        → 逐帧**锁定网格重采样**（pixelate_uniform，尺寸恒定、无漂移）
        → （可选）逐帧抠图
        → **共享调色板**（全局统一量化，消除帧间颜色闪烁）
        → 最近邻整数放大
        → 编码导出 GIF / MP4 / APNG

依赖：imageio + imageio-ffmpeg / PyAV（解码视频）、Pillow（GIF/APNG）。
"""

from __future__ import annotations

import contextlib
import io
from pathlib import Path
from typing import Callable, List, Optional, Tuple

import numpy as np
from PIL import Image

import engine

# 读取硬上限（防止超长视频吃满内存），超过后再均匀抽样到 max_frames
_HARD_READ_CAP = 1200
DEFAULT_MAX_FRAMES = 240


@contextlib.contextmanager
def _suppress_stdout():
    """临时屏蔽算法内核的 print（网格检测/逐帧会打印若干行）。

    用 redirect_stdout 在 Python 层换掉 sys.stdout，对 print() 可靠生效
    （fd 级 dup2 对带缓冲的 sys.stdout 不一定拦得住）。
    """
    with contextlib.redirect_stdout(io.StringIO()):
        yield


# --------------------------------------------------------------------------- #
# 解码
# --------------------------------------------------------------------------- #
def _decode_animated_pillow(path: str) -> Tuple[List[np.ndarray], Optional[float]]:
    """用 Pillow 读 GIF / APNG / 动图 WEBP 的所有帧（RGB）。"""
    frames: List[np.ndarray] = []
    durations: List[float] = []
    with Image.open(path) as im:
        n = int(getattr(im, "n_frames", 1))
        for i in range(n):
            im.seek(i)
            frames.append(np.asarray(im.convert("RGB"), dtype=np.uint8))
            durations.append(float(im.info.get("duration", 0) or 0))
            if len(frames) >= _HARD_READ_CAP:
                break
    fps = None
    valid = [d for d in durations if d > 0]
    if valid:
        avg_ms = sum(valid) / len(valid)
        if avg_ms > 0:
            fps = 1000.0 / avg_ms
    return frames, fps


def _decode_video_imageio(path: str) -> Tuple[List[np.ndarray], Optional[float]]:
    """用 imageio（FFmpeg/PyAV）逐帧读视频（RGB）。"""
    import imageio.v3 as iio

    fps: Optional[float] = None
    for plugin in ("pyav", "FFMPEG", None):
        try:
            meta = iio.immeta(path, plugin=plugin) if plugin else iio.immeta(path)
            fps = meta.get("fps") or fps
            if fps:
                break
        except Exception:
            continue

    frames: List[np.ndarray] = []
    last_err: Optional[Exception] = None
    for plugin in ("pyav", "FFMPEG", None):
        try:
            it = iio.imiter(path, plugin=plugin) if plugin else iio.imiter(path)
            for fr in it:
                arr = np.asarray(fr)
                if arr.ndim == 2:
                    arr = np.stack([arr] * 3, axis=-1)
                frames.append(np.ascontiguousarray(arr[..., :3].astype(np.uint8)))
                if len(frames) >= _HARD_READ_CAP:
                    break
            if frames:
                break
        except Exception as e:  # 换下一个后端
            last_err = e
            frames = []
            continue
    if not frames and last_err is not None:
        raise RuntimeError(f"视频解码失败：{last_err}")
    return frames, fps


def decode_frames(
    path: str, max_frames: int = DEFAULT_MAX_FRAMES
) -> Tuple[List[np.ndarray], float]:
    """解码为 RGB 帧列表 + 输出帧率。帧数超过 max_frames 时均匀抽样并按比例修正帧率。"""
    ext = Path(path).suffix.lower()
    if ext in (".gif", ".apng", ".png", ".webp"):
        frames, fps = _decode_animated_pillow(path)
        if not frames:
            frames, fps = _decode_video_imageio(path)
    else:
        frames, fps = _decode_video_imageio(path)

    if not frames:
        raise RuntimeError("未能解码到任何帧，请确认文件格式受支持。")

    total = len(frames)
    if total > max_frames:
        idx = np.linspace(0, total - 1, max_frames).round().astype(int)
        frames = [frames[i] for i in idx]
        if fps:
            fps = fps * (len(frames) / float(total))

    if not fps or fps <= 0:
        fps = 12.0
    return frames, float(fps)


# --------------------------------------------------------------------------- #
# 锁定网格
# --------------------------------------------------------------------------- #
def lock_grid(
    frames: List[np.ndarray],
    manual: Optional[Tuple[int, int]] = None,
    vote_frames: int = 5,
) -> Tuple[Optional[int], Optional[int]]:
    """多帧投票检测网格尺寸（取中位数），全片复用。"""
    if manual and manual[0] and manual[1]:
        return int(manual[0]), int(manual[1])
    n = len(frames)
    sample_idx = sorted({int(x) for x in np.linspace(0, n - 1, min(n, vote_frames))})
    ws: List[int] = []
    hs: List[int] = []
    with _suppress_stdout():
        for i in sample_idx:
            gw, gh = engine.detect_grid(frames[i])
            if gw and gh:
                ws.append(int(gw))
                hs.append(int(gh))
    if not ws:
        return None, None
    return int(round(float(np.median(ws)))), int(round(float(np.median(hs))))


# --------------------------------------------------------------------------- #
# 共享调色板（全局统一量化，消除帧间颜色闪烁）
# --------------------------------------------------------------------------- #
def apply_shared_palette(frames: List[np.ndarray], colors: int = 64) -> List[np.ndarray]:
    """把所有帧映射到一个全局调色板。支持 RGB / RGBA（alpha 原样保留）。"""
    if not frames:
        return frames
    colors = int(max(2, min(256, colors)))
    has_alpha = frames[0].ndim == 3 and frames[0].shape[2] == 4
    rgbs = [np.ascontiguousarray(f[..., :3].astype(np.uint8)) for f in frames]
    alphas = [f[..., 3] for f in frames] if has_alpha else None

    big = np.concatenate(rgbs, axis=0)
    ref = Image.fromarray(big, "RGB").quantize(colors=colors, method=Image.MEDIANCUT)

    out: List[np.ndarray] = []
    for i, rgb in enumerate(rgbs):
        p = Image.fromarray(rgb, "RGB").quantize(palette=ref, dither=Image.Dither.NONE)
        q = np.asarray(p.convert("RGB"), dtype=np.uint8)
        if has_alpha and alphas is not None:
            q = np.dstack([q, alphas[i]])
        out.append(np.ascontiguousarray(q))
    return out


# --------------------------------------------------------------------------- #
# 编码导出
# --------------------------------------------------------------------------- #
def _pad_even(frame: np.ndarray) -> np.ndarray:
    """把宽高补到偶数（H.264 要求），边缘复制，避免黑边。"""
    h, w = frame.shape[:2]
    pad_h = h % 2
    pad_w = w % 2
    if not pad_h and not pad_w:
        return frame
    return np.pad(frame, ((0, pad_h), (0, pad_w), (0, 0)), mode="edge")


def _save_gif(frames: List[np.ndarray], path: str, fps: float, has_alpha: bool) -> None:
    duration = max(20, int(round(1000.0 / max(1e-3, fps))))
    pil_frames: List[Image.Image] = []
    for f in frames:
        if has_alpha:
            rgb = f[..., :3]
            p = Image.fromarray(rgb, "RGB").quantize(colors=255, method=Image.MEDIANCUT)
            arr = np.array(p, dtype=np.uint8)
            transparent = f[..., 3] < 128
            arr[transparent] = 255
            pal = p.getpalette() or []
            pal = (pal + [0] * (256 * 3))[: 256 * 3]
            pal[255 * 3 : 255 * 3 + 3] = [0, 0, 0]
            im = Image.fromarray(arr, "P")
            im.putpalette(pal)
            im.info["transparency"] = 255
            pil_frames.append(im)
        else:
            pil_frames.append(
                Image.fromarray(f[..., :3], "RGB").quantize(colors=256, method=Image.MEDIANCUT)
            )
    save_kwargs = dict(
        save_all=True,
        append_images=pil_frames[1:],
        duration=duration,
        loop=0,
        disposal=2 if has_alpha else 1,
        optimize=False,
    )
    if has_alpha:
        save_kwargs["transparency"] = 255
    pil_frames[0].save(path, **save_kwargs)


def _save_apng(frames: List[np.ndarray], path: str, fps: float, has_alpha: bool) -> None:
    duration = max(20, int(round(1000.0 / max(1e-3, fps))))
    mode = "RGBA" if has_alpha else "RGB"
    pil_frames = [Image.fromarray(f, mode) for f in frames]
    pil_frames[0].save(
        path,
        save_all=True,
        append_images=pil_frames[1:],
        duration=duration,
        loop=0,
        disposal=1,
    )


def _save_mp4(frames: List[np.ndarray], path: str, fps: float) -> None:
    import imageio.v2 as imageio

    rgb_frames = [_pad_even(np.ascontiguousarray(f[..., :3])) for f in frames]
    imageio.mimwrite(
        path,
        rgb_frames,
        fps=max(1.0, float(fps)),
        codec="libx264",
        quality=8,
        macro_block_size=1,
        pixelformat="yuv420p",
    )


def encode(frames: List[np.ndarray], path: str, fps: float, fmt: str) -> None:
    if not frames:
        raise RuntimeError("没有可编码的帧。")
    fmt = (fmt or "gif").lower()
    has_alpha = frames[0].ndim == 3 and frames[0].shape[2] == 4
    if fmt == "gif":
        _save_gif(frames, path, fps, has_alpha)
    elif fmt == "apng":
        _save_apng(frames, path, fps, has_alpha)
    elif fmt in ("mp4", "h264", "video"):
        _save_mp4(frames, path, fps)
    else:
        raise RuntimeError(f"不支持的导出格式：{fmt}")


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def process(
    input_path: str,
    output_path: str,
    *,
    sample_method: str = "center",
    grid_size: Optional[Tuple[int, int]] = None,
    max_frames: int = DEFAULT_MAX_FRAMES,
    fps_out: Optional[float] = None,
    scale: int = 8,
    fmt: str = "gif",
    shared_palette: bool = True,
    palette_size: int = 64,
    matte: bool = False,
    matte_model: str = "u2net",
    alpha_threshold: int = 128,
    progress: Optional[Callable[[int, int, str], None]] = None,
) -> dict:
    """端到端处理视频/GIF 并导出。返回处理摘要（含首帧预览 base64）。"""

    def _tick(done: int, total: int, msg: str) -> None:
        if progress:
            try:
                progress(done, total, msg)
            except Exception:
                pass

    _tick(0, 100, "解码中…")
    frames, fps = decode_frames(input_path, max_frames=max_frames)
    n = len(frames)

    _tick(10, 100, "检测并锁定网格…")
    gw, gh = lock_grid(frames, manual=grid_size)
    if not gw or not gh:
        raise RuntimeError("网格检测失败：请尝试手动指定网格尺寸后重试。")

    small: List[np.ndarray] = []
    if matte:
        import matting

        if not matting.is_available():
            raise RuntimeError("未安装抠图依赖 rembg，无法对视频逐帧抠图。")

    for i, f in enumerate(frames):
        if matte:
            import matting

            rgba = matting.remove_background(f, model=matte_model)
            rgba = matting.decontaminate(rgba)
            s = engine.pixelate_uniform(rgba, gw, gh, sample_method)
            s = engine.harden_alpha(s, alpha_threshold)
        else:
            with _suppress_stdout():
                s = engine.pixelate_uniform(f, gw, gh, sample_method)
        small.append(np.asarray(s, dtype=np.uint8))
        _tick(10 + int(70 * (i + 1) / max(1, n)), 100, f"逐帧像素化 {i + 1}/{n}")

    if shared_palette:
        _tick(82, 100, "构建共享调色板…")
        small = apply_shared_palette(small, colors=palette_size)

    _tick(88, 100, "放大并编码…")
    upscaled = [np.asarray(engine.upscale_nearest(s, scale), dtype=np.uint8) for s in small]

    out_fps = float(fps_out) if fps_out else fps
    encode(upscaled, output_path, out_fps, fmt)

    _tick(100, 100, "完成")

    preview = engine.to_png_base64(small[0]) if small else None
    return {
        "ok": True,
        "output_path": output_path,
        "frames": n,
        "fps": round(out_fps, 3),
        "grid_w": int(gw),
        "grid_h": int(gh),
        "out_w": int(upscaled[0].shape[1]) if upscaled else 0,
        "out_h": int(upscaled[0].shape[0]) if upscaled else 0,
        "fmt": fmt,
        "preview_base64": preview,
    }


def probe(path: str, max_frames: int = DEFAULT_MAX_FRAMES) -> dict:
    """轻量探测：返回帧数（受 max_frames 影响）、帧率、首帧尺寸与预览。"""
    frames, fps = decode_frames(path, max_frames=max_frames)
    h, w = frames[0].shape[:2]
    return {
        "ok": True,
        "frames": len(frames),
        "fps": round(fps, 3),
        "width": int(w),
        "height": int(h),
        "preview_base64": engine.rgb_to_thumb_base64(frames[0]),
    }

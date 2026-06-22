"""进阶冒烟测试：验证 RGBA 完美像素化 + 视频/GIF 管线（不依赖 rembg）。

运行：python _smoke_test_v2.py
"""

import os
import tempfile

import numpy as np
from PIL import Image, ImageFilter

import engine
import video


def _make_anim_gif(path: str, g: int = 32, up: int = 512, n: int = 12) -> None:
    """合成一段「移动方块」的伪 AI 像素动图，存为 GIF。"""
    rng = np.random.default_rng(3)
    base = (rng.integers(0, 4, size=(g, g, 3)) * 60).astype(np.uint8)
    frames = []
    for i in range(n):
        f = base.copy()
        x = 2 + (i % (g - 6))
        f[4:8, x : x + 4] = np.array([240, 80, 80], dtype=np.uint8)
        img = (
            Image.fromarray(f, "RGB")
            .resize((up, up), Image.NEAREST)
            .filter(ImageFilter.GaussianBlur(0.8))
        )
        frames.append(img)
    frames[0].save(
        path, save_all=True, append_images=frames[1:], duration=90, loop=0
    )


def test_rgba_pixelate():
    rng = np.random.default_rng(5)
    g = 32
    small = (rng.integers(0, 4, size=(g, g, 3)) * 70).astype(np.uint8)
    rgb = np.asarray(
        Image.fromarray(small, "RGB").resize((512, 512), Image.NEAREST).filter(
            ImageFilter.GaussianBlur(1.0)
        )
    )
    # 合成一个圆形 alpha（中心不透明、边缘渐隐），验证 alpha 随网格采样 + 硬化
    yy, xx = np.mgrid[0:512, 0:512]
    dist = np.sqrt((xx - 256) ** 2 + (yy - 256) ** 2)
    alpha = np.clip(255 - (dist - 180) * 4, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb, alpha])

    w, h, out = engine.run_pixelate_rgba(
        rgba, sample_method="center", refine_intensity=0.3, alpha_threshold=128
    )
    assert out.shape[2] == 4, "输出应为 RGBA"
    uniq = np.unique(out[..., 3])
    assert set(uniq.tolist()).issubset({0, 255}), f"alpha 应已二值化, got {uniq}"
    assert out[..., 3].max() == 255 and out[..., 3].min() == 0, "应同时存在透明与不透明"
    print(f"[RGBA] grid={w}x{h}, shape={out.shape}, alpha_uniq={uniq.tolist()}  OK")


def test_video_pipeline():
    tmp = tempfile.mkdtemp(prefix="pp_smoke_")
    src = os.path.join(tmp, "anim.gif")
    _make_anim_gif(src)

    pr = video.probe(src)
    assert pr["ok"] and pr["frames"] >= 8, pr
    print(f"[probe] frames={pr['frames']} fps={pr['fps']} size={pr['width']}x{pr['height']}  OK")

    for fmt, ext in [("gif", ".gif"), ("apng", ".png"), ("mp4", ".mp4")]:
        out = os.path.join(tmp, f"out_{fmt}{ext}")
        res = video.process(
            src,
            out,
            sample_method="center",
            scale=8,
            fmt=fmt,
            shared_palette=True,
            palette_size=48,
        )
        assert res["ok"], res
        assert os.path.exists(out) and os.path.getsize(out) > 0, f"{fmt} 未生成"
        print(
            f"[video:{fmt}] grid={res['grid_w']}x{res['grid_h']} frames={res['frames']} "
            f"out={res['out_w']}x{res['out_h']} size={os.path.getsize(out)}B  OK"
        )

    # 校验导出的 GIF 仍是多帧
    with Image.open(os.path.join(tmp, "out_gif.gif")) as im:
        assert getattr(im, "n_frames", 1) >= 8, "GIF 应为多帧"
    print("[video] 多帧校验 OK")


if __name__ == "__main__":
    print("backend:", engine.backend_name())
    test_rgba_pixelate()
    test_video_pipeline()
    print("SMOKE_V2_OK")

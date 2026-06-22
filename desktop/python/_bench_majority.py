"""sample_majority 向量化版 vs 原 cv2.kmeans 版：画质差异 + 提速对照。

用法：python _bench_majority.py
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

import numpy as np
from perfect_pixel.perfect_pixel import _sample_majority_kmeans, sample_majority


def make_pixel_image(g=64, up=12, noise=16, mix=True, seed=0):
    """合成「放大的像素图」：主色块 + 噪声，可选在格内混入次色（模拟边界混合格）。"""
    rng = np.random.default_rng(seed)
    small = (rng.integers(0, 6, size=(g, g, 3)) * 45).astype(np.float32)
    big = np.repeat(np.repeat(small, up, 0), up, 1)
    big += rng.normal(0, noise, big.shape)
    if mix:
        # 每格右下角 ~30% 区域混入次色，制造「多数 vs 少数」结构
        sub = (rng.integers(0, 6, size=(g, g, 3)) * 45).astype(np.float32)
        sub_big = np.repeat(np.repeat(sub, up, 0), up, 1)
        mask = (np.add.outer(np.arange(g * up) % up, np.arange(g * up) % up) > int(up * 1.4))
        big[mask] = sub_big[mask]
    return np.clip(big, 0, 255).astype(np.uint8)


def diff(a, b):
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    return float(np.abs(a - b).mean()), float(np.abs(a - b).max())


def bench(g, up, label):
    img = make_pixel_image(g=g, up=up)
    H, W = img.shape[:2]
    x = np.linspace(0, W, g + 1)
    y = np.linspace(0, H, g + 1)

    t0 = time.time(); old = _sample_majority_kmeans(img, x, y); t1 = time.time()
    t2 = time.time(); new = sample_majority(img, x, y); t3 = time.time()

    mae, maxd = diff(old, new)
    old_ms, new_ms = (t1 - t0) * 1000, (t3 - t2) * 1000
    speedup = old_ms / max(new_ms, 1e-3)
    print(
        f"[{label}] grid {g}x{g} img {W}x{H} | old {old_ms:.0f}ms "
        f"new {new_ms:.0f}ms | speedup {speedup:.1f}x | MAE {mae:.2f} maxdiff {maxd:.0f}"
    )
    return speedup, mae


def main():
    # warmup：numba 首次调用含 JIT 编译，不计入耗时对照
    warm = make_pixel_image(g=8, up=8)
    sample_majority(
        warm, np.linspace(0, warm.shape[1], 9), np.linspace(0, warm.shape[0], 9)
    )

    bench(32, 16, "small")
    s1, m1 = bench(64, 12, "mid")
    s2, m2 = bench(128, 8, "large")
    # 多数簇主色应一致：平均逐通道误差远小于一个色阶差(45)
    assert m1 < 20 and m2 < 20, f"画质偏差过大 MAE={m1},{m2}"
    assert s2 > 1.3, f"大图未见明显提速 speedup={s2}"
    print("BENCH_OK")


if __name__ == "__main__":
    main()

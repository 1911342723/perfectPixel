"""性能基线：各采样方法在 512 / 1024 图上的耗时（对应「未来工作.md · M0」）。

用法：python bench_sampling.py
输出：可直接贴进文档的 Markdown 表格。

测两层：
1. 采样阶段（固定网格，剔除检测开销）—— 直接对比 center / median / majority；
   majority 额外给「numba 优化版 vs cv2.kmeans 参考版」用于量化提速。
2. 端到端 get_perfect_pixel（含网格检测）—— 贴近真实单图处理耗时。
"""
from __future__ import annotations

import contextlib
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

import numpy as np
from PIL import Image, ImageFilter

from perfect_pixel.perfect_pixel import (  # noqa: E402
    _HAS_NUMBA,
    _sample_majority_kmeans,
    get_perfect_pixel,
    sample_center,
    sample_majority,
    sample_median,
)


@contextlib.contextmanager
def _quiet():
    """静音算法内部的 print（仅在测时长时使用，不影响表格输出）。"""
    with open(os.devnull, "w") as dn, contextlib.redirect_stdout(dn):
        yield


def make_pixel_image(grid: int, size: int, blur: float = 1.0, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    small = (rng.integers(0, 5, size=(grid, grid, 3)) * 60).astype(np.uint8)
    img = Image.fromarray(small, "RGB").resize((size, size), Image.NEAREST)
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(img.convert("RGB"))


def timeit(fn, repeat: int = 5) -> float:
    """返回 fn 的最优耗时（ms，取多次最小值，抗系统抖动）。"""
    best = float("inf")
    for _ in range(repeat):
        t0 = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - t0)
    return best * 1000.0


def main() -> None:
    grid = 64
    sizes = [512, 1024]

    if _HAS_NUMBA:
        warm = make_pixel_image(8, 64, blur=0.0)
        sample_majority(warm, np.linspace(0, 64, 9), np.linspace(0, 64, 9))

    results: dict[int, dict[str, float]] = {}
    with _quiet():
        for size in sizes:
            img = make_pixel_image(grid, size, blur=1.0)
            x = np.linspace(0, size, grid + 1)
            y = np.linspace(0, size, grid + 1)
            results[size] = {
                "center": timeit(lambda i=img, X=x, Y=y: sample_center(i, X, Y)),
                "median": timeit(lambda i=img, X=x, Y=y: sample_median(i, X, Y)),
                "majority": timeit(lambda i=img, X=x, Y=y: sample_majority(i, X, Y)),
                "kmeans": timeit(
                    lambda i=img, X=x, Y=y: _sample_majority_kmeans(i, X, Y), repeat=3
                ),
                "e2e_center": timeit(
                    lambda i=img: get_perfect_pixel(i, sample_method="center"), repeat=3
                ),
                "e2e_median": timeit(
                    lambda i=img: get_perfect_pixel(i, sample_method="median"), repeat=3
                ),
                "e2e_majority": timeit(
                    lambda i=img: get_perfect_pixel(i, sample_method="majority"), repeat=3
                ),
            }

    print(f"numba: {'可用' if _HAS_NUMBA else '不可用（majority 走 cv2.kmeans 参考实现）'}")
    print(f"网格: {grid}×{grid}，每项取多次最优\n")

    print("### 采样阶段（固定网格，单位 ms）\n")
    print("| 图尺寸 | center | median | majority(numba) | majority(kmeans 参考) | 提速 |")
    print("| ---: | ---: | ---: | ---: | ---: | ---: |")
    for size in sizes:
        r = results[size]
        speed = r["kmeans"] / max(r["majority"], 1e-3)
        print(
            f"| {size}×{size} | {r['center']:.2f} | {r['median']:.2f} | "
            f"{r['majority']:.2f} | {r['kmeans']:.1f} | {speed:.1f}× |"
        )

    print("\n### 端到端 get_perfect_pixel（含网格检测，单位 ms）\n")
    print("| 图尺寸 | center | median | majority |")
    print("| ---: | ---: | ---: | ---: |")
    for size in sizes:
        r = results[size]
        print(
            f"| {size}×{size} | {r['e2e_center']:.1f} | "
            f"{r['e2e_median']:.1f} | {r['e2e_majority']:.1f} |"
        )


if __name__ == "__main__":
    main()

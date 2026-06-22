"""抠图链路冒烟：验证 numpy/cv2/onnxruntime/rembg 协同 + 抠图→RGBA像素化。

用最小模型 u2netp（~4.7MB）以便快速下载验证。运行：python _smoke_matte.py
"""

import numpy as np
from PIL import Image

import engine
import matting


def main():
    print("numpy", np.__version__)
    print("cv2 backend:", engine.backend_name())
    print("rembg available:", matting.is_available())
    print("providers:", matting.providers())
    assert matting.is_available(), "rembg 不可用"

    # 合成：白底 + 居中实心圆（红），抠图应保留圆、去掉白底
    H = W = 256
    img = np.full((H, W, 3), 255, np.uint8)
    yy, xx = np.mgrid[0:H, 0:W]
    circle = (xx - W // 2) ** 2 + (yy - H // 2) ** 2 <= 70**2
    img[circle] = (220, 60, 60)
    rgb = np.asarray(
        Image.fromarray(img, "RGB").resize((512, 512), Image.NEAREST)
    )

    rgba = matting.remove_background(rgb, model="u2netp")
    print("cutout shape:", rgba.shape, "alpha range:", int(rgba[..., 3].min()), int(rgba[..., 3].max()))
    assert rgba.shape[2] == 4

    w, h, out = engine.run_pixelate_rgba(
        rgba, sample_method="center", refine_intensity=0.3, grid_size=(32, 32),
        alpha_threshold=128,
    )
    auniq = np.unique(out[..., 3]).tolist()
    print(f"pixelated cutout grid={w}x{h} shape={out.shape} alpha_uniq={auniq}")
    assert set(auniq).issubset({0, 255}), "alpha 应硬化"
    assert 255 in auniq and 0 in auniq, "圆应保留(255)且四角透明(0)"
    # 四角应透明
    assert out[0, 0, 3] == 0 and out[-1, -1, 3] == 0, "四角应为透明"
    # 中心应不透明
    assert out[h // 2, w // 2, 3] == 255, "中心应不透明"
    print("SMOKE_MATTE_OK")


if __name__ == "__main__":
    main()

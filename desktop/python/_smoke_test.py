"""冒烟测试：合成伪 AI 像素图并验证 engine 封装是否可用。"""
import numpy as np
from PIL import Image, ImageFilter

import engine

# 合成一张 32x32 像素图，放大到 512 并轻微模糊（模拟 AI 抗锯齿）
rng = np.random.default_rng(7)
g = 32
small = (rng.integers(0, 5, size=(g, g, 3)) * 60).astype(np.uint8)
img = (
    Image.fromarray(small, "RGB")
    .resize((512, 512), Image.NEAREST)
    .filter(ImageFilter.GaussianBlur(1.0))
)
img.save("_test_sample.png")
print("[1] test image:", img.size, "backend:", engine.backend_name())

rgb = engine.load_rgb_from_path("_test_sample.png")
print("[2] loaded rgb:", rgb.shape)

w, h, out = engine.run_pixelate(rgb, sample_method="center", refine_intensity=0.3)
print(f"[3] detected grid: {w} x {h}, out shape: {out.shape}")

b64 = engine.rgb_to_png_base64(out)
print("[4] preview base64 length:", len(b64))

up = engine.upscale_nearest(out, 8)
up.save("_test_out_8x.png")
print("[5] exported 8x:", up.size)

print("SMOKE_OK")

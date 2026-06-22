"""HTTP 集成冒烟（任务化）：对运行中的 sidecar 实测各 API 路由 + 后台任务轮询。

用法：先 `python app.py --port 8799`，再 `python _smoke_api.py 8799`
"""

import json
import os
import sys
import tempfile
import time
import urllib.request

import numpy as np
from PIL import Image, ImageFilter

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
BASE = f"http://127.0.0.1:{PORT}"


def _get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.loads(r.read())


def _post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def poll_job(jid, timeout=300):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = _get(f"/api/job/{jid}")
        assert j.get("ok"), j
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.4)
    raise RuntimeError("任务超时")


def wait_health():
    for _ in range(60):
        try:
            h = _get("/health")
            if h.get("status") == "ok":
                return h
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("sidecar 未就绪")


def make_grid_png(path, g=32, up=512):
    rng = np.random.default_rng(7)
    small = (rng.integers(0, 4, size=(g, g, 3)) * 70).astype(np.uint8)
    Image.fromarray(small, "RGB").resize((up, up), Image.NEAREST).filter(
        ImageFilter.GaussianBlur(1.0)
    ).save(path)


def make_subject_png(path):
    img = np.full((512, 512, 3), 255, np.uint8)
    yy, xx = np.mgrid[0:512, 0:512]
    img[(xx - 256) ** 2 + (yy - 256) ** 2 <= 150**2] = (220, 60, 60)
    Image.fromarray(img, "RGB").save(path)


def make_anim_gif(path, n=10, g=32, up=512):
    rng = np.random.default_rng(3)
    base = (rng.integers(0, 4, size=(g, g, 3)) * 60).astype(np.uint8)
    frames = []
    for i in range(n):
        f = base.copy()
        x = 2 + (i % (g - 6))
        f[4:8, x : x + 4] = (240, 80, 80)
        frames.append(Image.fromarray(f, "RGB").resize((up, up), Image.NEAREST))
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=90, loop=0)


def main():
    h = wait_health()
    print("[health]", h.get("version"), "matte=", h.get("matte_available"))

    tmp = tempfile.mkdtemp(prefix="pp_api_")
    grid_png = os.path.join(tmp, "grid.png")
    subj_png = os.path.join(tmp, "subject.png")
    make_grid_png(grid_png)
    make_subject_png(subj_png)

    r = _post("/api/pixelate", {"input_path": grid_png, "sample_method": "center", "refine_intensity": 0.3})
    assert r.get("ok"), r
    print("[pixelate] grid", r["grid_w"], "x", r["grid_h"], "OK")

    info = _get("/api/matte/info")
    print("[matte/info] available=", info["available"], "models=", len(info["models"]))

    if info["available"]:
        start = _post(
            "/api/matte",
            {
                "input_path": subj_png,
                "model": "u2netp",
                "alpha_threshold": 128,
                "sample_method": "center",
                "refine_intensity": 0.3,
                "grid_w": 32,
                "grid_h": 32,
            },
        )
        assert start.get("ok") and start.get("job_id"), start
        j = poll_job(start["job_id"])
        assert j["status"] == "done", j
        res = j["result"]
        assert res and res.get("image_base64", "").startswith("data:image/png"), res
        print("[matte job] status=", j["status"], "grid", res["grid_w"], "x", res["grid_h"], "OK")

    gif = os.path.join(tmp, "a.gif")
    make_anim_gif(gif)
    pr = _post("/api/video/probe", {"input_path": gif, "max_frames": 240})
    assert pr.get("ok"), pr
    print("[video/probe] frames=", pr["frames"], "fps=", pr["fps"], "OK")

    out_gif = os.path.join(tmp, "out.gif")
    start = _post(
        "/api/video/process",
        {
            "input_path": gif,
            "output_path": out_gif,
            "sample_method": "center",
            "scale": 8,
            "fmt": "gif",
            "shared_palette": True,
            "palette_size": 48,
        },
    )
    assert start.get("ok") and start.get("job_id"), start
    j = poll_job(start["job_id"])
    assert j["status"] == "done", j
    assert os.path.exists(out_gif) and os.path.getsize(out_gif) > 0, "GIF 未生成"
    print("[video job] status=", j["status"], "frames=", j["result"]["frames"], "OK")

    logs = _get("/api/logs?since=0")
    assert logs.get("logs") is not None
    print("[logs] count=", len(logs["logs"]), "latest=", logs["logs"][-1]["msg"] if logs["logs"] else "-")

    print("SMOKE_API_OK")


if __name__ == "__main__":
    main()

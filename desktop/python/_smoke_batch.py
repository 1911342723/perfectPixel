"""批量处理（M3）+ 账号 CRUD 冒烟。

对运行中的 sidecar 实测 /api/batch 端到端（异步 job 轮询、批量导出、失败计入），
以及 /api/accounts 增 / 查 / 删（验证 bridge.store 与 import time 修复后路由可正常加载）。

用法：先 `python app.py --port 8799`，再 `python _smoke_batch.py 8799`
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


def _delete(path):
    req = urllib.request.Request(BASE + path, method="DELETE")
    with urllib.request.urlopen(req, timeout=30) as r:
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


def make_grid_png(path, g=32, up=256):
    rng = np.random.default_rng(abs(hash(path)) % (2**32))
    small = (rng.integers(0, 4, size=(g, g, 3)) * 70).astype(np.uint8)
    Image.fromarray(small, "RGB").resize((up, up), Image.NEAREST).filter(
        ImageFilter.GaussianBlur(1.0)
    ).save(path)


def main():
    h = wait_health()
    print("[health]", h.get("version"))

    tmp = tempfile.mkdtemp(prefix="pp_batch_")
    out_dir = os.path.join(tmp, "out")
    paths = []
    for i in range(3):
        p = os.path.join(tmp, f"img_{i}.png")
        make_grid_png(p)
        paths.append(p)
    # 故意混入一个不存在的文件，验证「单张失败不中断整批」
    paths.append(os.path.join(tmp, "missing.png"))

    start = _post(
        "/api/batch",
        {
            "input_paths": paths,
            "output_dir": out_dir,
            "sample_method": "center",
            "refine_intensity": 0.3,
            "scale": 8,
            "suffix": "_pixel",
        },
    )
    assert start.get("ok") and start.get("job_id"), start
    j = poll_job(start["job_id"])
    assert j["status"] == "done", j
    res = j["result"]
    assert res["total"] == 4, res
    assert res["done"] == 3, res
    assert res["failed"] == 1, res
    ok_items = [it for it in res["items"] if it["ok"]]
    for it in ok_items:
        assert os.path.exists(it["out_path"]), it
        assert it["out_w"] > 0 and it["out_h"] > 0, it
    print(
        "[batch] done", res["done"], "/", res["total"],
        "failed", res["failed"], "→ files OK",
    )

    # 账号 CRUD（不触发浏览器自动化）
    acc = _post("/api/accounts", {"platform": "doubao", "name": "smoke"})
    assert acc.get("ok"), acc
    aid = acc["account"]["id"]
    lst = _get("/api/accounts")
    assert any(a["id"] == aid for a in lst["accounts"]), lst
    gen = _post("/api/generate", {"account_id": "no_such_id", "prompt": "x"})
    assert gen.get("ok") is False and "不存在" in (gen.get("error") or ""), gen
    d = _delete(f"/api/accounts/{aid}")
    assert d.get("ok"), d
    print("[accounts] add/list/delete OK")

    print("SMOKE_BATCH_OK")


if __name__ == "__main__":
    main()

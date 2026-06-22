"""完美像素桌面软件 · Python Sidecar (FastAPI)。

由 Electron 主进程启动：`python app.py --port <port>`。
仅监听 127.0.0.1，供本机前端通过 HTTP 调用算法。
"""

from __future__ import annotations

import os
import sys
import time
from typing import Optional

# Windows 控制台默认 GBK，统一 UTF-8 避免日志中文/特殊字符崩溃
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import engine
import jobs
import matting
import video
from bridge import AccountStore, OUTPUT_DIR
from bridge import browser as doubao_browser
from bridge import settings as app_settings

APP_VERSION = "0.3.0"

app = FastAPI(title="PerfectPixel Sidecar", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class PixelateReq(BaseModel):
    input_path: Optional[str] = None
    image_base64: Optional[str] = None
    sample_method: str = "center"  # center / median / majority
    refine_intensity: float = 0.25
    grid_w: Optional[int] = None
    grid_h: Optional[int] = None


class ExportReq(PixelateReq):
    output_path: str
    scale: int = 8


def _load_rgb(req: PixelateReq):
    if req.input_path:
        return engine.load_rgb_from_path(req.input_path)
    if req.image_base64:
        return engine.load_rgb_from_base64(req.image_base64)
    raise ValueError("缺少输入：请提供 input_path 或 image_base64")


def _grid_size(req: PixelateReq):
    if req.grid_w and req.grid_h and req.grid_w > 0 and req.grid_h > 0:
        return (int(req.grid_w), int(req.grid_h))
    return None


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": APP_VERSION,
        "backend": engine.backend_name(),
        "matte_available": matting.is_available(),
        "providers": matting.providers(),
    }


@app.get("/api/logs")
def api_logs(since: int = 0):
    """增量拉取后端日志（前端轮询用）。"""
    return jobs.get_logs(since)


@app.get("/api/job/{jid}")
def api_job(jid: str):
    """查询后台任务状态/进度/结果。"""
    j = jobs.get_job(jid)
    if not j:
        return {"ok": False, "error": "任务不存在或已过期"}
    return {"ok": True, **j}


@app.post("/api/pixelate")
def pixelate(req: PixelateReq):
    try:
        rgb = _load_rgb(req)
    except Exception as e:
        return {"ok": False, "error": f"读取图片失败：{e}"}

    src_h, src_w = rgb.shape[:2]
    try:
        w, h, out = engine.run_pixelate(
            rgb, req.sample_method, req.refine_intensity, _grid_size(req)
        )
    except Exception as e:
        return {"ok": False, "error": str(e)}

    return {
        "ok": True,
        "grid_w": w,
        "grid_h": h,
        "src_w": int(src_w),
        "src_h": int(src_h),
        "image_base64": engine.rgb_to_png_base64(out),
        "src_base64": engine.rgb_to_thumb_base64(rgb),
    }


@app.post("/api/export")
def export(req: ExportReq):
    try:
        rgb = _load_rgb(req)
    except Exception as e:
        return {"ok": False, "error": f"读取图片失败：{e}"}

    try:
        w, h, out = engine.run_pixelate(
            rgb, req.sample_method, req.refine_intensity, _grid_size(req)
        )
    except Exception as e:
        return {"ok": False, "error": str(e)}

    try:
        img = engine.upscale_nearest(out, req.scale)
        img.save(req.output_path)
    except Exception as e:
        return {"ok": False, "error": f"导出失败：{e}"}

    return {
        "ok": True,
        "output_path": req.output_path,
        "out_w": img.size[0],
        "out_h": img.size[1],
        "grid_w": w,
        "grid_h": h,
    }


# --------------------------------------------------------------------------- #
# 批量处理（文件夹 / 多文件 → 队列 → 逐张完美像素化 → 批量导出）
# --------------------------------------------------------------------------- #
class BatchReq(BaseModel):
    input_paths: list[str]
    output_dir: str
    sample_method: str = "center"
    refine_intensity: float = 0.25
    grid_w: Optional[int] = None
    grid_h: Optional[int] = None
    scale: int = 8
    suffix: str = "_pixel"


@app.post("/api/batch")
def batch(req: BatchReq):
    """批量完美像素化：异步逐张处理并导出到 output_dir，失败不中断整批。

    手动指定 grid_w/grid_h 即可对全批使用「统一网格」；否则每张独立检测。
    """
    paths = [p for p in (req.input_paths or []) if p]
    if not paths:
        return {"ok": False, "error": "未选择任何图片"}
    if not req.output_dir:
        return {"ok": False, "error": "未指定输出目录"}

    grid = _grid_size(req)
    scale = max(1, int(req.scale))
    suffix = req.suffix if req.suffix is not None else "_pixel"

    def task(jid: str):
        os.makedirs(req.output_dir, exist_ok=True)
        total = len(paths)
        items: list[dict] = []
        ok_count = 0
        jobs.log(f"批量处理开始 · 共 {total} 张 → {req.output_dir}", "info")
        for i, p in enumerate(paths):
            name = os.path.basename(p)
            jobs.update_job(
                jid,
                stage="process",
                percent=round(i / total * 100.0, 1),
                message=f"处理 {i + 1}/{total} · {name}",
            )
            try:
                rgb = engine.load_rgb_from_path(p)
                w, h, out = engine.run_pixelate(
                    rgb, req.sample_method, req.refine_intensity, grid
                )
                stem = os.path.splitext(name)[0]
                out_path = os.path.join(req.output_dir, f"{stem}{suffix}.png")
                img = engine.upscale_nearest(out, scale)
                img.save(out_path)
                items.append(
                    {
                        "name": name,
                        "ok": True,
                        "grid_w": w,
                        "grid_h": h,
                        "out_path": out_path,
                        "out_w": img.size[0],
                        "out_h": img.size[1],
                    }
                )
                ok_count += 1
            except Exception as e:  # noqa: BLE001 — 单张失败不影响整批
                items.append({"name": name, "ok": False, "error": str(e)})
                jobs.log(f"批量：{name} 失败 — {e}", "error")

        jobs.update_job(jid, percent=100.0, message=f"完成 {ok_count}/{total}")
        jobs.log(
            f"批量处理完成 · 成功 {ok_count}/{total} → {req.output_dir}",
            "ok" if ok_count == total else "warn",
        )
        return {
            "ok": True,
            "total": total,
            "done": ok_count,
            "failed": total - ok_count,
            "output_dir": req.output_dir,
            "items": items,
        }

    return {"ok": True, "job_id": jobs.run_async("batch", task)}


# --------------------------------------------------------------------------- #
# 一键抠图
# --------------------------------------------------------------------------- #
class MatteReq(PixelateReq):
    model: str = "u2net"
    alpha_matting: bool = False
    alpha_threshold: int = 128
    decontaminate: bool = True


class MatteExportReq(MatteReq):
    output_path: str
    scale: int = 8


@app.get("/api/matte/info")
def matte_info():
    """抠图能力信息：依赖是否就绪、可用模型、ONNX 后端。"""
    return {
        "available": matting.is_available(),
        "models": matting.AVAILABLE_MODELS,
        "providers": matting.providers(),
        "default_model": matting.DEFAULT_MODEL,
    }


def _ensure_matte_model(jid: str, model: str) -> None:
    """确保抠图模型就绪；缺失则带进度下载，进度/日志写入 job。"""
    if not matting.is_available():
        raise RuntimeError(
            "未安装抠图依赖 rembg：请在 sidecar 的 Python 环境执行 pip install rembg"
        )
    if matting.is_model_ready(model):
        return
    jobs.log(f"开始下载抠图模型 {model}…", "info")
    jobs.update_job(jid, stage="download", percent=0.0, message=f"下载模型 {model}…")

    def on_prog(done: int, total: int) -> None:
        mb = done / 1048576.0
        if total:
            pct = done / total * 100.0
            jobs.update_job(
                jid,
                stage="download",
                percent=round(pct, 1),
                message=f"下载模型 {model} · {mb:.1f}/{total / 1048576.0:.1f} MB",
            )
        else:
            jobs.update_job(
                jid, stage="download", percent=0.0, message=f"下载模型 {model} · {mb:.1f} MB"
            )

    matting.ensure_model(model, on_prog)
    jobs.log(f"模型 {model} 就绪", "ok")


@app.post("/api/matte")
def matte(req: MatteReq):
    def task(jid: str):
        rgb = _load_rgb(req)
        src_h, src_w = rgb.shape[:2]
        _ensure_matte_model(jid, req.model)
        jobs.update_job(jid, stage="matte", percent=100.0, message="抠图中…")
        jobs.log(f"抠图中（{req.model}）…", "info")
        cutout = matting.remove_background(
            rgb, model=req.model, alpha_matting=req.alpha_matting
        )
        if req.decontaminate:
            cutout = matting.decontaminate(cutout)
        jobs.update_job(jid, stage="pixelate", message="完美像素化…")
        w, h, out = engine.run_pixelate_rgba(
            cutout,
            req.sample_method,
            req.refine_intensity,
            _grid_size(req),
            alpha_threshold=req.alpha_threshold,
        )
        jobs.log(f"抠图完成 · 网格 {w}×{h}", "ok")
        return {
            "ok": True,
            "grid_w": w,
            "grid_h": h,
            "src_w": int(src_w),
            "src_h": int(src_h),
            "image_base64": engine.to_png_base64(out),
            "cutout_base64": engine.rgb_to_thumb_base64(cutout),
            "src_base64": engine.rgb_to_thumb_base64(rgb),
        }

    return {"ok": True, "job_id": jobs.run_async("matte", task)}


@app.post("/api/matte/export")
def matte_export(req: MatteExportReq):
    def task(jid: str):
        rgb = _load_rgb(req)
        _ensure_matte_model(jid, req.model)
        jobs.update_job(jid, stage="matte", message="抠图中…")
        cutout = matting.remove_background(
            rgb, model=req.model, alpha_matting=req.alpha_matting
        )
        if req.decontaminate:
            cutout = matting.decontaminate(cutout)
        jobs.update_job(jid, stage="pixelate", message="完美像素化…")
        w, h, out = engine.run_pixelate_rgba(
            cutout,
            req.sample_method,
            req.refine_intensity,
            _grid_size(req),
            alpha_threshold=req.alpha_threshold,
        )
        jobs.update_job(jid, stage="export", message="导出透明 PNG…")
        img = engine.upscale_nearest(out, req.scale)
        img.save(req.output_path)
        jobs.log(f"已导出透明 PNG {img.size[0]}×{img.size[1]} → {req.output_path}", "ok")
        return {
            "ok": True,
            "output_path": req.output_path,
            "out_w": img.size[0],
            "out_h": img.size[1],
            "grid_w": w,
            "grid_h": h,
        }

    return {"ok": True, "job_id": jobs.run_async("matte_export", task)}


# --------------------------------------------------------------------------- #
# 视频 / GIF
# --------------------------------------------------------------------------- #
class VideoProbeReq(BaseModel):
    input_path: str
    max_frames: int = video.DEFAULT_MAX_FRAMES


class VideoProcessReq(BaseModel):
    input_path: str
    output_path: str
    sample_method: str = "center"
    grid_w: Optional[int] = None
    grid_h: Optional[int] = None
    max_frames: int = video.DEFAULT_MAX_FRAMES
    fps_out: Optional[float] = None
    scale: int = 8
    fmt: str = "gif"
    shared_palette: bool = True
    palette_size: int = 64
    matte: bool = False
    matte_model: str = "u2net"
    alpha_threshold: int = 128


@app.post("/api/video/probe")
def video_probe(req: VideoProbeReq):
    try:
        return video.probe(req.input_path, max_frames=req.max_frames)
    except Exception as e:
        return {"ok": False, "error": f"读取失败：{e}"}


@app.post("/api/video/process")
def video_process(req: VideoProcessReq):
    grid = None
    if req.grid_w and req.grid_h and req.grid_w > 0 and req.grid_h > 0:
        grid = (int(req.grid_w), int(req.grid_h))

    def task(jid: str):
        # 逐帧抠图前先把模型带进度下好，避免推理时卡在隐式下载
        if req.matte:
            _ensure_matte_model(jid, req.matte_model)

        def on_prog(done: int, total: int, msg: str) -> None:
            jobs.update_job(jid, stage="process", percent=float(done), message=msg)

        jobs.log(f"视频处理开始：{req.fmt} · matte={req.matte}", "info")
        res = video.process(
            req.input_path,
            req.output_path,
            sample_method=req.sample_method,
            grid_size=grid,
            max_frames=req.max_frames,
            fps_out=req.fps_out,
            scale=req.scale,
            fmt=req.fmt,
            shared_palette=req.shared_palette,
            palette_size=req.palette_size,
            matte=req.matte,
            matte_model=req.matte_model,
            alpha_threshold=req.alpha_threshold,
            progress=on_prog,
        )
        jobs.log(
            f"视频完成 · {res.get('frames')} 帧 · 网格 {res.get('grid_w')}×{res.get('grid_h')} → {req.output_path}",
            "ok",
        )
        return res

    return {"ok": True, "job_id": jobs.run_async("video", task)}


# ----------------------------- 豆包 / 即梦 桥接 -----------------------------

store = AccountStore()


class AddAccountReq(BaseModel):
    platform: str
    name: Optional[str] = None


class GenerateReq(BaseModel):
    account_id: str
    prompt: str
    pixelate: bool = False
    sample_method: str = "center"
    refine_intensity: float = 0.3


@app.get("/api/accounts")
def list_accounts():
    return {"ok": True, "accounts": store.list()}


@app.post("/api/accounts")
def add_account(req: AddAccountReq):
    if req.platform not in ("jimeng", "doubao"):
        return {"ok": False, "error": "平台仅支持 jimeng / doubao"}
    return {"ok": True, "account": store.add(req.platform, req.name)}


@app.delete("/api/accounts/{account_id}")
def delete_account(account_id: str):
    return {"ok": store.remove(account_id)}


@app.post("/api/accounts/{account_id}/login")
def login_account(account_id: str):
    acc = store.get(account_id)
    if not acc:
        return {"ok": False, "error": "账号不存在"}
    try:
        logged = doubao_browser.open_login(store.user_data_dir(account_id), acc["platform"])
    except Exception as e:
        return {"ok": False, "error": str(e)}
    status = "logged_in" if logged else "logged_out"
    store.update(account_id, status=status, last_check=time.strftime("%Y-%m-%d %H:%M:%S"))
    return {"ok": True, "logged_in": logged, "status": status}


@app.post("/api/accounts/{account_id}/check")
def check_account(account_id: str):
    acc = store.get(account_id)
    if not acc:
        return {"ok": False, "error": "账号不存在"}
    try:
        logged = doubao_browser.check_login(store.user_data_dir(account_id), acc["platform"])
    except Exception as e:
        return {"ok": False, "error": str(e)}
    status = "logged_in" if logged else "logged_out"
    store.update(account_id, status=status, last_check=time.strftime("%Y-%m-%d %H:%M:%S"))
    return {"ok": True, "logged_in": logged, "status": status}


@app.post("/api/generate")
def generate(req: GenerateReq):
    """AI 生图：异步执行（浏览器自动化耗时长），前端轮询 /api/job/{id} 拿进度。

    全程通过 jobs.log 打点，前端「后端日志」面板可实时看到每一步，
    便于联调豆包/即梦的真实页面行为。
    """
    acc = store.get(req.account_id)
    if not acc:
        return {"ok": False, "error": "账号不存在"}
    if not req.prompt.strip():
        return {"ok": False, "error": "提示词不能为空"}

    def task(jid: str):
        ts = time.strftime("%Y%m%d_%H%M%S")
        jobs.update_job(jid, stage="generate", message="启动浏览器…")
        jobs.log(f"开始生图（{acc['platform']}）：{req.prompt[:60]}", "info")

        def on_log(msg: str) -> None:
            jobs.log(f"[生图] {msg}", "info")
            jobs.update_job(jid, message=msg)

        items = doubao_browser.generate_images(
            store.user_data_dir(req.account_id),
            acc["platform"],
            req.prompt,
            on_log=on_log,
        )

        # 落盘 + 生成缩略图供前端选择（保存到用户在「设置」里配置的目录）
        out_dir = app_settings.get_output_dir()
        os.makedirs(out_dir, exist_ok=True)
        images = []
        for i, (url, body) in enumerate(items):
            p = os.path.join(out_dir, f"gen_{ts}_{i + 1}.png")
            with open(p, "wb") as f:
                f.write(body)
            entry = {"image_path": p, "source_url": url}
            try:
                rgb = engine.load_rgb_from_path(p)
                entry["image_base64"] = engine.rgb_to_thumb_base64(rgb, 512)
            except Exception:
                pass
            images.append(entry)
        jobs.log(f"已保存 {len(images)} 张候选图", "ok")

        first = images[0]
        resp = {
            "ok": True,
            "images": images,
            # 兼容字段：默认第一张（体积最大）
            "image_path": first["image_path"],
            "source_url": first.get("source_url"),
            "image_base64": first.get("image_base64"),
        }

        if req.pixelate:
            jobs.update_job(jid, stage="pixelate", message="完美像素化…")
            try:
                rgb = engine.load_rgb_from_path(first["image_path"])
                w, h, out = engine.run_pixelate(
                    rgb, req.sample_method, req.refine_intensity, None
                )
                resp["pixel_grid_w"] = w
                resp["pixel_grid_h"] = h
                resp["pixel_base64"] = engine.rgb_to_png_base64(out)
                jobs.log(f"完美像素化完成 · 网格 {w}×{h}", "ok")
            except Exception as e:
                resp["pixelate_error"] = str(e)
                jobs.log(f"像素化失败：{e}", "warn")

        return resp

    return {"ok": True, "job_id": jobs.run_async("generate", task)}


# ----------------------------- 应用设置 -----------------------------


class SettingsReq(BaseModel):
    output_dir: Optional[str] = None


@app.get("/api/settings")
def get_settings():
    return {"ok": True, "settings": app_settings.load_settings()}


@app.post("/api/settings")
def update_settings(req: SettingsReq):
    s = app_settings.save_settings({"output_dir": req.output_dir})
    return {"ok": True, "settings": s}


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="PerfectPixel Sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--reload",
        action="store_true",
        help="开发态热重载：监听 python/ 目录，改动后自动重启 sidecar",
    )
    args = parser.parse_args()

    if args.reload:
        # reload 需要 import-string（uvicorn 要能在子进程里重新导入 app）。
        # cwd 由 Electron 设为本目录，故 "app:app" 可直接解析。
        uvicorn.run(
            "app:app",
            host=args.host,
            port=args.port,
            log_level="info",
            reload=True,
            reload_dirs=[os.path.dirname(os.path.abspath(__file__))],
        )
    else:
        uvicorn.run(app, host=args.host, port=args.port, log_level="info")

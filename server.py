"""Multi-provider desktop chat backend using OpenAI-compatible APIs."""
import json
import base64
import os
import sys
import socket
import threading
import time
import atexit
import re
import asyncio
import queue
from pathlib import Path
from typing import Optional, Any

from fastapi import FastAPI, HTTPException, UploadFile, File, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from pydantic import BaseModel
from openai import OpenAI
import httpx
import uvicorn
from record_store import RecordStore, WORKSPACES, CONVERSATIONS, ACTIVE, SETTINGS, SYNC_META

# ── Configuration ──────────────────────────────────────────────────────────
APP_NAME = "NVIDIAChat"
PROVIDER_CONNECT_TIMEOUT_SECONDS = 20.0
PROVIDER_READ_TIMEOUT_SECONDS = 180.0
STREAM_HEARTBEAT_SECONDS = 10.0
STREAM_IDLE_TIMEOUT_SECONDS = 210.0
KNOWN_UNAVAILABLE_SERVERLESS_MODELS = {
    # Still returned by /v1/models for some accounts, but its hosted function
    # is no longer present in NVIDIA's current serverless catalog.
    "nvidia/nemotron-4-340b-instruct",
}
PROVIDERS = {
    "nvidia": {
        "name": "NVIDIA API",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "key_placeholder": "nvapi-...",
    },
    "deepseek": {
        "name": "DeepSeek 官方 API",
        "base_url": "https://api.deepseek.com",
        "key_placeholder": "sk-...",
    },
}

def resource_path(name: str) -> Path:
    """Return bundled resources both in source and PyInstaller builds."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / name

def user_data_dir() -> Path:
    """Keep writable state outside the read-only/temporary EXE bundle."""
    if os.environ.get("MULTICHAT_DATA_DIR"):
        return Path(os.environ["MULTICHAT_DATA_DIR"])
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    return base / APP_NAME

DATA_DIR = user_data_dir()
DATA_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_FILE = DATA_DIR / "config.json"
USER_DATA_FILE = DATA_DIR / "user_data.json"
DESKTOP_PORT = 8765
USER_DATA_KEYS = {
    WORKSPACES, CONVERSATIONS, ACTIVE, SETTINGS, SYNC_META,
}
user_data_lock = threading.RLock()

# ── Config helpers ─────────────────────────────────────────────────────────
def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {}
    return {}

def save_config(cfg: dict):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)

def load_legacy_user_data() -> dict:
    if not USER_DATA_FILE.exists():
        return {}
    try:
        with open(USER_DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, IOError):
        return {}

def save_legacy_user_data(data: dict) -> None:
    """Atomically persist conversations so a crash cannot truncate the file."""
    temp_file = USER_DATA_FILE.with_suffix(".tmp")
    with open(temp_file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    temp_file.replace(USER_DATA_FILE)


record_store = RecordStore(DATA_DIR / "chat_records", USER_DATA_FILE)
load_user_data = record_store.load_snapshot
save_user_data = record_store.save_snapshot
# ── Pydantic models ────────────────────────────────────────────────────────
class AuthRequest(BaseModel):
    api_key: str
    save: bool = True
    provider: str = "nvidia"

class ProviderSwitchRequest(BaseModel):
    provider: str

class ChatRequest(BaseModel):
    provider: Optional[str] = None
    model: str
    messages: list[dict]  # [{"role": "...", "content": ...}]
    temperature: float = 1.0
    top_p: float = 1.0
    max_tokens: int = 16384
    seed: int = 42
    system_prompt: Optional[str] = None

class ConfigUpdate(BaseModel):
    system_prompt: Optional[str] = None
    default_model: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    seed: Optional[int] = None

# ── FastAPI App ────────────────────────────────────────────────────────────
app = FastAPI(title="Multi-provider Chat Interface", version="1.0.0")


@app.middleware("http")
async def restrict_lan_surface(request: Request, call_next):
    """Keep local API access on loopback and reject cross-origin writes."""
    client_host = request.client.host if request.client else ""
    is_loopback = client_host in {"127.0.0.1", "::1", "localhost", "testclient"}
    if not is_loopback or request.url.hostname not in {"127.0.0.1", "localhost", "::1", "testserver"}:
        return JSONResponse(status_code=403, content={"detail": "仅允许本机访问"})
    origin = request.headers.get("origin")
    if origin and origin != f"{request.url.scheme}://{request.url.netloc}":
        return JSONResponse(status_code=403, content={"detail": "不允许跨来源访问本地接口"})
    return await call_next(request)

# In-memory API key & cached model list
current_provider: str = "nvidia"
api_keys: dict[str, str] = {}
cached_models: dict[str, list[str]] = {provider: [] for provider in PROVIDERS}

# Load saved state on startup
config = load_config()
current_provider = config.get("provider", "nvidia")
if current_provider not in PROVIDERS:
    current_provider = "nvidia"
saved_keys = config.get("api_keys", {})
if isinstance(saved_keys, dict):
    api_keys.update({k: v for k, v in saved_keys.items() if k in PROVIDERS and isinstance(v, str)})
# Seamlessly migrate the original single NVIDIA key.
if config.get("api_key") and "nvidia" not in api_keys:
    api_keys["nvidia"] = config["api_key"]

# ── Helpers ────────────────────────────────────────────────────────────────
def public_config():
    return {k: v for k, v in config.items() if k in {"system_prompt", "default_model", "temperature", "max_tokens", "seed"}}


def require_provider(provider: str) -> dict:
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"不支持的供应商: {provider}")
    return PROVIDERS[provider]

def get_client(provider: Optional[str] = None) -> OpenAI:
    provider = provider or current_provider
    definition = require_provider(provider)
    api_key = api_keys.get(provider)
    if not api_key:
        raise HTTPException(status_code=401, detail=f"请先配置{definition['name']} API Key")
    return OpenAI(
        base_url=definition["base_url"],
        api_key=api_key,
        timeout=httpx.Timeout(
            connect=PROVIDER_CONNECT_TIMEOUT_SECONDS,
            read=PROVIDER_READ_TIMEOUT_SECONDS,
            write=30.0,
            pool=20.0,
        ),
        # A retry can make an already long request look like it is hanging.
        # Surface the first provider failure to the UI instead.
        max_retries=0,
    )


def provider_error_message(error: Exception, model: Optional[str] = None, provider: str = "nvidia") -> str:
    """Return a useful provider error without hiding its response."""
    provider_name = PROVIDERS.get(provider, {}).get("name", provider)
    status = getattr(error, "status_code", None)
    body = getattr(error, "body", None)
    detail = ""
    if isinstance(body, dict):
        nested = body.get("error")
        if isinstance(nested, dict):
            detail = str(nested.get("message") or nested.get("detail") or "")
        elif nested:
            detail = str(nested)
        detail = detail or str(body.get("message") or body.get("detail") or "")
    elif body:
        detail = str(body)
    detail = detail or str(error) or error.__class__.__name__
    # NVIDIA function errors may contain the user's internal account id.
    detail = re.sub(r"for account\s+['\"][^'\"]+['\"]", "for the current account", detail)
    if status == 429:
        return (
            f"{provider_name} 对模型 {model or '当前模型'} 触发了临时限流（HTTP 429）。"
            "程序已自动重试；请稍后再试或缩短 Max Tokens"
        )
    if provider == "nvidia" and status == 404 and "Function" in detail and "not found" in detail:
        return (
            f"模型 {model or '当前模型'} 的 NVIDIA 托管推理函数对当前账户不可用"
            "（HTTP 404）。该模型可能已撤下，或仅支持自托管/特定账户"
        )
    if status:
        return f"{provider_name} HTTP {status}: {detail}"
    if isinstance(error, (TimeoutError, httpx.TimeoutException)) or "timed out" in detail.lower():
        model_note = f"模型 {model} " if model else ""
        return (
            f"{provider_name} 的{model_note}推理端点在 "
            f"{int(PROVIDER_READ_TIMEOUT_SECONDS)} 秒内没有返回数据。"
            "API Key 和模型列表可能仍正常，但该模型服务当前可能拥堵或不可用"
        )
    return f"{provider_name} 请求失败: {detail}"


def model_request_options(model: str, requested_top_p: float, provider: str = "nvidia") -> dict[str, Any]:
    """Apply model-specific parameters published by NVIDIA's API examples."""
    options: dict[str, Any] = {"top_p": requested_top_p}
    if provider == "nvidia" and model.startswith("deepseek-ai/deepseek-v4-"):
        options["top_p"] = 0.95
        options["extra_body"] = {
            "chat_template_kwargs": {
                "thinking": True,
                "reasoning_effort": "high",
            }
        }
    elif provider == "nvidia" and model == "moonshotai/kimi-k3":
        # NVIDIA documents top_p and the other sampling controls as fixed for
        # Kimi-K3. Low effort is much less likely to exhaust trial rate limits.
        options = {"reasoning_effort": "low"}
    return options


def visible_models(model_ids: list[str]) -> list[str]:
    return sorted(set(model_ids) - KNOWN_UNAVAILABLE_SERVERLESS_MODELS)

def immutable_top_p_from_error(error: Exception) -> Optional[float]:
    """Extract a provider-required top_p value from a validation response."""
    match = re.search(
        r"top[_`\\]*p[^\n]*?must\s+be\s+([0-9]+(?:\.[0-9]+)?)",
        str(error),
        flags=re.IGNORECASE,
    )
    return float(match.group(1)) if match else None

# ── API Routes ─────────────────────────────────────────────────────────────

@app.get("/api/status")
async def api_status():
    """返回当前登录状态"""
    return {
        "has_api_key": current_provider in api_keys,
        "provider": current_provider,
        "providers": [
            {"id": key, **value, "has_api_key": key in api_keys,
             "masked_key": mask_key(api_keys[key]) if key in api_keys else None}
            for key, value in PROVIDERS.items()
        ],
        "masked_key": mask_key(api_keys[current_provider]) if current_provider in api_keys else None,
        "config": public_config()
    }

def mask_key(key: str) -> str:
    if len(key) <= 8:
        return "*" * len(key)
    return key[:4] + "*" * (len(key) - 8) + key[-4:]

@app.post("/api/auth/login")
async def login(auth: AuthRequest):
    """验证并保存API Key"""
    global current_provider
    definition = require_provider(auth.provider)

    # 验证key: 尝试拉取模型列表
    try:
        client = OpenAI(base_url=definition["base_url"], api_key=auth.api_key)
        models_resp = client.models.list()
        models = [m.id for m in models_resp.data]
        cached_models[auth.provider] = visible_models(models) if auth.provider == "nvidia" else sorted(set(models))
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"API Key 验证失败: {str(e)}")

    api_keys[auth.provider] = auth.api_key
    current_provider = auth.provider

    if auth.save:
        config["api_keys"] = api_keys
        config["provider"] = current_provider
        config.pop("api_key", None)
        save_config(config)

    return {"status": "ok", "provider": current_provider, "masked_key": mask_key(auth.api_key), "model_count": len(cached_models[current_provider])}

@app.post("/api/provider")
async def switch_provider(request: ProviderSwitchRequest):
    global current_provider
    definition = require_provider(request.provider)
    if request.provider not in api_keys:
        raise HTTPException(status_code=401, detail=f"尚未配置{definition['name']} API Key")
    current_provider = request.provider
    config["provider"] = current_provider
    save_config(config)
    return {"status": "ok", "provider": current_provider, "masked_key": mask_key(api_keys[current_provider])}

@app.post("/api/auth/logout")
async def logout():
    """清除API Key"""
    api_keys.pop(current_provider, None)
    cached_models[current_provider] = []
    config["api_keys"] = api_keys
    config.pop("api_key", None)
    save_config(config)
    return {"status": "ok"}

@app.get("/api/models")
async def get_models(refresh: bool = False, provider: Optional[str] = None):
    """获取可用模型列表（默认使用缓存）"""
    provider = provider or current_provider
    require_provider(provider)

    if refresh or not cached_models[provider]:
        try:
            client = get_client(provider)
            models_resp = client.models.list()
            models = [m.id for m in models_resp.data]
            cached_models[provider] = visible_models(models) if provider == "nvidia" else sorted(set(models))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"获取模型列表失败: {str(e)}")

    return {"provider": provider, "models": cached_models[provider]}


@app.delete("/api/auth/keys/{provider}")
async def remove_provider_key(provider: str):
    global current_provider
    require_provider(provider)
    api_keys.pop(provider, None)
    cached_models[provider] = []
    if current_provider == provider:
        current_provider = next(iter(api_keys), provider)
    config["api_keys"] = dict(api_keys)
    config["provider"] = current_provider
    config.pop("api_key", None)
    save_config(config)
    return {"status": "ok"}

@app.post("/api/chat")
async def chat(request: ChatRequest):
    """流式聊天补全"""
    provider = request.provider or current_provider
    get_client(provider)  # validate before starting the SSE response

    # 构建消息列表
    messages = []
    if request.system_prompt:
        messages.append({"role": "system", "content": request.system_prompt})

    for msg in request.messages:
        if msg.get("role") == "system":
            continue  # 跳过客户端system消息, 使用服务端统一管理
        messages.append({"role": msg["role"], "content": msg["content"]})

    async def generate():
        """Bridge the blocking OpenAI iterator without blocking FastAPI's event loop."""
        events: queue.Queue[tuple[str, Any]] = queue.Queue()
        stream_holder: dict[str, Any] = {}
        cancelled = threading.Event()

        def run_provider_stream() -> None:
            finish_reason = None
            try:
                client = get_client(provider)
                include_usage = True

                def create_stream(top_p: float):
                    model_options = model_request_options(request.model, top_p, provider)
                    kwargs = dict(
                        model=request.model,
                        messages=messages,
                        temperature=request.temperature,
                        max_tokens=request.max_tokens,
                        stream=True,
                        **model_options,
                    )
                    if provider == "nvidia":
                        kwargs["seed"] = request.seed
                    if include_usage:
                        kwargs["stream_options"] = {"include_usage": True}
                    return client.chat.completions.create(**kwargs)

                effective_top_p = request.top_p
                for attempt, retry_delay in enumerate((0, 2, 5)):
                    if retry_delay:
                        events.put(("status", f"{PROVIDERS[provider]['name']} 限流，{retry_delay} 秒后重试…"))
                        time.sleep(retry_delay)
                    try:
                        stream = create_stream(effective_top_p)
                        break
                    except Exception as first_error:
                        if (getattr(first_error, "status_code", None) in {400, 422}
                                and "stream_options" in str(first_error) and include_usage):
                            include_usage = False
                            stream = create_stream(effective_top_p)
                            break
                        required_top_p = immutable_top_p_from_error(first_error)
                        if required_top_p is not None and required_top_p != effective_top_p:
                            effective_top_p = required_top_p
                            stream = create_stream(effective_top_p)
                            break
                        if getattr(first_error, "status_code", None) == 429 and attempt < 2:
                            continue
                        raise

                stream_holder["stream"] = stream
                for chunk in stream:
                    if cancelled.is_set():
                        break
                    events.put(("chunk", chunk))
                events.put(("done", finish_reason))
            except Exception as error:
                events.put(("error", provider_error_message(error, request.model, provider)))
            finally:
                stream = stream_holder.get("stream")
                if stream is not None:
                    try:
                        stream.close()
                    except Exception:
                        pass
                if 'client' in locals() and hasattr(client, "close"):
                    client.close()

        worker = threading.Thread(
            target=run_provider_stream,
            name=f"{provider.title()}ProviderStream",
            daemon=True,
        )
        worker.start()
        finish_reason = None
        last_activity = time.monotonic()
        try:
            while True:
                try:
                    kind, payload = await asyncio.to_thread(
                        events.get, True, STREAM_HEARTBEAT_SECONDS
                    )
                except queue.Empty:
                    idle_for = time.monotonic() - last_activity
                    if idle_for >= STREAM_IDLE_TIMEOUT_SECONDS:
                        idle_error = (
                            f"{PROVIDERS[provider]['name']} 长时间无响应，"
                            f"已在 {int(idle_for)} 秒后自动停止"
                        )
                        yield f"data: {json.dumps({'error': idle_error}, ensure_ascii=False)}\n\n"
                        break
                    # SSE comments keep browsers/proxies from treating a live
                    # long-running reasoning request as a dead connection.
                    yield ": heartbeat\n\n"
                    continue

                last_activity = time.monotonic()
                if kind == "error":
                    yield f"data: {json.dumps({'error': payload}, ensure_ascii=False)}\n\n"
                    break
                if kind == "status":
                    yield f"data: {json.dumps({'status': payload}, ensure_ascii=False)}\n\n"
                    continue
                if kind == "done":
                    if finish_reason is None:
                        yield f"data: {json.dumps({'error': '供应商响应流提前结束，未返回完成标记；已保留收到的内容，请重试。'}, ensure_ascii=False)}\n\n"
                    else:
                        yield f"data: {json.dumps({'done': True, 'finish_reason': finish_reason})}\n\n"
                    break

                chunk = payload
                usage = getattr(chunk, "usage", None)
                if usage is not None:
                    usage_data = usage.model_dump() if hasattr(usage, "model_dump") else vars(usage)
                    details = usage_data.get("prompt_tokens_details") or {}
                    if not isinstance(details, dict):
                        details = vars(details)
                    normalized = {
                        "prompt_tokens": usage_data.get("prompt_tokens"),
                        "completion_tokens": usage_data.get("completion_tokens"),
                        "total_tokens": usage_data.get("total_tokens"),
                        "cached_tokens": usage_data.get("prompt_cache_hit_tokens", details.get("cached_tokens")),
                    }
                    yield f"data: {json.dumps({'usage': normalized})}\n\n"
                if not getattr(chunk, "choices", None):
                    continue
                if len(chunk.choices) == 0:
                    continue

                choice = chunk.choices[0]
                if getattr(choice, "finish_reason", None):
                    finish_reason = choice.finish_reason

                delta = getattr(choice, "delta", None)
                if delta is None:
                    continue

                reasoning = (
                    getattr(delta, "reasoning_content", None)
                    or getattr(delta, "reasoning", None)
                )
                if reasoning is not None:
                    yield f"data: {json.dumps({'reasoning': reasoning}, ensure_ascii=False)}\n\n"

                content = getattr(delta, "content", None)
                if content is not None:
                    yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            raise
        finally:
            cancelled.set()
            stream = stream_holder.get("stream")
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """上传文件，返回base64 (图片) 或文本内容"""
    content = await file.read()
    content_type = file.content_type or ""
    filename = file.filename or "unknown"

    # 限制文件大小 (20MB)
    max_size = 20 * 1024 * 1024
    if len(content) > max_size:
        raise HTTPException(status_code=413, detail="文件过大，最大支持20MB")

    if content_type.startswith("image/"):
        b64 = base64.b64encode(content).decode("utf-8")
        return {
            "type": "image",
            "filename": filename,
            "content_type": content_type,
            "data_url": f"data:{content_type};base64,{b64}",
            "size": len(content)
        }

    # 文本类文件
    text_extensions = {".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx",
                       ".json", ".xml", ".csv", ".yaml", ".yml", ".log",
                       ".html", ".css", ".java", ".c", ".cpp", ".h", ".rs",
                       ".go", ".rb", ".php", ".sql", ".sh", ".bat", ".toml", ".ini"}
    ext = Path(filename).suffix.lower()
    is_text = content_type.startswith("text/") or ext in text_extensions

    if is_text:
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            try:
                text = content.decode("gbk")
            except UnicodeDecodeError:
                text = content.decode("latin-1", errors="replace")
        return {
            "type": "text",
            "filename": filename,
            "content": text,
            "size": len(content)
        }

    # 其他文件，尝试base64
    b64 = base64.b64encode(content).decode("utf-8")
    return {
        "type": "file",
        "filename": filename,
        "content_type": content_type,
        "data_url": f"data:{content_type};base64,{b64}",
        "size": len(content)
    }

@app.post("/api/config")
async def update_config(cfg: ConfigUpdate):
    """更新配置"""
    updates = cfg.model_dump(exclude_none=True)
    for k, v in updates.items():
        config[k] = v
    save_config(config)
    return {"status": "ok"}

@app.get("/api/config")
async def get_config():
    """获取配置（不含敏感信息）"""
    return public_config()

@app.get("/api/user-data")
async def get_user_data():
    """Return desktop-owned projects and conversations for browser bootstrap."""
    with user_data_lock:
        return load_user_data()


@app.get("/api/user-data/manifest")
async def get_user_data_manifest():
    """Small hash index used by the UI instead of repeatedly loading all chats."""
    with user_data_lock:
        return record_store.manifest()

@app.post("/api/user-data")
async def update_user_data(request: Request):
    """Persist only the known client storage keys outside the WebView profile."""
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="用户数据格式无效")
    cleaned = {k: v for k, v in payload.items() if k in USER_DATA_KEYS}
    encoded_size = len(json.dumps(cleaned, ensure_ascii=False).encode("utf-8"))
    if encoded_size > 100 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="用户数据超过100MB限制")
    with user_data_lock:
        save_user_data(cleaned)
    return {"status": "ok"}


# ── Static files & SPA fallback ────────────────────────────────────────────
static_dir = resource_path("static")
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

@app.get("/")
async def root():
    return FileResponse(str(static_dir / "index.html"))

# ── Main ───────────────────────────────────────────────────────────────────
class DesktopRuntime:
    """Owns every runtime resource and tears them down in reverse order."""

    def __init__(self, host: str = "127.0.0.1", port: int = DESKTOP_PORT):
        self.host = host
        self.port = port
        self.server: Optional[uvicorn.Server] = None
        self.server_thread: Optional[threading.Thread] = None
        self.instance_socket: Optional[socket.socket] = None
        self._stopped = False

    def acquire_single_instance(self) -> bool:
        lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            lock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            lock.bind((self.host, self.port))
            self.instance_socket = lock
            return True
        except OSError:
            lock.close()
            return False

    def start_server(self) -> None:
        # Release the reservation immediately before Uvicorn binds. Only this
        # process can reach here after acquiring the single-instance lock.
        if self.instance_socket:
            self.instance_socket.close()
            self.instance_socket = None
        config = uvicorn.Config(app, host=self.host, port=self.port, log_level="warning")
        self.server = uvicorn.Server(config)
        self.server_thread = threading.Thread(
            target=self.server.run, name="NVIDIAChatServer", daemon=False
        )
        self.server_thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started and self.server_thread.is_alive():
            if time.monotonic() >= deadline:
                raise RuntimeError("本地服务启动超时")
            time.sleep(0.05)
        if not self.server_thread.is_alive():
            raise RuntimeError("本地服务启动失败，端口可能已被占用")
    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self.server:
            self.server.should_exit = True
        if self.server_thread and self.server_thread.is_alive():
            self.server_thread.join(timeout=8)
        if self.server_thread and self.server_thread.is_alive() and self.server:
            self.server.force_exit = True
            self.server_thread.join(timeout=2)
        if self.instance_socket:
            self.instance_socket.close()
            self.instance_socket = None


def run_desktop() -> int:
    from desktop_identity import configure_taskbar_identity
    configure_taskbar_identity()
    import webview

    runtime = DesktopRuntime()
    atexit.register(runtime.stop)
    if not runtime.acquire_single_instance():
        # A running instance already owns the service port.
        return 0
    try:
        runtime.start_server()
        window = webview.create_window(
            "多供应商模型对话",
            f"http://{runtime.host}:{runtime.port}",
            width=1280,
            height=820,
            min_size=(900, 600),
            easy_drag=False,
        )
        window.events.closed += runtime.stop
        webview.start(
            debug=False,
            gui="edgechromium",
            private_mode=False,
            storage_path=str(DATA_DIR / "webview_profile"),
            icon=str(resource_path("static/brand/app.ico")),
        )
        return 0
    finally:
        runtime.stop()


if __name__ == "__main__":
    raise SystemExit(run_desktop())

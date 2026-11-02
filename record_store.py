"""Per-record durable storage and hash manifests for desktop conversations."""
from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path
from typing import Any

WORKSPACES = "nvidia_chat_workspaces"
CONVERSATIONS = "nvidia_chat_conversations"
ACTIVE = "nvidia_chat_active"
SETTINGS = "nvidia_chat_settings"
SYNC_META = "nvidia_chat_sync_meta"
COLLECTIONS = {WORKSPACES: "workspaces", CONVERSATIONS: "conversations"}


def timestamp(item: dict) -> int:
    try:
        return int(item.get("updatedAt") or item.get("createdAt") or 0)
    except (TypeError, ValueError):
        return 0


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def content_hash(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


class RecordStore:
    def __init__(self, root: Path, legacy_file: Path):
        self.root = root
        self.legacy_file = legacy_file
        self.lock = threading.RLock()
        for folder in COLLECTIONS.values():
            (root / folder).mkdir(parents=True, exist_ok=True)
        self.state_file = root / "state.json"
        self.meta_file = root / "sync_meta.json"
        self.manifest_file = root / "manifest.json"
        self._migrate_once()

    def _read_json(self, path: Path, default: Any) -> Any:
        try:
            with path.open("r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, json.JSONDecodeError):
            return default

    def _write_json(self, path: Path, value: Any) -> None:
        temp = path.with_suffix(path.suffix + ".tmp")
        with temp.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        temp.replace(path)

    def _migrate_once(self) -> None:
        marker = self.root / ".migrated-v2"
        if marker.exists():
            return
        legacy = self._read_json(self.legacy_file, {})
        if isinstance(legacy, dict):
            self.save_snapshot(legacy)
        marker.touch()

    def _record_path(self, collection: str, record_id: str) -> Path:
        safe_id = "".join(ch for ch in record_id if ch.isalnum() or ch in "_-.")
        if not safe_id or safe_id != record_id:
            raise ValueError("invalid record id")
        return self.root / COLLECTIONS[collection] / f"{safe_id}.json"

    def records(self, collection: str) -> dict[str, dict]:
        result = {}
        for path in (self.root / COLLECTIONS[collection]).glob("*.json"):
            item = self._read_json(path, None)
            if isinstance(item, dict) and item.get("id"):
                result[item["id"]] = item
        return result

    def tombstones(self) -> dict[str, int]:
        meta = self._read_json(self.meta_file, {})
        return {str(k): int(v) for k, v in (meta.get("tombstones") or {}).items()}

    def load_snapshot(self) -> dict:
        with self.lock:
            state = self._read_json(self.state_file, {})
            return {
                WORKSPACES: list(self.records(WORKSPACES).values()),
                CONVERSATIONS: list(self.records(CONVERSATIONS).values()),
                ACTIVE: state.get(ACTIVE, {}),
                SETTINGS: state.get(SETTINGS, {}),
                SYNC_META: {"tombstones": self.tombstones()},
            }

    def save_snapshot(self, data: dict) -> dict[str, list[str]]:
        changed = {WORKSPACES: [], CONVERSATIONS: []}
        with self.lock:
            incoming_tombstones = (data.get(SYNC_META) or {}).get("tombstones") or {}
            tombstones = self.tombstones()
            old_tombstones = dict(tombstones)
            for record_id, deleted_at in incoming_tombstones.items():
                tombstones[str(record_id)] = max(tombstones.get(str(record_id), 0), int(deleted_at))
            if tombstones != old_tombstones or not self.meta_file.exists():
                self._write_json(self.meta_file, {"tombstones": tombstones})
            for collection in COLLECTIONS:
                for item in data.get(collection) or []:
                    if not isinstance(item, dict) or not item.get("id"):
                        continue
                    path = self._record_path(collection, item["id"])
                    old = self._read_json(path, None)
                    if tombstones.get(item["id"], 0) >= timestamp(item):
                        if path.exists():
                            path.unlink()
                        continue
                    if old != item:
                        self._write_json(path, item)
                        changed[collection].append(item["id"])
            for collection in COLLECTIONS:
                for record_id, deleted_at in tombstones.items():
                    path = self._record_path(collection, record_id)
                    old = self._read_json(path, None)
                    if old and deleted_at >= timestamp(old):
                        path.unlink(missing_ok=True)
                        if record_id not in changed[collection]:
                            changed[collection].append(record_id)
            state = self._read_json(self.state_file, {})
            for key in (ACTIVE, SETTINGS):
                if key in data:
                    state[key] = data[key]
            if self._read_json(self.state_file, {}) != state:
                self._write_json(self.state_file, state)
            self._update_manifest(changed, tombstones, tombstones != old_tombstones)
        return changed

    def manifest(self) -> dict:
        with self.lock:
            cached = self._read_json(self.manifest_file, {})
            if not all(isinstance(cached.get(key), dict) for key in COLLECTIONS):
                cached = {
                    collection: {
                        record_id: {"hash": content_hash(item), "updatedAt": timestamp(item)}
                        for record_id, item in self.records(collection).items()
                    }
                    for collection in COLLECTIONS
                }
                cached["tombstones"] = self.tombstones()
                self._write_json(self.manifest_file, cached)
            return cached

    def _update_manifest(self, changed: dict[str, list[str]], tombstones: dict, meta_changed: bool) -> None:
        cached = self._read_json(self.manifest_file, {})
        if not all(isinstance(cached.get(key), dict) for key in COLLECTIONS):
            cached = {key: {} for key in COLLECTIONS}
            for collection in COLLECTIONS:
                for record_id, item in self.records(collection).items():
                    cached[collection][record_id] = {
                        "hash": content_hash(item), "updatedAt": timestamp(item),
                    }
            meta_changed = True
        has_changes = meta_changed
        for collection in COLLECTIONS:
            for record_id in changed.get(collection, []):
                has_changes = True
                path = self._record_path(collection, record_id)
                item = self._read_json(path, None)
                if isinstance(item, dict):
                    cached[collection][record_id] = {
                        "hash": content_hash(item), "updatedAt": timestamp(item),
                    }
                else:
                    cached[collection].pop(record_id, None)
        cached["tombstones"] = tombstones
        if has_changes or not self.manifest_file.exists():
            self._write_json(self.manifest_file, cached)

    def selected(self, wanted: dict[str, list[str]]) -> dict:
        with self.lock:
            result = {}
            for collection in COLLECTIONS:
                available = self.records(collection)
                result[collection] = [available[item_id] for item_id in wanted.get(collection, []) if item_id in available]
            return result

    def apply_records(self, records: dict, tombstones: dict | None = None) -> dict[str, list[str]]:
        payload = dict(records)
        payload[SYNC_META] = {"tombstones": tombstones or {}}
        return self.save_snapshot(payload)

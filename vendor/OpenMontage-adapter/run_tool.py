#!/usr/bin/env python3
"""Persistent JSON-lines bridge to OpenMontage tools.

Protocol (one JSON object per line, both directions):

  In:   {"id": "<req-id>", "tool": "<tool.name>", "args": { ... }}
  In:   {"id": "<req-id>", "op": "shutdown"}

  Out:  {"id":"<req-id>","event":"progress","pct":42,"message":"..."}        (optional, 0+)
  Out:  {"id":"<req-id>","event":"result","ok":true,"result": { ... }}
  Out:  {"id":"<req-id>","event":"result","ok":false,"error":"...","traceback":"..."}

Exactly one terminal `result` line per request. stdout is line-buffered.

The bridge runs tools sequentially. Each line is processed in order.
"""
from __future__ import annotations

import json
import sys
import traceback
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any


def _repo_root() -> Path:
    return (Path(__file__).resolve().parent.parent / "OpenMontage").resolve()


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _serialize(v: Any) -> Any:
    if is_dataclass(v):
        return asdict(v)
    if isinstance(v, dict):
        return {k: _serialize(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_serialize(x) for x in v]
    if isinstance(v, Path):
        return str(v)
    return v


def main() -> int:
    om_root = _repo_root()
    sys.path.insert(0, str(om_root))

    try:
        from tools.tool_registry import registry  # type: ignore
    except Exception as e:
        _emit({
            "id": None, "event": "fatal",
            "error": f"Could not import tools.tool_registry: {e}",
            "traceback": traceback.format_exc(),
        })
        return 3

    try:
        registry.ensure_discovered()
    except Exception as e:
        _emit({
            "id": None, "event": "fatal",
            "error": f"Discovery failed: {e}",
            "traceback": traceback.format_exc(),
        })
        return 4

    _emit({"id": None, "event": "ready", "tools": len(registry.list_all())})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as e:
            _emit({"id": None, "event": "result", "ok": False, "error": f"invalid json: {e}"})
            continue

        req_id = req.get("id")
        if req.get("op") == "shutdown":
            _emit({"id": req_id, "event": "result", "ok": True, "result": {"shutdown": True}})
            return 0

        tool_name = req.get("tool")
        args = req.get("args") or {}

        if not tool_name:
            _emit({"id": req_id, "event": "result", "ok": False, "error": "missing 'tool' field"})
            continue

        tool = registry.get(tool_name)
        if tool is None:
            _emit({
                "id": req_id, "event": "result", "ok": False,
                "error": f"unknown tool: {tool_name}",
                "available_sample": registry.list_all()[:20],
            })
            continue

        try:
            result = tool.execute(args)
            payload = _serialize(result)
            _emit({"id": req_id, "event": "result", "ok": True, "result": payload})
        except Exception as e:
            _emit({
                "id": req_id, "event": "result", "ok": False,
                "error": str(e), "traceback": traceback.format_exc(),
            })

    return 0


if __name__ == "__main__":
    sys.exit(main())

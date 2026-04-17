#!/usr/bin/env python3
"""One-shot discovery dump.

Writes a JSON document to stdout describing:
  - pipelines: [{ id, path, name }]
  - tools:     support envelope (name -> contract)   [only with --warm]
  - providers: provider menu grouped by capability   [only with --warm]

Usage:
  python vendor/OpenMontage-adapter/list_pipelines.py [--warm]

Without --warm, tool/provider discovery is skipped so the call returns quickly
even before the venv is populated. With --warm, the tool registry is loaded
(slower on cold caches).

Safe to run without API keys — tools just report status=unavailable.
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path


def _repo_root() -> Path:
    return (Path(__file__).resolve().parent.parent / "OpenMontage").resolve()


def main() -> int:
    parser = argparse.ArgumentParser(description="Dump OpenMontage pipelines + tool registry")
    parser.add_argument("--warm", action="store_true", help="discover and include tools/providers")
    args = parser.parse_args()

    om_root = _repo_root()
    if not (om_root / "tools").is_dir():
        print(json.dumps({"error": f"OpenMontage not found at {om_root}"}))
        return 2

    sys.path.insert(0, str(om_root))

    # Always enumerate pipelines (cheap; no imports required).
    pipelines = []
    pdir = om_root / "pipeline_defs"
    if pdir.is_dir():
        for yml in sorted(pdir.glob("*.yaml")):
            pipelines.append({
                "id": yml.stem,
                "path": str(yml.relative_to(om_root)),
                "name": yml.stem.replace("-", " ").replace("_", " ").title(),
            })

    output = {
        "pipelines": pipelines,
        "skills_root": "skills",
        "pipeline_defs_root": "pipeline_defs",
        "schemas_root": "schemas",
        "om_root": str(om_root),
    }

    if args.warm:
        try:
            from tools.tool_registry import registry  # type: ignore
        except Exception as e:
            output["tools_error"] = f"Could not import tools.tool_registry: {e}"
            output["traceback"] = traceback.format_exc()
            print(json.dumps(output, indent=2, default=str))
            return 0

        try:
            registry.ensure_discovered()
            output["tools"] = registry.support_envelope()
            output["providers"] = registry.provider_menu()
        except Exception as e:
            output["tools_error"] = str(e)
            output["traceback"] = traceback.format_exc()

    print(json.dumps(output, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())

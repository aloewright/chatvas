#!/usr/bin/env python3
"""One-shot discovery dump.

Writes a JSON document to stdout describing:
  - pipelines: { id, path, name, description, raw }
  - tools:     support envelope (name -> contract)
  - providers: provider menu grouped by capability
  - skills_root, pipeline_defs_root, schemas_root

Intended to be called from Node to cache the registry on disk. Safe to run
without any API keys (tools just report status=unavailable).

Usage:
  python vendor/OpenMontage-adapter/list_pipelines.py [--warm]
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path


def _repo_root() -> Path:
    # This file lives at vendor/OpenMontage-adapter/list_pipelines.py
    # OpenMontage root is the sibling dir vendor/OpenMontage
    return (Path(__file__).resolve().parent.parent / "OpenMontage").resolve()


def main() -> int:
    om_root = _repo_root()
    if not (om_root / "tools").is_dir():
        print(json.dumps({"error": f"OpenMontage not found at {om_root}"}))
        return 2

    # Make OpenMontage importable.
    sys.path.insert(0, str(om_root))

    try:
        from tools.tool_registry import registry  # type: ignore
    except Exception as e:
        print(json.dumps({
            "error": f"Could not import tools.tool_registry: {e}",
            "traceback": traceback.format_exc(),
        }))
        return 3

    try:
        registry.ensure_discovered()
    except Exception as e:
        # Still report what we have; discovery may partially succeed.
        print(json.dumps({
            "error": f"Discovery failed: {e}",
            "traceback": traceback.format_exc(),
        }, indent=2))
        return 4

    pipelines = []
    pdir = om_root / "pipeline_defs"
    if pdir.is_dir():
        for yml in sorted(pdir.glob("*.yaml")):
            pipelines.append({
                "id": yml.stem,
                "path": str(yml.relative_to(om_root)),
                "name": yml.stem.replace("-", " ").replace("_", " ").title(),
            })

    try:
        tools = registry.support_envelope()
    except Exception as e:
        tools = {"__error__": str(e)}

    try:
        providers = registry.provider_menu()
    except Exception as e:
        providers = {"__error__": str(e)}

    output = {
        "pipelines": pipelines,
        "tools": tools,
        "providers": providers,
        "skills_root": str((om_root / "skills").relative_to(om_root)),
        "pipeline_defs_root": "pipeline_defs",
        "schemas_root": "schemas",
        "om_root": str(om_root),
    }
    print(json.dumps(output, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())

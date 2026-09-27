#!/usr/bin/env sh
set -eu

# src/ uses PEP 604 unions without `from __future__ import annotations`, so the
# interpreter must be 3.12+. mypy's python_version setting does not enforce this:
# a 3.9 venv type-checks clean and then fails at import.

if command -v uv >/dev/null 2>&1; then
  uv venv --python 3.12 .venv
  uv pip install --python .venv/bin/python --quiet -r requirements.txt
  exit 0
fi

for candidate in python3.12 python3.13 python3; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 12))' || continue
  "$candidate" -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet -r requirements.txt
  exit 0
done

echo "apps/backend needs Python >= 3.12 or uv. Found: $(python3 --version 2>&1)" >&2
exit 1

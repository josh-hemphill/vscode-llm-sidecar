#!/usr/bin/env bash
set -euo pipefail

VSIX="${1:?usage: publish-marketplace.sh path/to/llm-sidecar-x.y.z.vsix}"

if [[ -z "${VSCE_PAT:-}" ]]; then
  echo "publish-marketplace: VSCE_PAT is not set" >&2
  exit 1
fi

vsce publish "$VSIX" --pat "$VSCE_PAT"

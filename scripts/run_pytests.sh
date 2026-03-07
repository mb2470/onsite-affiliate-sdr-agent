#!/usr/bin/env bash
set -euo pipefail

OUTPUT_FILE="${1:-test_results.txt}"
pytest --cov=./ > "$OUTPUT_FILE" 2>&1
cat "$OUTPUT_FILE"

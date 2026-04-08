#!/bin/bash
# Start Image Studio with all env vars loaded
set -a
source ~/.luna/secrets/keys.env
set +a
cd "$(dirname "$0")"
echo "Image Studio: http://localhost:3000"
exec bun run index.ts

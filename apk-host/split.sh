#!/usr/bin/env bash
# Usage: split.sh path/to/app.apk   -> fills public/parts with <=20 MiB parts + manifest.json
set -euo pipefail
apk="$1"
dir="$(cd "$(dirname "$0")" && pwd)/public/parts"
rm -rf "$dir" && mkdir -p "$dir"
split -b 20m -d -a 2 "$apk" "$dir/part-"
size=$(stat -c %s "$apk")
sha=$(sha256sum "$apk" | cut -d' ' -f1)
parts=$(cd "$dir" && ls part-* | python3 -c 'import sys,json;print(json.dumps([l.strip() for l in sys.stdin]))')
printf '{"size":%s,"sha256":"%s","builtAt":"%s","parts":%s}\n' "$size" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$parts" > "$dir/manifest.json"
cat "$dir/manifest.json"

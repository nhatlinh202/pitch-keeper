#!/bin/bash
# Pitch Keeper — cài bản mới nhất từ GitHub Release (macOS).
#   curl -fsSL https://github.com/nhatlinh202/pitch-keeper/releases/latest/download/install.sh | bash
# Sau lần cài này, panel tự cập nhật các bản sau.
set -euo pipefail

REPO="nhatlinh202/pitch-keeper"
BASE="${PK_BASE:-https://github.com/$REPO/releases/latest/download}"  # PK_BASE: chỉ dùng khi test
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/PitchKeeper"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "→ Đọc thông tin bản mới nhất…"
curl -fsSL "$BASE/version.json" -o "$tmp/version.json"
json() { /usr/bin/plutil -extract "$1" raw -o - "$tmp/version.json"; }
version="$(json version)"
url="$(json url)"
sha="$(json sha256)"

echo "→ Tải Pitch Keeper $version…"
curl -fsSL "$url" -o "$tmp/pk.zip"
actual="$(shasum -a 256 "$tmp/pk.zip" | awk '{print $1}')"
if [ "$actual" != "$sha" ]; then
    echo "✗ Sai sha256 — file tải về bị lỗi, đã huỷ." >&2
    exit 1
fi

/usr/bin/ditto -x -k "$tmp/pk.zip" "$tmp/x"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mv "$tmp/x/PitchKeeper" "$DEST"

# Cho phép Premiere nạp extension chưa ký
for v in 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

echo "✓ Đã cài Pitch Keeper $version"
echo "  Khởi động lại Premiere Pro → Window › Extensions › Pitch Keeper"

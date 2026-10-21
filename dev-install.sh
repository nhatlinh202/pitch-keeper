#!/bin/bash
# Cài bản đang phát triển (thư mục PitchKeeper/ trong repo) vào Premiere Pro trên máy này (macOS).
# Đồng nghiệp dùng bộ cài .pkg hoặc install.sh trên GitHub Release, không dùng script này.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/PitchKeeper"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/PitchKeeper"

# Cho phép chạy extension chưa ký (unsigned)
for v in 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

mkdir -p "$DEST"
rsync -a --delete --exclude .DS_Store "$SRC/" "$DEST/"
echo "Đã cài bản $(cat "$SRC/VERSION") vào: $DEST"
echo "Khởi động lại Premiere Pro → Window > Extensions > Pitch Keeper"

#!/bin/bash
# Phát hành Pitch Keeper lên GitHub Release.
#   ./release.sh 1.0.1 "Ghi chú thay đổi"
#   ./release.sh 1.0.1 "Ghi chú thay đổi" --dry-run   # chỉ build vào dist/, không commit / push / phát hành
# Panel trên máy đồng nghiệp đọc version.json của bản mới nhất và tự cập nhật.
set -euo pipefail

REPO="nhatlinh202/pitch-keeper"
cd "$(dirname "$0")"

version="${1:?Cách dùng: ./release.sh <x.y.z> \"ghi chú\" [--dry-run]}"
notes="${2:?Thiếu ghi chú thay đổi}"
dry="${3:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "✗ Phiên bản phải có dạng x.y.z" >&2; exit 1; }
tag="v$version"

if [ "$dry" != "--dry-run" ]; then
    gh auth status >/dev/null 2>&1 || { echo "✗ Chưa đăng nhập: chạy gh auth login" >&2; exit 1; }
    [ -z "$(git status --porcelain)" ] || { echo "✗ Còn thay đổi chưa commit" >&2; exit 1; }
    if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then echo "✗ Tag $tag đã tồn tại" >&2; exit 1; fi
fi

echo "$version" > PitchKeeper/VERSION

echo "→ Đóng gói $tag…"
rm -rf dist
mkdir -p dist/stage dist/pkgroot
rsync -a --exclude .DS_Store PitchKeeper dist/stage/
rsync -a --exclude .DS_Store PitchKeeper dist/pkgroot/
xattr -cr dist/stage dist/pkgroot
(cd dist/stage && /usr/bin/ditto -c -k --norsrc --noextattr --noqtn --keepParent PitchKeeper ../PitchKeeper.zip)
sha="$(shasum -a 256 dist/PitchKeeper.zip | awk '{print $1}')"

node -e '
const [version, url, sha256, notes, out] = process.argv.slice(1);
require("fs").writeFileSync(out, JSON.stringify({ version, url, sha256, notes, date: new Date().toISOString() }, null, 2) + "\n");
' "$version" "https://github.com/$REPO/releases/download/$tag/PitchKeeper.zip" "$sha" "$notes" dist/version.json

chmod +x scripts/pkg/postinstall
COPYFILE_DISABLE=1 pkgbuild --quiet --root dist/pkgroot --install-location /private/tmp/PitchKeeper-pkg \
    --scripts scripts/pkg --identifier com.crossian.pitchkeeper --version "$version" dist/PitchKeeper.pkg
cp scripts/install.sh dist/install.sh
rm -rf dist/stage dist/pkgroot
echo "✓ dist/: $(ls dist | tr '\n' ' ')"

if [ "$dry" = "--dry-run" ]; then
    echo "(dry-run) Không phát hành."
    exit 0
fi

if ! git diff --quiet -- PitchKeeper/VERSION; then
    git add PitchKeeper/VERSION
    git commit -q -m "Release $tag"
fi
git tag "$tag"
git push -q origin HEAD "$tag"

body="$notes

## Cài lần đầu
- **Bấm đúp:** tải \`PitchKeeper.pkg\` bên dưới → bấm đúp → Continue → Install. Nếu macOS chặn: System Settings › Privacy & Security › **Open Anyway**.
- **Terminal:** \`curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash\`

Sau đó khởi động lại Premiere Pro → Window › Extensions › Pitch Keeper. Các bản sau panel tự cập nhật."

gh release create "$tag" dist/PitchKeeper.zip dist/PitchKeeper.pkg dist/version.json dist/install.sh \
    --repo "$REPO" --title "Pitch Keeper $version" --notes "$body"
echo "✓ Đã phát hành: https://github.com/$REPO/releases/tag/$tag"

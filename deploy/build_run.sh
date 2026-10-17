#!/bin/bash
# build_run.sh - Build zdashboard.run using c2r
# Usage: bash deploy/build_run.sh [VERSION]
# Output: zbuild/ (zdashboard.run, zdashboard-VERSION.tar.gz, Dockerfile, docker-compose.yml)
#
# VERSION: optional, defaults to package.json version

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/zbuild"
C2R="${C2R:-$SCRIPT_DIR/c2r.sh}"

# Version: explicit arg, or read from package.json
if [ -n "$1" ]; then
    VERSION="$1"
else
    VERSION=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")
fi
IMAGE_TAG="zdashboard:$VERSION"

echo "=== zDashboard .run Builder (c2r) ==="
echo "Version: $VERSION"
echo "Image:   $IMAGE_TAG"
echo "c2r:     $C2R"
echo ""

# Step 1: Build Docker image with versioned tag
echo "[1/4] Building Docker image..."
docker build -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE_TAG" "$PROJECT_DIR"
# Also tag as latest for convenience
docker tag "$IMAGE_TAG" zdashboard:latest

# Step 2: Export image tar (standalone, for manual docker load)
echo "[2/4] Exporting image tar..."
mkdir -p "$BUILD_DIR"
docker save "$IMAGE_TAG" | gzip > "$BUILD_DIR/zdashboard-$VERSION.tar.gz"

# Step 3: Package with c2r (daemon mode for long-running service)
#   Temporarily rewrite compose image to use versioned tag
echo "[3/4] Packaging with c2r..."
COMPOSE_TMP="$BUILD_DIR/docker-compose.yml"
sed "s|zdashboard:latest|$IMAGE_TAG|g" "$SCRIPT_DIR/docker-compose.yml" > "$COMPOSE_TMP"
bash "$C2R" build -f "$COMPOSE_TMP" -o "$BUILD_DIR/zdashboard.run" -d
rm -f "$COMPOSE_TMP"

# Step 4: Copy build files for reference
echo "[4/4] Copying build files..."
cp "$SCRIPT_DIR/Dockerfile" "$BUILD_DIR/Dockerfile"
cp "$SCRIPT_DIR/docker-compose.yml" "$BUILD_DIR/docker-compose.yml"

# Summary
echo ""
echo "=== Build Complete ==="
echo ""
ls -lh "$BUILD_DIR/"
echo ""
echo "Run it with:"
echo "  export ZDB_PATH=/path/to/zdb.db   # 宿主机上的库文件（先 touch）"
echo "  export ZDASHBOARD_PORT=3100        # 宿主机端口"
echo "  ./zbuild/zdashboard.run"

#!/usr/bin/env bash
# 由 zdashboard 项目管理器写入的期望状态 → /etc/nginx/conf.d/zdashboard-projects.conf
#
# 运行身份：root（systemd path unit 触发）
# 安全边界：只接受 zdashboard 生成的文件（首行标记 + 端口段校验），nginx -t 失败自动回滚。
set -euo pipefail

STATE_DIR="${PM_STATE_DIR:-/home/tony/zdata/zdashboard}"
SRC="$STATE_DIR/pm-nginx.conf"
STATUS="$STATE_DIR/pm-nginx-status.json"
DEST="/etc/nginx/conf.d/zdashboard-projects.conf"
BACKUP="/etc/nginx/conf.d/.zdashboard-projects.conf.prev"
TMPLOG="$(mktemp)"
trap 'rm -f "$TMPLOG"' EXIT

write_status() {
    local ok="$1" msg="$2"
    local now
    now="$(date -Iseconds)"
    printf '{"ok":%s,"at":"%s","message":"%s"}\n' "$ok" "$now" "$msg" > "$STATUS.tmp"
    chown tony:tony "$STATUS.tmp" 2>/dev/null || true
    chmod 644 "$STATUS.tmp"
    mv "$STATUS.tmp" "$STATUS"
}

fail() {
    echo "[zdashboard-nginx] $1" >&2
    write_status false "$1"
    exit 1
}

[ -f "$SRC" ] || fail "期望状态文件不存在"
head -1 "$SRC" | grep -q '^# Managed by zdashboard (project manager)\. DO NOT EDIT\.$' \
    || fail "首行标记不匹配（拒绝应用非托管文件）"
[ "$(stat -c%s "$SRC")" -lt 1048576 ] || fail "配置文件过大"

# 端口段校验：18130-18189 / 12710-12799
while read -r port; do
    [ "$port" -ge 18130 ] && [ "$port" -le 18189 ] || fail "对外端口越界: $port"
done < <(grep -E '^[[:space:]]*listen ' "$SRC" | grep -oE '[0-9]{4,5}' || true)
while read -r port; do
    [ "$port" -ge 12710 ] && [ "$port" -le 12799 ] || fail "上游端口越界: $port"
done < <(grep -E '^[[:space:]]*proxy_pass ' "$SRC" | grep -oE '127\.0\.0\.1:[0-9]+' | cut -d: -f2 || true)

cp -a "$DEST" "$BACKUP" 2>/dev/null || true
install -m 0644 -o root -g root "$SRC" "$DEST"

if ! nginx -t >"$TMPLOG" 2>&1; then
    cat "$TMPLOG" >&2
    if [ -f "$BACKUP" ]; then cp -a "$BACKUP" "$DEST"; else rm -f "$DEST"; fi
    fail "nginx -t 失败（已回滚）"
fi

if ! systemctl reload nginx >"$TMPLOG" 2>&1; then
    cat "$TMPLOG" >&2
    if [ -f "$BACKUP" ]; then cp -a "$BACKUP" "$DEST"; else rm -f "$DEST"; fi
    systemctl reload nginx >/dev/null 2>&1 || true
    fail "nginx reload 失败（已回滚）"
fi

COUNT="$(grep -c '^server {' "$SRC" || true)"
write_status true "applied ${COUNT} project(s)"
echo "[zdashboard-nginx] applied ${COUNT} project(s)"

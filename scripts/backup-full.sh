#!/usr/bin/env bash
# 全量可恢复备份：数据库逻辑备份 + 产物卷归档，一次产出「真能恢复」的快照。
#
# 为什么需要它：应用内的 GET /api/admin/backup 只导出**数据库行**（JSON 快照），
# 不含 uploads 卷里的文件。恢复它之后，MediaAsset 的行全在，但 floorplanAssetId /
# renderAssetIds 指向的文件一个都不存在 —— 方案直接残缺。这不是理论风险，
# 是「备份看起来成功、恢复后数据是坏的」最典型的一种。
#
# 这个脚本补上缺的那一半：pg_dump（库）+ tar（卷），两份合起来才是一次完整快照。
#
# 用法：
#   bash scripts/backup-full.sh              # 备份到 backups/full/<时间戳>/
#   BACKUP_KEEP=5 bash scripts/backup-full.sh   # 保留 5 份（默认 3）
#
# 恢复见 scripts/restore-full.sh。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

BACKUP_DIR="${BACKUP_DIR:-backups/full}"
BACKUP_KEEP="${BACKUP_KEEP:-3}"
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { printf '%s\n' "${GREEN}✓${OFF} $1"; }
note() { printf '%s\n' "${DIM}  $1${OFF}"; }
die()  { printf '%s\n' "${RED}✗${OFF} $1" >&2; exit 1; }

API_CID=$(docker compose ps -q api 2>/dev/null)
DB_CID=$(docker compose ps -q db 2>/dev/null)
[ -n "$API_CID" ] || die "api 容器未运行，无法归档 uploads 卷（docker compose up -d 后重试）"
[ -n "$DB_CID" ] || die "db 容器未运行，无法做数据库备份"

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="${BACKUP_DIR}/${STAMP}"
mkdir -p "$DEST" || die "无法创建备份目录 ${DEST}"

note "备份目录 ${DEST}"

# --- 1. 数据库逻辑备份（custom 格式，可 pg_restore 单表恢复）---
# 用 -Fc 而不是 SQL 文本：体积小一个数量级，且支持 --table 单表恢复。
# 不加 -f 参数时 pg_dump 写 stdout，用重定向接住；pipefail 保证失败不会被吞。
if docker exec "$DB_CID" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "${DEST}/db.dump"; then
  ok "数据库备份完成（$(du -h "${DEST}/db.dump" | cut -f1)）"
else
  die "数据库备份失败，目录已保留在 ${DEST} 供排查"
fi

# --- 2. 产物卷归档（uploads 是独立卷，必须单独打）---
# 注意：备份目录绝不能放在 api-uploads 卷内，否则备份会把自己又打进去，越滚越大。
# 挂载点从容器实际挂载信息里取（不硬编码卷名：compose 项目名一变就失效，且失效是静默的）
UPLOAD_MOUNT=$(docker inspect "$API_CID" --format '{{range .Mounts}}{{if eq .Destination "/repo/uploads"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
if [ -n "$UPLOAD_MOUNT" ]; then
  case "$(cd "$BACKUP_DIR" 2>/dev/null && pwd -P)" in
    "${UPLOAD_MOUNT}"*)
      die "备份目录不能放在 uploads 卷内（会自我递归打包）"
      ;;
  esac
fi

if docker exec "$API_CID" tar -C /repo/uploads -cf - . | gzip -1 > "${DEST}/uploads.tar.gz"; then
  ok "产物卷归档完成（$(du -h "${DEST}/uploads.tar.gz" | cut -f1)）"
else
  die "产物卷归档失败，目录已保留在 ${DEST} 供排查"
fi

# --- 3. 清单：字节数 + 校验和，恢复前先验完整性 ---
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
DB_SUM=$(sha256_of "${DEST}/db.dump")
UP_SUM=$(sha256_of "${DEST}/uploads.tar.gz")
DB_SIZE=$(wc -c < "${DEST}/db.dump" | tr -d ' ')
UP_SIZE=$(wc -c < "${DEST}/uploads.tar.gz" | tr -d ' ')

node -e '
const fs = require("fs");
const [dest, dbSum, upSum, dbSize, upSize, keep] = process.argv.slice(1);
fs.writeFileSync(dest + "/manifest.json", JSON.stringify({
  createdAt: new Date().toISOString(),
  pieces: {
    db: { file: "db.dump", bytes: Number(dbSize), sha256: dbSum },
    uploads: { file: "uploads.tar.gz", bytes: Number(upSize), sha256: upSum },
  },
  note: "恢复用 bash scripts/restore-full.sh <备份目录>",
}, null, 2));
' "$DEST" "$DB_SUM" "$UP_SUM" "$DB_SIZE" "$UP_SIZE" "$BACKUP_KEEP"
ok "清单已写入 manifest.json（含 sha256，恢复前可验完整性）"

# --- 4. 份数上限：备份本身不能成为「挤爆硬盘」的那一个 ---
# 每次全量备份 = 库 + 产物卷，体积不小；不留上限的话，脚本跑得越多磁盘越满。
COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -name '20*' 2>/dev/null | wc -l | tr -d ' ')
if [ "${COUNT:-0}" -gt "$BACKUP_KEEP" ]; then
  # 目录名是时间戳（YYYYMMDD-HHMMSS），字典序即时间序；
  # 不用 ls -t + xargs —— xargs 会分批调用，每批各自排序，结果是乱的。
  find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -name '20*' 2>/dev/null | sort -r \
    | tail -n "+$((BACKUP_KEEP + 1))" \
    | while IFS= read -r old; do
        rm -rf "$old" && note "已删除超出保留上限的旧备份 ${old}"
      done
  ok "备份保留上限 ${BACKUP_KEEP} 份已生效"
else
  ok "当前 ${COUNT} 份，在保留上限 ${BACKUP_KEEP} 份内"
fi

TOTAL=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
note "备份目录总占用 ${TOTAL}"
ok "完成：${DEST}"

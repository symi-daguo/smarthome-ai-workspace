#!/usr/bin/env bash
# 从 scripts/backup-full.sh 产出的备份恢复：数据库 + 产物卷一起回到快照时刻。
#
# 为什么必须两份一起恢复：只恢复数据库，MediaAsset 的行全在，但它们指向的文件
# 一个都不在（文件在 uploads 卷里）。于是「恢复成功」却得到一个残缺的产品。
# 反过来只恢复卷，数据库里的行是旧的，两边对不上。
#
# 用法：
#   bash scripts/restore-full.sh backups/full/20261024-120000          # 预演（不落盘）
#   bash scripts/restore-full.sh backups/full/20261024-120000 --yes    # 真恢复
#   bash scripts/restore-full.sh backups/full/20261024-120000 --yes --merge
#       # --merge：不清空产物卷，直接覆盖（保留快照之外的新文件）
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

SRC="${1:-}"
ASSUME_YES=0
MERGE=0
for a in "$@"; do
  case "$a" in
    --yes) ASSUME_YES=1 ;;
    --merge) MERGE=1 ;;
  esac
done

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { printf '%s\n' "${GREEN}✓${OFF} $1"; }
warn() { printf '%s\n' "${YELLOW}!${OFF} $1"; }
note() { printf '%s\n' "${DIM}  $1${OFF}"; }
die()  { printf '%s\n' "${RED}✗${OFF} $1" >&2; exit 1; }

[ -n "$SRC" ] || die "用法：bash scripts/restore-full.sh <备份目录> [--yes] [--merge]"
[ -d "$SRC" ] || die "备份目录不存在：${SRC}"
[ -f "${SRC}/db.dump" ] || die "缺少 db.dump：${SRC}"
[ -f "${SRC}/uploads.tar.gz" ] || die "缺少 uploads.tar.gz：${SRC}"
[ -f "${SRC}/manifest.json" ] || warn "没有 manifest.json，跳过完整性校验"

API_CID=$(docker compose ps -aq api 2>/dev/null | head -1)
DB_CID=$(docker compose ps -q db 2>/dev/null)
[ -n "$API_CID" ] || die "找不到 api 容器"
[ -n "$DB_CID" ] || die "db 容器未运行"

# api 容器在恢复期间要停掉（防止它继续写库写文件，写出混合状态）。
# 但「停掉」也意味着不能再 docker exec 进去 —— 而产物卷的清空与解包正是要在卷里做的。
# 所以卷操作改用**一次性临时容器**挂同一个卷：
# 既保住「恢复全程 api 不写盘」这个前提，又不用把 api 拉起来。
# 临时容器复用 api 自己的镜像（本机已有，不联网拉取）。
API_IMAGE=$(docker inspect "$API_CID" --format '{{.Config.Image}}' 2>/dev/null)
UPLOAD_VOL=$(docker inspect "$API_CID" --format '{{range .Mounts}}{{if eq .Destination "/repo/uploads"}}{{.Name}}{{end}}{{end}}' 2>/dev/null)
[ -n "$API_IMAGE" ] || die "读不到 api 镜像名"
[ -n "$UPLOAD_VOL" ] || die "读不到 uploads 卷名"
API_WAS_UP=$(docker inspect "$API_CID" --format '{{.State.Running}}' 2>/dev/null)

# --- 1. 完整性校验：备份文件损坏却照着恢复，等于用坏数据盖住好数据 ---
if [ -f "${SRC}/manifest.json" ]; then
  sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
    else shasum -a 256 "$1" | awk '{print $1}'; fi
  }
  EXP_DB=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pieces.db.sha256)' "${SRC}/manifest.json")
  EXP_UP=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pieces.uploads.sha256)' "${SRC}/manifest.json")
  CUR_DB=$(sha256_of "${SRC}/db.dump")
  CUR_UP=$(sha256_of "${SRC}/uploads.tar.gz")
  [ "$EXP_DB" = "$CUR_DB" ] || die "db.dump 校验和不符，备份已损坏，拒绝恢复"
  [ "$EXP_UP" = "$CUR_UP" ] || die "uploads.tar.gz 校验和不符，备份已损坏，拒绝恢复"
  ok "两份备份 sha256 校验通过"
fi

# --- 2. 预演模式 ---
if [ "$ASSUME_YES" != 1 ]; then
  echo ""
  echo "将要执行（预演，未落盘）："
  note "数据库：pg_restore --clean --if-exists（先清空后重建，覆盖当前库）"
  if [ "$MERGE" = 1 ]; then
    note "产物卷：直接覆盖解包，不清空（--merge）"
  else
    note "产物卷：先清空 /repo/uploads 再解包（与数据库语义一致）"
  fi
  note "api 容器会先停，恢复完成后重新启动"
  echo ""
  echo "确认无误后加 --yes 重跑："
  echo "  bash scripts/restore-full.sh ${SRC} --yes"
  exit 0
fi

# --- 3. 停 api：恢复期间它还在写库/写文件，会把快照覆盖成混合状态 ---
note "停止 api 容器（防止恢复期间继续写入）"
docker compose stop api >/dev/null 2>&1 || warn "停止 api 失败，继续（可能写入冲突）"

RESTORE_FAILED=0

# --- 4. 数据库恢复 ---
note "恢复数据库"
if docker exec -i "$DB_CID" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "${SRC}/db.dump"; then
  ok "数据库恢复完成"
else
  # pg_restore 出错时会继续跑完剩余对象并返回非零，这里如实上报，不静默吞掉
  warn "数据库恢复返回非零（部分对象可能未恢复），请用 pg_restore 单独复核："
  warn "  docker exec -i <db容器> pg_restore -U smarthome -d smarthome --clean --if-exists --no-owner < ${SRC}/db.dump"
  RESTORE_FAILED=1
fi

# --- 5. 产物卷恢复（用一次性临时容器挂同一卷；api 容器此时是停的，不能 exec）---
if [ "$MERGE" = 1 ]; then
  note "解包产物卷（--merge，不清空）"
else
  note "清空并重建产物卷"
  docker run --rm -v "${UPLOAD_VOL}:/repo/uploads" --entrypoint sh "$API_IMAGE" \
    -c 'find /repo/uploads -mindepth 1 -maxdepth 1 -exec rm -rf {} \;' \
    || warn "清空产物卷失败，继续解包（可能残留快照之外的文件）"
fi
if gunzip -c "${SRC}/uploads.tar.gz" | docker run --rm -i -v "${UPLOAD_VOL}:/repo/uploads" --entrypoint tar "$API_IMAGE" -C /repo/uploads -xf -; then
  ok "产物卷恢复完成"
else
  warn "产物卷解包返回非零，请核对卷内容"
  RESTORE_FAILED=1
fi

# --- 6. 起 api（只恢复成它原先的状态：原先停着就别擅自拉起来）---
if [ "$API_WAS_UP" = "true" ]; then
  note "启动 api 容器"
  docker compose start api >/dev/null 2>&1 || warn "api 启动失败，请手动检查"
else
  note "api 容器恢复前就是停的，保持停机状态"
fi

echo ""
if [ "$RESTORE_FAILED" = 0 ]; then
  ok "恢复完成：数据库与产物卷已回到 ${SRC} 的快照时刻"
else
  warn "恢复过程中有告警，请按上面的提示逐项复核后再投入生产"
fi

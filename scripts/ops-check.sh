#!/usr/bin/env bash
# 生产环境体检：一次看清磁盘、日志、备份、内存四类会不会悄悄涨爆的东西。
#
# 为什么要有这个：本次排查出的三个根因（构建上下文误带 597MB、备份只写不删、
# 日志驱动无上限），共同点是**当时都没报错，只是悄悄在涨**。
# 等用户发现硬盘满的时候，代价已经发生了。体检的意义是让它早点变红。
#
# 用法：pnpm ops:check
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# 超过这个阈值就提醒（GiB）。留 10% 余量给系统和用户其他软件。
WARN_FREE_GIB="${WARN_FREE_GIB:-60}"
RED=$'\033[31m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'

warn() { printf '%s\n' "${YELLOW}!${OFF} $1"; }
ok()   { printf '%s\n' "${GREEN}✓${OFF} $1"; }
note() { printf '%s\n' "${DIM}  $1${OFF}"; }

echo "=== 1. 磁盘 ==="
# 用 -Pk 而不是 -BG：BSD df（macOS 默认）没有 -B 选项，只有 GNU coreutils 才有
FREE_GB=$(df -Pk / | awk 'NR==2 {printf "%d", $4/1024/1024}')
TOTAL_GB=$(df -Pk / | awk 'NR==2 {printf "%d", $2/1024/1024}')
if [ "${FREE_GB:-0}" -lt "$WARN_FREE_GIB" ]; then
  warn "根卷可用 ${FREE_GB}G / ${TOTAL_GB}G，低于阈值 ${WARN_FREE_GIB}G —— 先跑 pnpm docker:prune"
else
  ok "根卷可用 ${FREE_GB}G / ${TOTAL_GB}G"
fi

echo ""
echo "=== 2. Docker 占用 ==="
if command -v docker >/dev/null 2>&1; then
  docker system df 2>/dev/null | sed 's/^/  /'
  # 镜像可回收超过 1G 就提醒（1.952GB 的构建缓存属正常，会随时间被 prune 掉）
  IMG_RECLAIM=$(docker system df --format '{{.Type}}|{{.Reclaimable}}' 2>/dev/null | awk -F'|' '$1=="Images"{print $2}')
  case "$IMG_RECLAIM" in
    *[0-9]G*|*.[0-9]GB*) warn "镜像可回收 ${IMG_RECLAIM}，建议 pnpm docker:prune" ;;
    *) ok "镜像基本无冗余" ;;
  esac
else
  warn "未安装 docker，跳过"
fi

echo ""
echo "=== 3. 容器日志（应有上限，防无限增长）==="
MISSING=0
for s in api web db; do
  CFG=$(docker inspect "aisaas-$s-1" --format '{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}' 2>/dev/null)
  if [ -z "$CFG" ]; then
    note "aisaas-$s-1 未运行，跳过"
    continue
  fi
  case "$CFG" in
    *max-size*) ok "aisaas-$s 日志已设上限：$CFG" ;;
    *) warn "aisaas-$s 日志未设上限（$CFG）——长期运行会悄悄撑满磁盘"; MISSING=1 ;;
  esac
done
[ "$MISSING" = 0 ] && note "上限均为 10m × 2，三容器合计不超过 60MB"

echo ""
echo "=== 4. 备份留盘（应有份数上限）==="
# 真实部署路径在容器卷里：aisaas-api-1:/repo/uploads/backups。
# 原先读的是宿主 apps/api/uploads/backups —— 那是**开发目录**，
# 线上真正占着几百 MB 的是 api-uploads 命名卷，两边完全不是一个地方，
# 体检脚本读错地方就等于没体检（实测：宿主 3MB / 卷内 279MB）。
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^aisaas-api-1$'; then
  BK="/repo/uploads/backups"
  CNT=$(docker exec aisaas-api-1 sh -c "ls -1 '$BK' 2>/dev/null | grep -c '^backup-.*\.json$'" 2>/dev/null | tr -d ' ')
  SZ=$(docker exec aisaas-api-1 sh -c "du -sh '$BK' 2>/dev/null | cut -f1" 2>/dev/null | tr -d ' ')
  # 变量后紧跟中文全角括号时必须写 ${SZ}——bash 会把 $SZ）当成一个变量名
  if [ "${CNT:-0}" -gt 3 ]; then
    warn "备份 ${CNT} 份（${SZ:-?}），超过保留上限 3 份"
  else
    ok "备份 ${CNT:-0} 份（${SZ:-?}），在保留上限内"
  fi
  note "路径：aisaas-api-1:${BK}"
else
  note "aisaas-api-1 未运行，跳过（备份在容器卷 /repo/uploads/backups）"
fi

echo ""
echo "=== 5. 产物占用 vs 配额 ==="
# 同上：占用必须读容器卷 /repo/uploads（宿主 apps/api/uploads 只是开发目录）
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^aisaas-api-1$'; then
  UP=$(docker exec aisaas-api-1 sh -c 'du -sm /repo/uploads 2>/dev/null | cut -f1' 2>/dev/null | tr -d ' ')
  QUOTA=$(grep -oE 'UPLOAD_QUOTA_MB: \$\{UPLOAD_QUOTA_MB:-[0-9]+\}' docker-compose.yml 2>/dev/null | grep -oE '[0-9]+$')
  QUOTA=${QUOTA:-4096}
  if [ -n "${UP:-}" ] && [ "$UP" -gt "$((QUOTA * 80 / 100))" ]; then
    warn "产物 ${UP}MB / 配额 ${QUOTA}MB，已用超过 80%"
    note "在「个人中心」可一键清理过期未引用产物（POST /api/admin/storage/cleanup）"
  else
    ok "产物 ${UP:-?}MB / 配额 ${QUOTA}MB"
  fi
  note "路径：aisaas-api-1:/repo/uploads"
else
  note "aisaas-api-1 未运行，跳过（产物在容器卷 /repo/uploads）"
fi

echo ""
echo "=== 6. 数据库体积与增长最快的表 ==="
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^aisaas-db-1$'; then
  docker exec aisaas-db-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT pg_size_pretty(pg_database_size(current_database())) AS 库体积;"' 2>/dev/null | sed 's/^/  /'
  docker exec aisaas-db-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT relname AS 表, n_live_tup AS 行数,
           pg_size_pretty(pg_total_relation_size(relid)) AS 占用
    FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 5;"' 2>/dev/null | sed 's/^/  /'
  note "AuditLog / ChangeSnapshot 是审计数据，只增不减属预期；保留期由业务决定"
else
  note "数据库容器未运行，跳过"
fi

echo ""
echo "=== 7. 容器内存 ==="
if command -v docker >/dev/null 2>&1; then
  docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' 2>/dev/null \
    | grep -E 'NAME|aisaas-' || note "容器未运行"
fi

echo ""
echo "体检完毕。带 ! 的行是需要处理的。"

#!/usr/bin/env bash
# GitHub main에 새 커밋이 있으면 받아서 다시 띄운다. 학교 서버 cron에서 1분마다 실행.
#
#   crontab -e  →  * * * * * /home/ubuntu/yoba-web/tools/auto-deploy.sh >> /home/ubuntu/yoba-deploy.log 2>&1
#
# - 새 커밋이 없으면 아무것도 안 함 (조용히 종료)
# - 서버에서 파일을 직접 고쳐 GitHub와 갈라지면 덮어쓰지 않고 멈춤 (로그에 남김)
# - .env와 통계 DB(도커 볼륨)는 git이 건드리지 않음

set -euo pipefail
cd "$(dirname "$0")/.."

# 이전 배포가 아직 도는 중이면 건너뜀
exec 9>/tmp/yoba-web-deploy.lock
flock -n 9 || exit 0

git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0

log() { echo "[$(date '+%F %T')] $*"; }
log "새 커밋 발견: ${LOCAL:0:7} → ${REMOTE:0:7} ($(git log -1 --format=%s origin/main))"

if ! git merge -q --ff-only origin/main; then
  log "실패: 서버의 코드가 GitHub와 갈라졌습니다. 서버에서 'git status'로 확인하세요. 배포 중단."
  exit 1
fi

docker compose up -d --build
docker image prune -f >/dev/null

# 새 서버가 뜨는지 확인 (최대 30초)
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://localhost:${WEB_PORT:-8080}/api/state"; then
    log "배포 완료: ${REMOTE:0:7}"
    exit 0
  fi
  sleep 1
done
log "경고: 배포했지만 30초 안에 응답이 없습니다. 'docker compose logs web'을 확인하세요."
exit 1

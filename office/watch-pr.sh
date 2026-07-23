#!/bin/sh
# PR 자동 점검 감시 등록기
# 사용법: ./watch-pr.sh <계정/저장소> [세션 제목]
# 세션 제목 생략 시 저장소 이름을 세션 이름으로 쓴다.

REPO="$1"
TITLE="${2:-${REPO##*/}}"
DIR=$(dirname "$0")

if [ -z "$REPO" ]; then
  echo "사용법: ./watch-pr.sh <계정/저장소> [세션 제목]" >&2
  exit 1
fi

node -e "
const fs = require('fs');
const file = '$DIR/pr-watch.json';
let list = [];
try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (list.some(w => w.repo === '$REPO')) {
  console.log('이미 감시 중: $REPO');
} else {
  list.push({ repo: '$REPO', session: '$TITLE' });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  console.log('감시 등록: $REPO → 개발실 \"$TITLE\" 세션');
  console.log('서버가 3분마다 새 PR·새 커밋을 확인합니다. (서버 재시작 불필요)');
}
"

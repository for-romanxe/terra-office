#!/bin/sh
# 사무실 자동 점검 훅 설치기
# 사용법: ./install-hook.sh <저장소 경로> [세션 제목]
# 세션 제목 생략 시 저장소 폴더명을 세션 이름으로 쓴다.

REPO="$1"
TITLE="${2:-$(basename "$REPO")}"

if [ -z "$REPO" ] || [ ! -d "$REPO/.git" ]; then
  echo "사용법: ./install-hook.sh <저장소 경로> [세션 제목]" >&2
  echo "(.git이 있는 저장소여야 합니다)" >&2
  exit 1
fi

HOOK="$REPO/.git/hooks/post-commit"
cat > "$HOOK" <<EOF
#!/bin/sh
# 연성 사무실 자동 점검 (install-hook.sh가 생성)
REPO_DIR=\$(git rev-parse --show-toplevel)
COMMIT=\$(git log -1 --oneline)
BODY=\$(printf '{"dept":"개발실","session":"%s","create":true,"name":"자동","text":"[자동 알림] 방금 커밋됨 — 저장소 %s, 커밋: %s. 코드 점검관에게 이 커밋의 변경사항(git_diff)을 점검시켜줘. 치명 항목이 있으면 반려 사유를 보고하고, 없으면 통과라고만 짧게 보고해줘."}' "$TITLE" "\$REPO_DIR" "\$COMMIT")
RES=\$(curl -s --max-time 3 -X POST http://localhost:3010/say \\
  -H 'Content-Type: application/json' -d "\$BODY" 2>/dev/null)
case "\$RES" in
  *ok*)   echo "[사무실] 개발실에 점검 접수됨 (세션: $TITLE)" ;;
  *busy*) echo "[사무실] 개발실이 바빠서 이번 커밋은 점검 생략" ;;
  *)      echo "[사무실] 서버 꺼져 있음 — 점검 생략" ;;
esac
exit 0
EOF
chmod +x "$HOOK"
echo "설치 완료: $HOOK"
echo "이제 이 저장소에서 커밋하면 개발실 '$TITLE' 세션으로 자동 점검이 접수됩니다."

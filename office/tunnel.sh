#!/bin/sh
# 사무실 임시 외부 공개: cloudflared 터널을 열어 공유용 주소를 만든다
# 사용법: ./tunnel.sh   (끝낼 때 Ctrl+C — 주소도 함께 사라진다)

if ! curl -s --max-time 2 http://localhost:3010/ > /dev/null; then
  echo "사무실 서버가 꺼져 있습니다. 먼저 실행하세요: node office/server.mjs" >&2
  exit 1
fi

echo "터널 여는 중... 아래에 뜨는 https://….trycloudflare.com 주소를 친구에게 보내세요."
echo "· 주소는 열 때마다 새로 바뀝니다 — 매번 이 창의 최신 주소를 보내세요"
echo "· 원격 접속자에게는 개발실·물커톤실만 보입니다 (비서실은 사장 전용)"
echo "· 결재 승인은 사장만 가능합니다 (직급으로 막힘)"
echo "· 끝낼 때 Ctrl+C — 터널이 닫히면 주소도 무효가 됩니다"
echo
exec cloudflared tunnel --url http://localhost:3010

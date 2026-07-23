# AI 사무실 프로젝트 — 점검용 핸드오프 (2026-07-20)

다른 세션에서 이 프로젝트를 점검할 때 먼저 읽는 문서. 상세 이력은 `PROJECT.md`, 프로젝트 규칙은 `CLAUDE.md` 참고.

## 프로젝트 한 줄 요약

AI 직원들이 픽셀 사무실에서 일하는 모습을 보여주는 로컬 웹앱. Node.js 서버(`office/server.mjs`, 포트 3010)가 Claude Agent SDK(헤드리스 클로드 코드, Max 구독 과금)로 실장→직원 위임 구조를 돌리고, 프론트(`office/public/`)가 캔버스에 사무실을 그린다.

## 파일 지도

| 경로 | 내용 |
|---|---|
| `office/server.mjs` | 서버 전체 (단일 파일): 도구 명부, 결재 게이트, 부서 로딩, 세션, SSE, PR/브랜치 감시 |
| `office/public/app.js` | 프론트 전체: 캔버스 사무실, 테마 프리셋, 메신저 UI |
| `office/departments/<부서명>/실장.md` + `employees/*.md` | 부서 정의 — 프런트매터(order, id, name, color, tools, duty, model, wall, theme, private) + 본문 = 시스템 프롬프트. 폴더 스캔으로 자동 로드 |
| `office/pr-watch.json` | PR·브랜치 감시 등록 (재시작 불필요, 폴링마다 다시 읽음) |
| `office/pr-seen.json` | 이미 본 PR/브랜치 커밋 기록 |
| `office/pin.txt` | 결재 PIN |
| `office/sessions/<부서>/*.json` | 세션(대화방) 기록 |
| `../notes/` (= `~/ai-agent-lab/notes/`) | 직원 공용 노트 (save_note/read_note) |

## 핵심 구조

- **부서 3개**: 비서실(나만 보임, private), 개발실, 물커톤실(대회 전용, `theme: lab` 연구실 테마)
- **busy 잠금은 부서 단위** → 부서끼리는 병렬, 같은 부서 세션들은 한 줄로 대기
- **위임 구조**: 실장이 `ask_<직원id>` 도구로 직원에게 통째로 위임. 실장은 직원의 `duty` 한 줄만 보고 판단하므로, 직원에게 도구를 주면 duty에도 능력을 명시해야 함 (이걸 빼먹어서 실장이 "PR 기능 없다"고 답한 사고가 있었음 — 수정 완료)
- **결재 게이트** `GATED_TOOLS`: `archive_delete_scrap`, `git_merge`, `git_push` — 실행 전 멈추고 메신저에 결재 카드(PIN), 5분 무응답 자동 반려. 부서 무관 공통 적용
- **도구 명부** `TOOL_REGISTRY`: 웹검색, 노트, 파일 열람(홈 안만), git(status/diff/fetch/log/commit/branch/merge/push), gh PR 읽기 3종, 아카이버 DB 등. 코드 작성 도구와 저장소 생성 도구는 없음(의도적)
- **경로 안전장치**: `resolveInHome` — 홈 밖 차단 + `SENSITIVE_PATHS` 목록(.ssh·.gnupg·.aws·.netrc·.npmrc·.config/anthropic·.config/gh·.claude·쉘 히스토리·.env·office/pin.txt) 차단 — 2026-07-20 점검 반영으로 확대

## 오늘(2026-07-20) 만든 것 — 점검 우선 대상

### 1. 물커톤실 신설
- MOVE-AI 물류 해커톤(본선 8/13) 전용 부서. 실장 + 전략담당·코드점검관·제출점검관·통합담당
- 기준 문서: `notes/물커톤-대회정보.md` (미정 항목은 "미정" 유지, 지어내지 않기 원칙)
- 연구실 테마: 실장.md `theme: lab` → `app.js`의 `THEMES`/`THEME_WALLS` 프리셋 (푸른 벽·타일·스틸 책상·주기율표 포스터·시약장 위 플라스크)

### 2. 사무실 PR (브랜치 감시) — 팀 해커톤 협업용
- 취지: 친구들은 GitHub에 **push만** 하면 되고, PR 버튼 없이 물커톤실이 자동 점검
- `pr-watch.json` 항목에 `"watch": "branches"` + `"dept": "물커톤실"` + `"path": "<로컬 클론 절대경로>"` 등록
- 서버가 3분마다 `gh api repos/<repo>/branches` 폴링 → main/master 제외 브랜치의 새 커밋 감지 → 해당 부서에 자동 접수 → 코드점검관이 `git_fetch` 후 `git_diff`(main과 비교) 점검 → "머지해도 됨"/"반려+사유" 보고. 병합은 별도 지시 시에만 (통합담당, 결재 경유)
- 신설 도구: `git_fetch` (fetch origin --prune). 확장: `git_diff`에 `target`/`base` 인자 추가 (`base...target` 비교, base 기본 main)
- PR 감시도 `"dept"` 필드로 부서 지정 가능해짐 (기존엔 개발실 하드코딩)
- **e2e 검증 완료**: 테스트 저장소(for-romanxe/claude-review-test)에서 push 시뮬레이션 → 감지 → fetch → diff → SQL 인젝션·미정의 변수·비밀번호 하드코딩 발견 → "반려, 치명 3건" 보고까지 확인. 결과는 물커톤실 "브랜치 테스트" 세션에 남아 있음

### 3. 비교 문서 아티팩트
- 깃허브 PR ↔ 사무실 PR 8단계 대조표 웹페이지 게시 (연구실 테마): https://claude.ai/code/artifact/ec1d7787-1aef-49f6-ab4f-72057fe8f8d7

## 실행 · 검증 방법

```bash
# 상태 확인 (유휴 여부 확인 후 재시작할 것)
tail /tmp/office.log
# 재시작
kill $(lsof -i :3010 -sTCP:LISTEN -t)
cd ~/ai-agent-lab && nohup node office/server.mjs >> /tmp/office.log 2>&1 &
# 접속: http://localhost:3010 (같은 와이파이: http://<맥IP>:3010)
```

- 직원에게 실제 지시를 내리면 Max 구독 사용량이 나감 — 점검은 가급적 코드 읽기·`node --check`·서버 기동 확인까지만
- 브랜치 감시 수동 테스트법: pr-watch.json에 branches 항목 추가 → 재시작(기준선) → `pr-seen.json`의 해당 브랜치 sha를 임의 값으로 바꾸고 재시작 → 감지·접수됨

## 점검 반영 (2026-07-20, 점검보고-2026-07-20.md 후속)

- 로그 타임스탬프 UTC → 로컬 시각(KST)으로 수정
- `resolveInHome` 민감 경로 차단 목록 확대 (gh 토큰·쉘 히스토리·.claude·.env·결재 PIN 등) — 차단/허용 케이스 테스트 완료
- 세션 삭제 owner 잠금 적용 — 원격(친구) 요청은 403, 로컬만 가능. curl로 검증 완료

## 미결 사항 (알고 있는 것)

- 물커톤 팀 저장소 생성은 **대회 시작 시** 진행하기로 함 (gh repo create → README → 브랜치 감시 등록 → 대회정보 노트 갱신)
- 웹 알림(beep + Notification API) 동작이 사용자 환경에서 불안정 — 미해결
- `git_diff`의 base 기본값이 `main` 고정 — master 기본 저장소면 base를 명시해야 함

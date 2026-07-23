# TERRA 연구실

부서별 AI 직원에게 일을 시키고, 그들이 일하는 모습을 사무실 전경으로 보는 웹앱.

실장에게 한 마디 지시하면 → 실장이 팀원에게 위임하고 → 팀원이 도구(메모·git·웹검색)를 써서 일하고 → 실장이 보고한다. 그 과정이 아이소메트릭 사무실 안에서 사람이 걸어가고 타자 치는 애니메이션으로 재생된다.

에이전트 실행은 **Claude Agent SDK(헤드리스 Claude Code)** — API 크레딧이 아니라 Claude 구독으로 돌아간다.

```
┌ 부서 탭 ┐  ┌──────── 사무실 전경 (SVG) ────────┐ ┌ 사내 메신저 ┐
│ 비서실  │  │   실장 ──지시──▶ 팀원 ──도구──▶  │ │ 나> ...     │
│ 개발실  │  │        ◀─보고──                  │ │ 실장> ...   │
│ 물커톤실│  └──────────────────────────────────┘ │ [결재 카드] │
│ 메모함  │  ┌ PM 봇 (깃허브 push/PR 알림) ─────┐ └─────────────┘
└─────────┘  └ 부서 게시판 (사람끼리 쓰는 메모) ┘
```

## 실행

필요한 것: **Node 22 이상** (`node:sqlite` 사용), 그리고 Claude Code 로그인(`claude` CLI로 한 번 로그인해 두면 됨).

```bash
npm install
node office/server.mjs      # → http://localhost:3010
```

로그는 `/tmp/office.log`가 아니라 터미널에 그대로 나온다. 백그라운드로 돌릴 때:

```bash
nohup node office/server.mjs >> /tmp/office.log 2>&1 &
```

## 사원 등록

처음 켜면 사장 한 명짜리 명부(`office/members.json`)가 자동 생성되고, **접속 코드가 터미널에 한 번 찍힌다.** 그 줄을 놓치지 말 것.

```bash
node office/members.mjs                 # 명부 + 접속 코드 보기
node office/members.mjs add 민수 이사    # 사원 등록 (코드 자동 발급)
node office/members.mjs code 민수        # 코드 재발급 (기존 로그인 전부 해제)
node office/members.mjs rank 민수 본부장  # 직급 변경
node office/members.mjs remove 민수       # 내보내기
```

명부는 요청마다 다시 읽으므로 **서버 재시작이 필요 없다.**

로그인은 이름 선택 + 접속 코드. localhost 접속은 코드 없이 사장으로 통과한다.

## 직급

사장 > 이사 > 본부장 > AI 직원.

| | 사장 | 이사 | 본부장 |
|---|:---:|:---:|:---:|
| 지시 · 게시판 · 세션 생성 | ○ | ○ | ○ |
| 결재 승인 | ○ | ✕ | ✕ |
| 비서실 (개인 메모리) | ○ | ✕ | ✕ |
| 메모함 (보기 · 편집) | ○ | ✕ | ✕ |
| 세션 삭제 | ○ | ○ | ✕ |
| 남의 게시판 메모 떼기 | ○ | ○ | 자기 것만 |

직급은 AI에게도 전달된다 — 실장이 받는 지시문이 `[이사 민수] …` 형태가 되고, 서열과 "결재는 사장 결재만 유효하다"는 문장이 함께 붙는다.

## 직원 채용

직원 하나 = md 파일 하나. **md 추가 + 서버 재시작 = 채용.**

```
office/departments/<부서>/
├── 실장.md              # 부서장 — 팀원별 ask_* 위임 도구가 자동 생성됨
└── employees/*.md       # 팀원
```

```md
---
order: 1                    # 연차 — 책상 배정 순서
id: clerk
name: 기록 담당
model: claude-haiku-4-5     # 생략 시 claude-opus-4-8
color: "#33406e"
tools: save_note, list_notes, read_note
duty: 명패에 뜨는 한 줄 소개
---
여기부터 본문이 시스템 프롬프트.
```

실장.md만 쓰는 키: `theme`(방 팔레트), `private: true`(사장 전용 부서), `prboard: true`(PR 집계판 + PM 봇 패널).

**도구를 좁게 주는 것이 곧 안전장치다.** 점검관들에게 읽기 도구만 준 이유 — 프롬프트로 "고치지 마라"라고 부탁하는 대신, 고칠 수단 자체를 안 준다.

## 결재 게이트

`delete_note` · `archive_delete_scrap` · `git_merge` · `git_push`는 실행 직전에 멈추고 메신저에 결재 카드를 띄운다. **승인할 수 있는 사람은 사장뿐이고**, 5분간 응답이 없으면 자동 반려된다.

에이전트가 "승인받았다"고 믿어도 시스템이 막는다는 게 요점이다.

## 안전장치

- 파일 접근은 홈 디렉터리 안으로 한정, `.ssh` · `.config/anthropic` · `members.json` · `tokens.json` 등은 차단
- git 명령은 `execFileSync` + 20초 타임아웃, `.git`이 있는 경로만
- 에이전트 루프 상한 20회
- 업로드한 파일은 종류와 무관하게 다운로드로만 내려보낸다 (XSS 차단)

## 팀원 초대

같은 와이파이면 `http://<맥IP>:3010`. 밖에서 접속하려면:

```bash
./office/tunnel.sh          # trycloudflare 임시 주소 발급, Ctrl+C로 종료
```

주소는 열 때마다 바뀐다. 고정 주소가 필요하면 Cloudflare named tunnel로 바꿔야 한다 (미착수).

## 저장소에 없는 것

`.gitignore`로 빠져 있고, 대부분 서버가 알아서 다시 만든다.

| 경로 | 왜 |
|---|---|
| `office/members.json` · `tokens.json` | 접속 코드와 로그인 토큰 |
| `notes/` | 메모함 — 개인 메모 |
| `office/sessions/` · `uploads/` · `boards/` | 대화 · 첨부 · 게시판 기록 |
| `office/pr-seen.json` · `pr-stats.json` | PR 감시 상태 |

비서실의 **아카이버 담당**은 `~/activity-archiver/data/archive.db`를 직접 읽는다. 그 프로젝트가 없으면 그 직원의 도구만 실패하고 나머지는 정상 동작한다.

## 프로젝트 기록

만들면서 무엇을 왜 그렇게 정했는지, 어디서 막혔는지는 [PROJECT.md](PROJECT.md)에 단계별로 적어 두었다.

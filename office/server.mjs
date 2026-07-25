// 연성 사무실 서버 (부서제): departments/<부서>/실장.md + employees/*.md 를 읽어
// 부서별 에이전트 팀을 구성하고, 진행 상황을 SSE로 브라우저에 중계한다.
// 에이전트 실행은 Claude Agent SDK(헤드리스 Claude Code) — API 크레딧이 아니라 Max 구독으로 돌아간다.
// 실행: node office/server.mjs → http://localhost:3010
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { query, tool as sdkTool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const NOTES_DIR = path.join(__dirname, "..", "notes");
const HOME = process.env.HOME;
fs.mkdirSync(NOTES_DIR, { recursive: true });

const PORT = 3010;
const MODEL = "claude-opus-5"; // 기본 모델 (기록·아카이버·물커톤 통합 담당만 md에서 haiku로 별도 지정)
// "claude-opus-4-8" → "Opus 4.8" 처럼 범례에 짧게 보여주기 위한 변환
function modelLabel(id) {
  const m = String(id || "").match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
  if (!m) return String(id || "");
  const [, family, major, minor] = m;
  const name = family[0].toUpperCase() + family.slice(1);
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`;
}

// 헤드리스 Claude Code가 구독 인증을 쓰도록 API 키는 넘기지 않는다.
// 결재 대기(최대 5분)·직원 위임(수 분) 동안 MCP 도구 호출이 끊기지 않게 타임아웃을 늘린다.
const AGENT_ENV = { ...process.env, MCP_TOOL_TIMEOUT: "1800000" };
delete AGENT_ENV.ANTHROPIC_API_KEY;

// 직원에게 내주지 않은 Claude Code 내장 도구는 전부 막는다 (우리 도구만 쓰게)
const BLOCKED_BUILTINS = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep",
  "WebSearch", "WebFetch", "Task", "TodoWrite", "KillShell", "BashOutput", "Skill", "SlashCommand",
  "PushNotification", // 헤드리스라 받아줄 앱이 없어 항상 발송 실패 — 알림은 사무실 웹이 담당
];

const clip = (s, n = 4000) => (String(s).length > n ? String(s).slice(0, n) + "\n…(이하 생략)" : String(s));

// ── 경로 안전장치 ─────────────────────────────────────────────
// 자격증명·토큰·이력이 든 경로 — 원격(친구) 지시로도 직원이 읽어오면 안 된다
const SENSITIVE_PATHS = [
  "/.ssh", "/.gnupg", "/.aws", "/.netrc", "/.npmrc",
  "/.config/anthropic", "/.config/gh", "/.claude",
  "/.zsh_history", "/.bash_history", "/.env",
  "/office/members.json", "/office/tokens.json", // 접속 코드·로그인 토큰
];
function resolveInHome(p) {
  const r = path.resolve(String(p).replace(/^~(?=\/|$)/, HOME));
  if (!r.startsWith(HOME + "/") && r !== HOME) throw new Error(`홈 폴더 밖은 접근할 수 없습니다: ${r}`);
  if (SENSITIVE_PATHS.some((s) => r.includes(s))) throw new Error("민감한 경로는 접근할 수 없습니다");
  return r;
}
function resolveRepo(p) {
  const r = resolveInHome(p);
  if (!fs.existsSync(path.join(r, ".git"))) throw new Error(`git 저장소가 아닙니다: ${r}`);
  return r;
}
function git(repo, args) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    throw new Error(clip((err.stdout || "") + (err.stderr || err.message), 1500));
  }
}
function gh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    throw new Error(clip((err.stdout || "") + (err.stderr || err.message), 1500));
  }
}

// ── 도구 명부: md의 tools: 항목이 여기 이름을 참조한다 ─────────────
const TOOL_REGISTRY = {
  // 웹 도구: Claude Code 내장 도구로 매핑된다
  web_search: { builtin: "WebSearch" },
  web_fetch: { builtin: "WebFetch" },

  // 비서실: 메모
  save_note: {
    name: "save_note",
    description: "메모를 markdown 파일로 저장한다.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "파일명이 될 짧은 제목 (확장자 제외)" },
        content: { type: "string", description: "저장할 내용 (markdown)" },
      },
      required: ["title", "content"],
    },
  },
  list_notes: {
    name: "list_notes",
    description: "저장된 메모 파일 목록을 반환한다.",
    input_schema: { type: "object", properties: {} },
  },
  read_note: {
    name: "read_note",
    description: "저장된 메모 하나의 내용을 읽는다.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string", description: "메모 제목 (확장자 제외)" } },
      required: ["title"],
    },
  },
  delete_note: {
    name: "delete_note",
    description:
      "저장된 메모 하나를 삭제한다. 호출하면 시스템이 사장님에게 결재 카드를 띄우고, 승인될 때만 실제로 삭제된다.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string", description: "삭제할 메모 제목 (확장자 제외)" } },
      required: ["title"],
    },
  },
  read_user_context: {
    name: "read_user_context",
    description:
      "사장님(사용자)에 대한 배경 기록을 읽는다(읽기 전용). 인자 없이 호출하면 기록 목차를, name에 파일명을 주면 그 기록의 전문을 반환한다.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "목차에 나온 파일명 (예: some-project.md). 생략하면 목차 반환" },
      },
    },
  },

  // 비서실: 대외활동 아카이버
  archive_list_scraps: {
    name: "archive_list_scraps",
    description: "대외활동 아카이버 앱의 공고 스크랩 목록을 조회한다 (id, 제목, 마감일, 상태, 메모).",
    input_schema: { type: "object", properties: {} },
  },
  archive_list_activities: {
    name: "archive_list_activities",
    description: "대외활동 아카이버 앱의 활동 기록 목록을 조회한다 (id, 제목, 주최, 분류, 기간, 결과).",
    input_schema: { type: "object", properties: {} },
  },
  archive_add_scrap: {
    name: "archive_add_scrap",
    description: "대외활동 아카이버 앱에 새 공고 스크랩을 등록한다.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "공고 제목" },
        url: { type: "string", description: "공고 URL (모르면 생략)" },
        deadline: { type: "string", description: "마감일 YYYY-MM-DD (모르면 생략)" },
        memo: { type: "string", description: "핵심 정보 메모 (일정, 상금, 조건 등)" },
        status: { type: "string", description: "상태. 기본값: 지원예정" },
      },
      required: ["title"],
    },
  },
  archive_add_activity: {
    name: "archive_add_activity",
    description:
      "대외활동 아카이버 앱에 새 활동 기록을 등록한다. 분류(category)는 반드시 다음 중 하나: 공모전, 해커톤, 동아리, 봉사, 인턴, 서포터즈, 교육/부트캠프, 개인 프로젝트, 기타.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "활동명" },
        category: { type: "string", description: "분류 (목록의 값 그대로)" },
        startDate: { type: "string", description: "시작일 YYYY-MM-DD" },
        endDate: { type: "string", description: "종료일 YYYY-MM-DD (진행 중이면 생략)" },
        org: { type: "string", description: "주최 기관 (생략 가능)" },
        role: { type: "string", description: "맡은 역할 (생략 가능)" },
        description: { type: "string", description: "한 일·배운 점 (생략 가능)" },
        result: { type: "string", description: "결과 (예: 대상, 수료 — 생략 가능)" },
      },
      required: ["title", "category", "startDate"],
    },
  },
  archive_set_scrap_status: {
    name: "archive_set_scrap_status",
    description: "공고 스크랩의 상태(status)를 변경한다. 예: 지원완료, 탈락, 합격 등.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "스크랩 id (archive_list_scraps로 확인)" },
        status: { type: "string", description: "새 상태 문자열" },
      },
      required: ["id", "status"],
    },
  },
  archive_update_scrap: {
    name: "archive_update_scrap",
    description: "공고 스크랩의 마감일(디데이)·제목·URL·메모를 수정한다. 바꿀 항목만 넣으면 된다.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "스크랩 id (archive_list_scraps로 확인)" },
        deadline: { type: "string", description: "새 마감일 YYYY-MM-DD" },
        title: { type: "string", description: "새 제목" },
        url: { type: "string", description: "새 URL" },
        memo: { type: "string", description: "새 메모" },
      },
      required: ["id"],
    },
  },
  archive_delete_scrap: {
    name: "archive_delete_scrap",
    description:
      "공고 스크랩 하나를 삭제한다. 호출하면 서버가 사장님에게 결재 카드를 띄우고, 승인된 경우에만 실제로 실행된다. 승인 확인은 시스템 몫이니 사전에 승인 여부를 판단하지 말고 삭제 지시를 받았으면 바로 호출하라.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "삭제할 스크랩 id (archive_list_scraps로 확인)" } },
      required: ["id"],
    },
  },

  // 개발실: 파일 열람 (읽기 전용)
  list_files: {
    name: "list_files",
    description: "디렉토리의 파일/폴더 목록을 반환한다 (읽기 전용, 홈 폴더 안만).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "절대 경로 또는 ~/경로" } },
      required: ["path"],
    },
  },
  read_file: {
    name: "read_file",
    description:
      "텍스트 파일 하나의 내용을 읽는다 (읽기 전용, 홈 폴더 안만). 한 번에 약 8천 자까지 반환하고, " +
      "더 있으면 끝에 '이어읽기 offset=N'을 알려준다. 그 값을 offset으로 넘겨 다음 부분을 계속 읽을 수 있다.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "절대 경로 또는 ~/경로" },
        offset: { type: "number", description: "이어읽기 시작 글자 위치 (기본 0). 앞서 받은 'offset=N' 값을 넣는다" },
      },
      required: ["path"],
    },
  },

  // 개발실: git
  git_status: {
    name: "git_status",
    description: "저장소의 현재 브랜치와 변경 파일 목록을 확인한다.",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string", description: "저장소 절대 경로" } },
      required: ["repo"],
    },
  },
  git_diff: {
    name: "git_diff",
    description: "저장소의 변경 내용을 확인한다. 기본은 아직 커밋 안 된 변경(HEAD 대비), target을 주면 브랜치·커밋 비교(base...target). file을 주면 그 파일의 전체 diff, 없으면 파일별 통계.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "저장소 절대 경로" },
        file: { type: "string", description: "특정 파일 경로 (저장소 기준 상대 경로, 생략 가능)" },
        target: { type: "string", description: "비교할 브랜치·커밋 (예: origin/feature-x). 생략하면 커밋 안 된 변경을 본다" },
        base: { type: "string", description: "비교 기준 브랜치 (생략 시 main). target이 있을 때만 쓰인다" },
      },
      required: ["repo"],
    },
  },
  git_fetch: {
    name: "git_fetch",
    description: "원격 저장소의 최신 브랜치·커밋 정보를 받아온다. 팀원이 push한 브랜치를 점검·병합하기 전에 먼저 호출한다. 로컬 파일은 바꾸지 않는다.",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string", description: "저장소 절대 경로" } },
      required: ["repo"],
    },
  },
  git_log: {
    name: "git_log",
    description: "최근 커밋 이력을 확인한다.",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string", description: "저장소 절대 경로" } },
      required: ["repo"],
    },
  },
  git_commit: {
    name: "git_commit",
    description: "모든 변경사항을 스테이징하고 커밋한다.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "저장소 절대 경로" },
        message: { type: "string", description: "커밋 메시지 (변경 내용이 드러나게)" },
      },
      required: ["repo", "message"],
    },
  },
  git_branch: {
    name: "git_branch",
    description: "브랜치를 조회/생성/이동한다. 인자 없이 호출하면 브랜치 목록, name을 주면 이동, create까지 주면 생성 후 이동.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "저장소 절대 경로" },
        name: { type: "string", description: "이동/생성할 브랜치 이름 (생략하면 목록 조회)" },
        create: { type: "boolean", description: "true면 새 브랜치를 만들어 이동" },
      },
      required: ["repo"],
    },
  },
  gh_pr_list: {
    name: "gh_pr_list",
    description: "깃허브 저장소의 열린 PR 목록을 확인한다. (읽기 전용)",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string", description: "깃허브 저장소 (계정/이름 형식, 예: for-romanxe/my-repo)" } },
      required: ["repo"],
    },
  },
  gh_pr_view: {
    name: "gh_pr_view",
    description: "PR의 제목·작성자·설명·브랜치와 충돌 여부(mergeable)를 확인한다. (읽기 전용)",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "깃허브 저장소 (계정/이름 형식)" },
        number: { type: "number", description: "PR 번호" },
      },
      required: ["repo", "number"],
    },
  },
  gh_pr_diff: {
    name: "gh_pr_diff",
    description: "PR의 변경 내용 전체 diff를 확인한다. (읽기 전용)",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "깃허브 저장소 (계정/이름 형식)" },
        number: { type: "number", description: "PR 번호" },
      },
      required: ["repo", "number"],
    },
  },
  git_merge: {
    name: "git_merge",
    description:
      "지정한 브랜치를 현재 브랜치로 병합한다. 호출하면 서버가 사장님에게 결재 카드를 띄우고, 승인된 경우에만 실제로 실행된다. 승인 확인은 시스템 몫이니 병합 지시를 받았으면 바로 호출하라.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "저장소 절대 경로" },
        branch: { type: "string", description: "병합해올 브랜치 이름" },
      },
      required: ["repo", "branch"],
    },
  },
  git_push: {
    name: "git_push",
    description:
      "현재 브랜치를 원격 저장소로 push한다. 호출하면 서버가 사장님에게 결재 카드를 띄우고, 승인된 경우에만 실제로 실행된다. 승인 확인은 시스템 몫이니 push 지시를 받았으면 바로 호출하라.",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string", description: "저장소 절대 경로" } },
      required: ["repo"],
    },
  },
};

// JSON 스키마(도구 명부 형식) → zod shape (Agent SDK의 tool()이 요구하는 형식)
function zodShapeFrom(schema) {
  const shape = {};
  const required = schema.required || [];
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    let t = prop.type === "number" ? z.number() : prop.type === "boolean" ? z.boolean() : z.string();
    if (prop.description) t = t.describe(prop.description);
    if (!required.includes(key)) t = t.optional();
    shape[key] = t;
  }
  return shape;
}

// 결재가 필요한 도구: 실행 전에 사장님 승인을 받는다
// 지금 그 저장소가 어느 브랜치에 서 있는지. 병합은 "현재 브랜치"로 들어가므로 결재 전에 반드시 보여준다.
function currentBranch(repo) {
  try {
    return execFileSync("git", ["-C", String(repo), "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

const GATED_TOOLS = {
  delete_note: (input) => `보관 메모 삭제 (${input?.title})`,
  archive_delete_scrap: (input) => `공고 스크랩 삭제 (id: ${input?.id})`,
  // 어디"로" 들어가는지가 빠지면 엉뚱한 브랜치에 병합돼도 승인자가 알아챌 수 없다
  git_merge: (input) => {
    const into = currentBranch(input?.repo);
    const warn = into && !/^(main|master)$/.test(into) ? "  ⚠ main이 아닙니다" : "";
    return `브랜치 병합: ${input?.branch} → ${into || "현재 브랜치"}${warn}\n(repo: ${input?.repo})`;
  },
  git_push: (input) => {
    const from = currentBranch(input?.repo);
    return `원격 저장소로 push: ${from || "현재 브랜치"}\n(repo: ${input?.repo})`;
  },
};

const USER_MEMORY_DIR = path.join(HOME, ".claude", "projects", "-Users-for-romanxe", "memory");
const ARCHIVE_DB = path.join(HOME, "activity-archiver", "data", "archive.db");
// 아카이버 앱 src/db/schema.ts의 CATEGORIES와 같은 목록 — 앱에서 바뀌면 여기도 바꿔야 한다
const ARCHIVE_CATEGORIES = ["공모전", "해커톤", "동아리", "봉사", "인턴", "서포터즈", "교육/부트캠프", "개인 프로젝트", "기타"];

function noteCount() {
  return fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith(".md")).length;
}

// ── 메모함 ────────────────────────────────────────────────────
// 직원 도구(save_note/read_note/delete_note)와 **같은 폴더·같은 파일**을 쓴다.
// 도구가 호출될 때마다 디스크를 읽으므로, 여기서 고치면 다음 지시부터 바로 반영된다.
const noteFile = (title) => path.join(NOTES_DIR, path.basename(String(title)).replace(/\.md$/, "") + ".md");
function listNotes() {
  return fs
    .readdirSync(NOTES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const full = path.join(NOTES_DIR, f);
      const text = fs.readFileSync(full, "utf8");
      return {
        title: f.replace(/\.md$/, ""),
        preview: (text.trim().split("\n").find((l) => l.trim()) || "").slice(0, 80),
        at: fs.statSync(full).mtime.toISOString(),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at)); // 최근에 고친 것부터
}
// 메모가 바뀌었음을 알린다. 내용은 싣지 않는다 — 사장만 볼 수 있어서 각자 다시 받아간다.
function notesChanged() {
  broadcast({ type: "notes", count: noteCount() });
}
function withArchiveDb(fn) {
  const db = new DatabaseSync(ARCHIVE_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function runLocalTool(name, input) {
  const safeName = (t) => path.basename(String(t)).replace(/\.md$/, "");

  // 비서실
  if (name === "save_note") {
    const file = path.join(NOTES_DIR, safeName(input.title) + ".md");
    fs.writeFileSync(file, input.content);
    return `저장 완료: ${path.basename(file)}`;
  }
  if (name === "list_notes") {
    const files = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith(".md"));
    return files.length ? files.join("\n") : "저장된 메모가 없습니다.";
  }
  if (name === "read_note") {
    return fs.readFileSync(path.join(NOTES_DIR, safeName(input.title) + ".md"), "utf8");
  }
  if (name === "delete_note") {
    const file = path.join(NOTES_DIR, safeName(input.title) + ".md");
    if (!fs.existsSync(file)) throw new Error(`그 제목의 메모가 없습니다: ${safeName(input.title)} (list_notes로 확인)`);
    fs.unlinkSync(file);
    return `삭제 완료: ${path.basename(file)}`;
  }
  if (name === "read_user_context") {
    const f = input?.name ? path.basename(String(input.name)) : "MEMORY.md";
    if (!f.endsWith(".md")) throw new Error("md 파일만 읽을 수 있습니다");
    return fs.readFileSync(path.join(USER_MEMORY_DIR, f), "utf8");
  }
  if (name === "archive_list_scraps") {
    return withArchiveDb((db) => {
      const rows = db.prepare("SELECT id, title, deadline, status, memo FROM scraps ORDER BY deadline").all();
      if (!rows.length) return "스크랩이 없습니다.";
      return rows
        .map((r) => `[${r.id}] ${r.title} | 마감: ${r.deadline} | 상태: ${r.status}\n  메모: ${r.memo || "-"}`)
        .join("\n");
    });
  }
  if (name === "archive_list_activities") {
    return withArchiveDb((db) => {
      const rows = db
        .prepare("SELECT id, title, org, category, start_date, end_date, result FROM activities ORDER BY start_date")
        .all();
      if (!rows.length) return "활동 기록이 없습니다.";
      return rows
        .map(
          (r) =>
            `[${r.id}] ${r.title} | ${r.org} | ${r.category} | ${r.start_date}~${r.end_date} | 결과: ${r.result || "-"}`
        )
        .join("\n");
    });
  }
  if (name === "archive_add_scrap") {
    return withArchiveDb((db) => {
      const userId = db.prepare("SELECT id FROM users LIMIT 1").get()?.id;
      if (!userId) throw new Error("아카이버에 사용자가 없습니다");
      const id = crypto.randomBytes(9).toString("base64url");
      db.prepare(
        "INSERT INTO scraps (id, user_id, title, url, deadline, memo, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        userId,
        String(input.title),
        String(input.url || ""),
        String(input.deadline || ""),
        String(input.memo || ""),
        String(input.status || "지원예정"),
        new Date().toISOString()
      );
      return `등록 완료: [${id}] ${input.title}`;
    });
  }
  if (name === "archive_add_activity") {
    if (!ARCHIVE_CATEGORIES.includes(input.category)) {
      throw new Error(`분류는 다음 중 하나여야 합니다: ${ARCHIVE_CATEGORIES.join(", ")}`);
    }
    return withArchiveDb((db) => {
      const userId = db.prepare("SELECT id FROM users LIMIT 1").get()?.id;
      if (!userId) throw new Error("아카이버에 사용자가 없습니다");
      const id = crypto.randomBytes(9).toString("base64url");
      db.prepare(
        "INSERT INTO activities (id, owner_id, title, org, category, role, start_date, end_date, description, result, invite_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        userId,
        String(input.title),
        String(input.org || ""),
        String(input.category),
        String(input.role || ""),
        String(input.startDate),
        String(input.endDate || ""),
        String(input.description || ""),
        String(input.result || ""),
        crypto.randomBytes(15).toString("base64url"),
        new Date().toISOString()
      );
      return `등록 완료: [${id}] ${input.title} (${input.category})`;
    });
  }
  if (name === "archive_set_scrap_status") {
    return withArchiveDb((db) => {
      const r = db.prepare("UPDATE scraps SET status = ? WHERE id = ?").run(String(input.status), String(input.id));
      if (r.changes === 0) throw new Error(`해당 id의 스크랩이 없습니다: ${input.id}`);
      return `상태 변경 완료: ${input.id} → ${input.status}`;
    });
  }
  if (name === "archive_update_scrap") {
    return withArchiveDb((db) => {
      const fields = ["deadline", "title", "url", "memo"].filter((k) => input[k] !== undefined);
      if (!fields.length) throw new Error("바꿀 항목이 없습니다 (deadline/title/url/memo 중 하나 이상 필요)");
      const set = fields.map((k) => `${k} = ?`).join(", ");
      const vals = fields.map((k) => String(input[k]));
      const r = db.prepare(`UPDATE scraps SET ${set} WHERE id = ?`).run(...vals, String(input.id));
      if (r.changes === 0) throw new Error(`해당 id의 스크랩이 없습니다: ${input.id}`);
      return `수정 완료: ${input.id} (${fields.join(", ")})`;
    });
  }
  if (name === "archive_delete_scrap") {
    return withArchiveDb((db) => {
      const row = db.prepare("SELECT title FROM scraps WHERE id = ?").get(String(input.id));
      if (!row) throw new Error(`해당 id의 스크랩이 없습니다: ${input.id}`);
      db.prepare("DELETE FROM scraps WHERE id = ?").run(String(input.id));
      return `삭제 완료: ${row.title}`;
    });
  }

  // 개발실: 파일 열람
  if (name === "list_files") {
    const dir = resolveInHome(input.path);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200);
    return entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") || "(빈 폴더)";
  }
  if (name === "read_file") {
    const file = resolveInHome(input.path);
    const text = fs.readFileSync(file, "utf8");
    const CHUNK = 8000;
    const start = Math.max(0, Math.floor(Number(input.offset) || 0));
    if (start >= text.length && text.length > 0) {
      return `(offset ${start}은 파일 끝(${text.length}자)을 넘어섰습니다. 더 읽을 내용이 없습니다.)`;
    }
    const slice = text.slice(start, start + CHUNK);
    const next = start + slice.length;
    // 아직 뒤에 내용이 남았으면 다음 offset을 알려준다 — 조각내어 끝까지 읽을 수 있게
    if (next < text.length) {
      return slice + `\n\n…(여기까지 ${next}/${text.length}자. 이어읽기: offset=${next})`;
    }
    return slice || "(빈 파일)";
  }

  // 개발실: git
  if (name === "git_status") {
    return clip(git(resolveRepo(input.repo), ["status", "--short", "--branch"])) || "변경사항 없음";
  }
  if (name === "git_diff") {
    const repo = resolveRepo(input.repo);
    const range = input.target ? `${input.base || "main"}...${String(input.target)}` : "HEAD";
    if (input.file) return clip(git(repo, ["diff", range, "--", String(input.file)]), 6000) || "변경 없음";
    return clip(git(repo, ["diff", range, "--stat"])) || "변경 없음";
  }
  if (name === "git_fetch") {
    return clip(git(resolveRepo(input.repo), ["fetch", "origin", "--prune"])) || "fetch 완료 (원격 최신 상태 반영됨)";
  }
  if (name === "git_log") {
    return clip(git(resolveRepo(input.repo), ["log", "--oneline", "-15"])) || "커밋 없음";
  }
  if (name === "git_commit") {
    const repo = resolveRepo(input.repo);
    git(repo, ["add", "-A"]);
    return clip(git(repo, ["commit", "-m", String(input.message)]));
  }
  if (name === "git_branch") {
    const repo = resolveRepo(input.repo);
    if (!input.name) return clip(git(repo, ["branch", "-vv"]));
    if (input.create) return clip(git(repo, ["checkout", "-b", String(input.name)])) || `브랜치 생성·이동: ${input.name}`;
    return clip(git(repo, ["checkout", String(input.name)])) || `브랜치 이동: ${input.name}`;
  }
  if (name === "git_merge") {
    return clip(git(resolveRepo(input.repo), ["merge", String(input.branch)]));
  }
  if (name === "git_push") {
    return clip(git(resolveRepo(input.repo), ["push"]));
  }

  // 개발실: 깃허브 PR (읽기 전용)
  if (name === "gh_pr_list") {
    const out = gh(["pr", "list", "--repo", String(input.repo),
      "--json", "number,title,author,updatedAt,isDraft"]);
    const prs = JSON.parse(out);
    if (!prs.length) return "열린 PR 없음";
    return prs.map((p) =>
      `#${p.number} ${p.title} — ${p.author?.login || "?"}${p.isDraft ? " (초안)" : ""} (${p.updatedAt})`
    ).join("\n");
  }
  if (name === "gh_pr_view") {
    const out = gh(["pr", "view", String(input.number), "--repo", String(input.repo),
      "--json", "number,title,author,body,headRefName,baseRefName,mergeable,mergeStateStatus,additions,deletions,files"]);
    const p = JSON.parse(out);
    const conflict = p.mergeable === "CONFLICTING" ? "⚠ 충돌 있음"
      : p.mergeable === "MERGEABLE" ? "충돌 없음" : `확인 중 (${p.mergeable})`;
    return clip([
      `#${p.number} ${p.title} — ${p.author?.login || "?"}`,
      `브랜치: ${p.headRefName} → ${p.baseRefName}`,
      `머지 가능 여부: ${conflict} (상태: ${p.mergeStateStatus})`,
      `변경 규모: +${p.additions} / -${p.deletions}, 파일 ${p.files?.length ?? "?"}개`,
      "", p.body || "(설명 없음)",
    ].join("\n"), 4000);
  }
  if (name === "gh_pr_diff") {
    return clip(gh(["pr", "diff", String(input.number), "--repo", String(input.repo)]), 6000) || "변경 없음";
  }

  throw new Error(`알 수 없는 도구: ${name}`);
}

// ── 부서 로딩: departments/<부서>/실장.md + employees/*.md ────────
// 모든 직원·실장에게 공통으로 붙는 태도 지침. 아첨(밀리면 소신 접기)을 막는다.
const BACKBONE = `
[일하는 태도 — 반드시 지킬 것]
- 근거를 갖고 한 판단은 상대가 반발한다고 뒤집지 마라. 판단을 바꾸는 유일한 이유는 **새로운 사실이나 내 오류를 보여주는 반례**다. 상대가 언짢아하거나 "그게 맞아?"라고 되묻는 것은 근거가 아니다 — 그럴 땐 왜 그렇게 봤는지 근거를 다시, 차분히 설명하라.
- "새 정보가 왔다"와 "그냥 압박이 왔다"를 구분하라. 전자면 기꺼이 고치고, 후자면 입장을 유지하라.
- 반사적으로 사과하거나 비위를 맞추지 마라. "제가 과했던 것 같다", "역시 사장님 말씀이 맞다" 같은 말은 **실제로 내가 틀렸을 때만** 한다. 틀렸으면 짧고 분명하게 인정하고 고쳐라. 맞으면 굽히지 말고 근거를 대라.
- 상대를 기분 좋게 하는 것보다 **믿을 수 있는 판단을 주는 것**이 네 일이다. 맞장구치는 직원보다 바른말 하는 직원이 쓸모 있다.
- 단, 고집이 아니라 근거다. 정말 틀렸으면 버티지 말고 인정하라.`;

function parseAgentFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`머리말(---)이 없습니다: ${file}`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  if (!meta.id || !meta.name) throw new Error(`id/name 누락: ${file}`);
  return { ...meta, system: m[2].trim() };
}

function loadDepartment(dirName) {
  const base = path.join(__dirname, "departments", dirName);
  const chiefDef = parseAgentFile(path.join(base, "실장.md"));

  const employees = {};
  const empDefs = fs
    .readdirSync(path.join(base, "employees"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseAgentFile(path.join(base, "employees", f)))
    .sort((a, b) => Number(a.order ?? 99) - Number(b.order ?? 99));
  for (const def of empDefs) {
    const toolNames = (def.tools || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const n of toolNames) {
      if (!TOOL_REGISTRY[n]) throw new Error(`${dirName}/${def.name}: 알 수 없는 도구 "${n}"`);
    }
    employees[def.id] = {
      title: def.name,
      color: def.color || "#5a5a6a",
      duty: def.duty || "",
      system: def.system + "\n" + BACKBONE,
      toolNames,
      model: def.model || MODEL, // md에서 model: claude-haiku-4-5 등으로 조절 가능
    };
  }

  const chief = {
    title: chiefDef.name,
    color: chiefDef.color || "#7a3a3a",
    model: chiefDef.model || MODEL,
    system:
      chiefDef.system +
      "\n\n현재 팀원:\n" +
      Object.values(employees).map((e) => `- ${e.title}: ${e.duty}`).join("\n") +
      "\n" + BACKBONE,
  };

  return {
    id: dirName,
    name: dirName,
    order: Number(chiefDef.order ?? 99),
    theme: { wall: chiefDef.wall || null, preset: chiefDef.theme || null },
    // 실장.md에 private: true면 원격(터널) 접속자에게 이 부서를 숨기고 접근을 막는다
    private: /^(true|yes|1)$/i.test(chiefDef.private || ""),
    // prboard: true면 부서 상단에 팀원별 PR 집계(스코어보드)를 띄운다
    prBoard: /^(true|yes|1)$/i.test(chiefDef.prboard || ""),
    chief,
    employees,
    busy: false,
  };
}

// cloudflared 터널을 거친 요청에만 붙는 헤더 — 로컬·같은 와이파이 접속에는 없다
function isRemote(req) {
  return Boolean(req.headers["cf-connecting-ip"]);
}

// 사장님 판별: 내 맥에서 직접 접속(localhost)한 경우만.
// cloudflared는 맥 안에서 중계해서 터널 요청도 소켓은 루프백이므로 cf 헤더로 걸러낸다.
function isOwner(req) {
  const a = req.socket.remoteAddress || "";
  return !isRemote(req) && (a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1");
}

// ── 사원 명부: 사람 직급 (사장 > 이사 > 본부장 > AI 직원) ──────────
// office/members.json: [ { id, name, rank, code } ] — 코드는 사장이 발급해 본인에게만 알려준다
// office/tokens.json:  { 발급토큰: 사원id } — 로그인 상태가 서버 재시작을 넘어 유지된다
const MEMBERS_FILE = path.join(__dirname, "members.json");
const TOKENS_FILE = path.join(__dirname, "tokens.json");
const RANKS = { 사장: 3, 이사: 2, 본부장: 1 };

function readMembers() {
  return readJson(MEMBERS_FILE, []);
}
function saveMembers(list) {
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(list, null, 2));
}
function readTokens() {
  return readJson(TOKENS_FILE, {});
}
function newId() {
  return crypto.randomBytes(6).toString("base64url");
}
function newCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

// 명부가 없으면 사장 한 명으로 시작한다 (발급 코드는 이때 한 번 로그에 찍힌다)
if (!readMembers().length) {
  const code = newCode();
  saveMembers([{ id: newId(), name: "연성", rank: "사장", code }]);
  console.log(`사원 명부 생성 — 사장 연성 / 접속 코드 ${code} (office/members.json)`);
}

// 접속자 신원: x-office-token 헤더 → 명부 조회.
// 내 맥에서 직접 켠 브라우저(localhost)는 코드 없이 사장으로 본다.
function whoIs(req) {
  const token = String(req.headers["x-office-token"] || "");
  if (token) {
    const id = readTokens()[token];
    const m = readMembers().find((x) => x.id === id);
    if (m) return m;
  }
  if (isOwner(req)) return readMembers().find((x) => x.rank === "사장") || null;
  return null;
}
function rankOf(req) {
  return RANKS[whoIs(req)?.rank] || 0;
}
const isBoss = (req) => rankOf(req) >= RANKS.사장;

const DEPARTMENTS = {};
for (const dir of fs
  .readdirSync(path.join(__dirname, "departments"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)) {
  const dept = loadDepartment(dir);
  DEPARTMENTS[dept.id] = dept;
  console.log(
    `부서 개설: ${dept.name} — ${dept.chief.title} + 직원 ${Object.keys(dept.employees).length}명`
  );
}

// ── 세션: 부서별 대화 컨텍스트 (대회·프로젝트 단위). 파일로 영속화 ──
const SESS_DIR = path.join(__dirname, "sessions");

function saveSession(dept, s) {
  fs.writeFileSync(path.join(SESS_DIR, dept.id, s.id + ".json"), JSON.stringify(s));
}
function createSession(dept, title) {
  const s = {
    id: crypto.randomBytes(6).toString("base64url"),
    title: String(title).slice(0, 40),
    createdAt: new Date().toISOString(),
    events: [],      // 메신저 기록 복원용
    sdkSessions: {}, // 에이전트별 Claude Code 세션 id (resume으로 대화 맥락 유지)
  };
  dept.sessions[s.id] = s;
  saveSession(dept, s);
  return s;
}
for (const dept of Object.values(DEPARTMENTS)) {
  const dir = path.join(SESS_DIR, dept.id);
  fs.mkdirSync(dir, { recursive: true });
  dept.sessions = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      dept.sessions[s.id] = s;
    } catch {}
  }
  if (!Object.keys(dept.sessions).length) createSession(dept, "기본 업무");
}

// ── 부서 게시판: 팀원끼리 직접 쓰는 공유 메모 (직원 호출 없음) ────
const BOARDS_DIR = path.join(__dirname, "boards");
fs.mkdirSync(BOARDS_DIR, { recursive: true });
function readBoard(deptId) {
  return readJson(path.join(BOARDS_DIR, deptId + ".json"), []);
}
function saveBoard(deptId, memos) {
  fs.writeFileSync(path.join(BOARDS_DIR, deptId + ".json"), JSON.stringify(memos, null, 2));
}

// ── PR 스코어보드: 팀원별 push 접수 횟수 + 변경 줄수 (prboard: true 부서 상단에 표시) ──
// office/pr-stats.json: { "부서id": { "팀원 이름": { prs: 횟수, lines: 누적 변경 줄수 } } }
// 기여도 %는 프론트가 (push 횟수 비율 + 변경량 비율) / 2 로 계산한다
const PR_STATS_FILE = path.join(__dirname, "pr-stats.json");
function readPrStats() {
  return readJson(PR_STATS_FILE, {});
}

// ── PM 봇: 깃허브 활동 알림 ────────────────────────────────────
// office/git-log.json: { "부서id": [ { kind, text, at } ] } — 부서당 최근 60건만 남긴다
const GIT_LOG_FILE = path.join(__dirname, "git-log.json");
const GIT_LOG_KEEP = 60;
function readGitLog() {
  return readJson(GIT_LOG_FILE, {});
}
// kind: push | pr | merge | gate | info
// detail: 줄에 접어 넣을 긴 본문 (결재 줄에 점검관 의견을 싣는 용도). 파일이 붓지 않게 잘라 담는다.
const GIT_LOG_DETAIL_MAX = 1200;
function logGit(dept, kind, text, detail = "") {
  if (!dept?.prBoard) return; // PM 봇 알림창이 있는 부서에서만
  const all = readGitLog();
  const list = (all[dept.id] ||= []);
  const entry = { kind, text, at: new Date().toISOString() };
  if (detail) {
    const t = String(detail).trim();
    entry.detail = t.length > GIT_LOG_DETAIL_MAX ? t.slice(0, GIT_LOG_DETAIL_MAX) + "\n…(생략)" : t;
  }
  list.push(entry);
  if (list.length > GIT_LOG_KEEP) list.splice(0, list.length - GIT_LOG_KEEP);
  fs.writeFileSync(GIT_LOG_FILE, JSON.stringify(all, null, 2));
  broadcast({ type: "git_log", dept: dept.id, entry });
}
function broadcastPrStats(deptId, stats) {
  broadcast({ type: "pr_stats", dept: deptId, stats: stats[deptId] || {} });
}
// 채팅·게시판에 이름을 남기면 그때부터 스코어보드에 오른다 (PR 0개로 시작)
function registerPrMember(dept, name) {
  if (!dept?.prBoard || !name) return;
  const stats = readPrStats();
  const board = (stats[dept.id] ||= {});
  if (board[name] !== undefined) return;
  board[name] = { prs: 0, lines: 0 };
  fs.writeFileSync(PR_STATS_FILE, JSON.stringify(stats, null, 2));
  broadcastPrStats(dept.id, stats);
}
// push한 사람 단서(깃허브 계정·커밋 작성자·브랜치 이름)를 스코어보드 이름과 대조해 집계.
// 이름이 안 맞으면 pr-watch.json의 "authors": {"깃허브계정": "팀원 이름"} 별명표로 잇는다.
function creditPr(dept, watch, hints, lines = 0) {
  if (!dept?.prBoard) return null;
  const stats = readPrStats();
  const board = (stats[dept.id] ||= {});
  const alias = {};
  for (const [k, v] of Object.entries(watch?.authors || {})) alias[k.toLowerCase()] = v;
  const names = {};
  for (const n of Object.keys(board)) names[n.toLowerCase()] = n;
  let who = null;
  for (const h of hints.filter(Boolean).map((h) => String(h).toLowerCase())) {
    who = alias[h] || names[h];
    if (who) break;
  }
  if (!who) return null;
  const rec = typeof board[who] === "object" && board[who]
    ? board[who]
    : { prs: Number(board[who]) || 0, lines: 0 }; // 구버전(숫자만) 호환
  rec.prs += 1;
  rec.lines += Math.max(0, Number(lines) || 0);
  board[who] = rec;
  fs.writeFileSync(PR_STATS_FILE, JSON.stringify(stats, null, 2));
  broadcastPrStats(dept.id, stats);
  return who;
}

// ── 첨부 파일: 메신저에서 올린 파일 (부서별 폴더, 팀원 다운로드 + 직원 열람) ──
const UPLOADS_DIR = path.join(__dirname, "uploads");
const UPLOAD_MAX = 10 * 1024 * 1024; // 10MB
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── SSE 중계 ──────────────────────────────────────────────────
const sseClients = new Set(); // { res, boss, member }

// 지금 접속 중인 사람 명단. 한 사람이 탭 여러 개를 열어도 한 명으로 센다(id로 묶음).
function presenceList() {
  const by = new Map();
  for (const c of sseClients) {
    const m = c.member;
    if (!m) continue; // 로그인 안 한 연결은 세지 않는다
    // id로 묶되(같은 사람 여러 탭), 내부 id는 밖으로 내보내지 않는다 — 이름만 실어 보낸다
    const cur = by.get(m.id) || { name: m.name, rank: m.rank, tabs: 0 };
    cur.tabs++;
    by.set(m.id, cur);
  }
  // 사장 > 이사 > 본부장 순으로 정렬
  return [...by.values()].sort((a, b) => (RANKS[b.rank] || 0) - (RANKS[a.rank] || 0));
}
function broadcastPresence() {
  const people = presenceList();
  broadcast({ type: "presence", people });
}

function broadcast(event) {
  const tag = [event.dept, event.type, event.agent, event.name, event.to, event.from].filter(Boolean).join(" ");
  console.log(`[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] ${tag}`);
  const data = `data: ${JSON.stringify(event)}\n\n`;
  const priv = event.dept ? DEPARTMENTS[event.dept]?.private : false;
  for (const c of sseClients) {
    if (priv && !c.boss) continue; // 비공개 부서 소식은 사장 외에는 보내지 않는다
    c.res.write(data);
  }
}

// 메신저에 남아야 하는 이벤트는 세션에도 기록한다 (재접속/재시작 시 복원)
const STORED_EVENTS = new Set(["user", "delegate", "tool", "report", "assistant", "error", "confirm_request", "confirm_result"]);
function record(dept, session, event) {
  const ev = { ...event, dept: dept.id, session: session.id };
  broadcast(ev);
  if (STORED_EVENTS.has(ev.type)) session.events.push(ev);
}

// ── 공용 에이전트 실행 (Agent SDK — 헤드리스 Claude Code, 구독으로 과금) ──
// mcpTools: 이 에이전트에게 내줄 우리 도구들. extraAllowed: 허용할 내장 도구 (WebSearch 등).
// 대화 맥락은 session.sdkSessions[agentId]에 저장된 Claude Code 세션을 resume해서 유지한다.
async function runAgentQuery(dept, session, agentId, agent, prompt, mcpTools, extraAllowed = []) {
  record(dept, session, { type: "status", agent: agentId, state: "thinking" });
  const started = Date.now();
  const heartbeat = setInterval(() => {
    record(dept, session, {
      type: "working",
      agent: agentId,
      seconds: Math.round((Date.now() - started) / 1000),
    });
  }, 30000);
  try {
    const sdkIds = (session.sdkSessions ||= {}); // 구버전 세션 파일 호환
    const q = query({
      prompt,
      options: {
        model: agent.model || MODEL,
        systemPrompt: agent.system,
        mcpServers: { office: createSdkMcpServer({ name: "office", version: "1.0.0", tools: mcpTools }) },
        allowedTools: [...mcpTools.map((t) => `mcp__office__${t.name}`), ...extraAllowed],
        disallowedTools: BLOCKED_BUILTINS.filter((t) => !extraAllowed.includes(t)),
        maxTurns: 40,
        cwd: HOME,
        env: AGENT_ENV,
        ...(sdkIds[agentId] ? { resume: sdkIds[agentId] } : {}),
      },
    });

    let answer = "";
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        sdkIds[agentId] = msg.session_id;
      } else if (msg.type === "assistant") {
        // 우리 도구는 핸들러 안에서 기록하므로 여기서는 내장 웹 도구만 메신저에 띄운다
        for (const b of msg.message?.content || []) {
          if (b.type === "tool_use" && (b.name === "WebSearch" || b.name === "WebFetch")) {
            record(dept, session, { type: "tool", agent: agentId, name: b.name, input: b.input });
          }
        }
      } else if (msg.type === "result") {
        if (msg.subtype !== "success") throw new Error(`${agentId}: 작업 실패 (${msg.subtype})`);
        answer = msg.result || "";
      }
    }
    return answer;
  } finally {
    clearInterval(heartbeat);
  }
}

// 직원의 도구 목록 → SDK MCP 도구 + 허용할 내장 도구. 결재 게이트는 핸들러 안에서 처리한다.
// 로컬 도구 하나를 SDK 도구로 감싼다 (결재 게이트·PM 봇 기록 포함). 직원과 실장이 함께 쓴다.
function localSdkTool(dept, session, agentId, def) {
  return sdkTool(def.name, def.description, zodShapeFrom(def.input_schema), async (input) => {
    record(dept, session, { type: "tool", agent: agentId, name: def.name, input });
    try {
      if (GATED_TOOLS[def.name]) {
        const approved = await requestConfirmation(dept, session, agentId, GATED_TOOLS[def.name](input));
        if (!approved) {
          return {
            content: [{ type: "text", text: "사장님이 결재를 반려했습니다. 이 작업은 실행하지 않았습니다. 필요하면 대안을 제시하세요." }],
          };
        }
      }
      const result = runLocalTool(def.name, input);
      if (def.name === "save_note" || def.name === "delete_note") notesChanged();
      // PM 봇 알림창: 결재까지 통과해서 실제로 실행된 병합·푸시만 남긴다
      if (def.name === "git_merge") logGit(dept, "merge", `MERGE: ${input.branch} → ${currentBranch(input.repo) || "현재 브랜치"}`);
      if (def.name === "git_push") logGit(dept, "push", `PUSH: ${currentBranch(input.repo) || "현재 브랜치"} → 원격`);
      return { content: [{ type: "text", text: String(result) }] };
    } catch (err) {
      return { content: [{ type: "text", text: "오류: " + (err?.message || String(err)) }], isError: true };
    }
  });
}

function buildEmployeeTools(dept, session, agentId, emp) {
  const tools = [];
  const extraAllowed = [];
  for (const name of emp.toolNames) {
    const def = TOOL_REGISTRY[name];
    if (def.builtin) {
      extraAllowed.push(def.builtin);
      continue;
    }
    tools.push(localSdkTool(dept, session, agentId, def));
  }
  return { tools, extraAllowed };
}

// 실장의 위임 도구: ask_<직원id> — 핸들러가 직원 업무를 통째로 돌리고 보고를 돌려준다.
// 여기에 read_file/list_files도 직접 쥐여준다 — 첨부 파일은 실장이 곧바로 읽을 수 있어야
// 아무 직원에게나 위임했다가 "읽을 도구가 없다"고 막히는 일이 없다 (읽기 전용이라 안전).
function buildChiefTools(dept, session) {
  const chiefFileTools = ["read_file", "list_files"].map((n) =>
    localSdkTool(dept, session, "chief", TOOL_REGISTRY[n])
  );
  return chiefFileTools.concat(Object.entries(dept.employees).map(([id, e]) =>
    sdkTool(
      `ask_${id}`,
      `${e.title} 직원에게 업무를 시킨다. 담당: ${e.duty}`,
      { request: z.string().describe("요청 내용 (맥락 포함, 구체적으로)") },
      async ({ request }) => {
        record(dept, session, { type: "delegate", to: id, text: request });
        try {
          const report = await runEmployee(dept, session, id, request);
          record(dept, session, { type: "report", from: id, text: report });
          return { content: [{ type: "text", text: report }] };
        } catch (err) {
          const msg = "직원 업무 실패: " + (err?.message || String(err));
          record(dept, session, { type: "report", from: id, text: msg });
          return { content: [{ type: "text", text: msg }], isError: true };
        }
      }
    )
  ));
}

// ── 결재 대기열: 파괴적 도구는 사장님이 승인해야 실행된다 ──────────
// 결재 내용도 함께 들고 있는다 — 새로 접속한(새로고침한) 사장님에게 카드를 다시 띄워야 하기 때문.
const pendingConfirms = new Map(); // id → { resolve(approve), event }

// 브랜치를 누가 push했는지 기억해 둔다 — 반려됐을 때 "누가 고쳐야 하는지"를 알림에 적기 위해.
// 서버가 살아있는 동안만 유지되면 충분하다 (재시작하면 다음 push 때 다시 채워진다).
const branchPusher = new Map(); // "feature/payment" → "연성"

// 결재 설명에서 브랜치 이름을 뽑아 push한 사람을 찾는다.
// 설명 형식이 바뀌어도 견디도록 두 가지를 다 본다: "병합: origin/브랜치 → main"과 옛 "branch: …"
function pusherOf(description) {
  const s = String(description);
  const m = s.match(/병합:\s*(?:origin\/)?([^\s→]+)/) || s.match(/branch:\s*(?:origin\/)?([^\s,)]+)/);
  return m ? branchPusher.get(m[1]) || "" : "";
}

// 점검관 보고에서 치명·경고 건수를 센다. 형식이 안 맞으면 세지 않는다 (틀린 숫자보다 없는 게 낫다).
function tallyFindings(text) {
  if (!text) return "";
  const lines = String(text).split("\n");
  const count = { 치명: 0, 경고: 0 };
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    // 항목("1. …" / "**1. …**")을 먼저 본다 — 굵은 글씨 항목을 제목으로 오인하지 않도록
    if (/^\*{0,2}\d+\.\s/.test(line)) {
      if (section) count[section]++;
      continue;
    }
    if (/^#{1,4}\s/.test(line) || /^\*\*[^*]+\*\*$/.test(line)) {
      if (/치명/.test(line)) section = "치명";
      else if (/경고/.test(line)) section = "경고";
      else section = null;
      if (section && /없(음|습니다)/.test(line)) section = null; // "치명 — 없음"
    }
  }
  const parts = [];
  if (count.치명) parts.push(`치명 ${count.치명}건`);
  if (count.경고) parts.push(`경고 ${count.경고}건`);
  return parts.join(" · ");
}

// 결재 카드에 붙일 점검 코멘트 — 이 세션에서 점검관이 마지막으로 낸 보고를 그대로 싣는다.
// 요약하지 않는 이유: 사장님이 "무슨 문제인지" 직접 읽고 승인·반려를 정해야 하기 때문.
function latestReview(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const e = session.events[i];
    if (e.type === "confirm_result") break; // 지난 결재보다 뒤엣것만 본다
    if (e.type === "report" && /inspector/.test(e.from || "")) {
      return { by: e.from, text: String(e.text || "") };
    }
  }
  return null;
}

function requestConfirmation(dept, session, agentId, description) {
  const id = crypto.randomBytes(6).toString("base64url");
  const review = latestReview(session);
  const event = {
    type: "confirm_request", id, agent: agentId, description, review,
    dept: dept.id, session: session.id, at: Date.now(),
  };
  record(dept, session, { type: "confirm_request", id, agent: agentId, description, review });
  return new Promise((resolve) => {
    // 결재 결과를 PM 봇 창에 남긴다. 반려됐을 때 "누가 무엇을 왜" 고쳐야 하는지가 한 줄에 다 보이도록
    // push한 사람 이름과 치명·경고 건수를 붙이고, 점검관 의견 원문은 접힌 본문으로 싣는다.
    const gateLog = (head) => {
      const who = pusherOf(description);
      const tally = tallyFindings(review?.text);
      const parts = [head, description];
      if (who) parts.push(`push: ${who}`);
      if (tally) parts.push(tally);
      logGit(dept, "gate", parts.join(" — "), review?.text || "");
    };
    const timer = setTimeout(() => {
      if (pendingConfirms.delete(id)) {
        record(dept, session, { type: "confirm_result", id, approve: false, timeout: true });
        gateLog("결재 시한 경과 · 자동 반려");
        resolve(false); // 5분간 결재가 없으면 자동 반려
      }
    }, 5 * 60 * 1000);
    pendingConfirms.set(id, {
      event,
      resolve: (approve) => {
        clearTimeout(timer);
        record(dept, session, { type: "confirm_result", id, approve });
        gateLog(`결재 ${approve ? "승인" : "반려"}`);
        resolve(approve);
      },
    });
  });
}

// ── 관제실: 규칙으로 이상을 잡아내고, 설명이 필요하면 그때만 AI를 부른다 ──────
// 규칙 판정은 상시·무료. AI 진단은 사장님이 "왜?"를 눌렀을 때만 돌아간다(구독 소모).
const SERVER_STARTED = Date.now();
const pollHealth = { lastRun: 0, repos: {} }; // repo → { okAt, failAt, error, fails }

function notePollOk(repo) {
  const r = (pollHealth.repos[repo] ||= { okAt: 0, failAt: 0, error: "", fails: 0 });
  r.okAt = Date.now();
  r.fails = 0;
  r.error = "";
}
function notePollFail(repo, err) {
  const r = (pollHealth.repos[repo] ||= { okAt: 0, failAt: 0, error: "", fails: 0 });
  r.failAt = Date.now();
  r.fails++;
  r.error = String(err?.message || err).split("\n")[0].slice(0, 200);
}

const mins = (ms) => Math.floor(ms / 60000);
function since(ts) {
  if (!ts) return "없음";
  const m = mins(Date.now() - ts);
  return m < 1 ? "방금" : m < 60 ? `${m}분 전` : `${Math.floor(m / 60)}시간 전`;
}

// 점검 항목 하나. level: ok | warn | bad
const chk = (id, title, level, detail, hint = "") => ({ id, title, level, detail, hint });

function runChecks() {
  const out = [];

  // 1) 부서가 한 업무에 너무 오래 붙잡혀 있지 않은가
  for (const d of Object.values(DEPARTMENTS)) {
    if (!d.busy) {
      out.push(chk(`dept:${d.id}`, `${d.name}`, "ok", "대기 중"));
      continue;
    }
    const m = mins(Date.now() - (d.busySince || Date.now()));
    const level = m >= 15 ? "bad" : m >= 8 ? "warn" : "ok";
    out.push(chk(`dept:${d.id}`, `${d.name}`, level, `${m}분째 업무 중`,
      level === "ok" ? "" : "한 지시가 오래 걸리고 있습니다. 그 부서는 끝날 때까지 새 지시를 못 받습니다."));
  }

  // 2) 결재 대기 — 놓치면 자동 반려된다
  const pend = [...pendingConfirms.values()].map((p) => p.event);
  if (!pend.length) {
    out.push(chk("confirm", "결재 대기", "ok", "없음"));
  } else {
    const left = pend.map((e) => 5 - mins(Date.now() - (e.at || Date.now())));
    const soon = Math.min(...left);
    out.push(chk("confirm", "결재 대기", soon <= 2 ? "bad" : "warn",
      `${pend.length}건 · 가장 급한 건 약 ${Math.max(soon, 0)}분 남음`,
      "5분 안에 승인하지 않으면 자동 반려됩니다. " + pend.map((e) => e.description).join(" / ")));
  }

  // 3) 깃허브 감시가 살아 있는가
  const watches = readJson(WATCH_FILE, []);
  if (!watches.length) {
    out.push(chk("watch", "깃허브 감시", "warn", "등록된 저장소 없음",
      "대회 때 팀원 push를 자동 접수하려면 pr-watch.json에 저장소를 등록해야 합니다."));
  } else {
    const broken = watches.filter((w) => (pollHealth.repos[w.repo]?.fails || 0) > 0);
    const lag = pollHealth.lastRun ? mins(Date.now() - pollHealth.lastRun) : 99;
    let level = "ok", detail = `${watches.length}개 감시 중 · 마지막 확인 ${since(pollHealth.lastRun)}`;
    let hint = "";
    if (broken.length) {
      level = "bad";
      const b = broken[0];
      detail = `${b.repo} 조회 실패 ${pollHealth.repos[b.repo].fails}회 연속`;
      hint = pollHealth.repos[b.repo].error;
    } else if (lag > 5) {
      level = "warn";
      hint = "폴링이 멈춘 것처럼 보입니다. 서버 로그를 확인하세요.";
    }
    out.push(chk("watch", "깃허브 감시", level, detail, hint));
  }

  // 4) 누가 접속해 있나
  const roster = readMembers();
  out.push(chk("people", "사원 접속", "ok",
    `명부 ${roster.length}명 · 지금 접속 ${sseClients.size}명`,
    roster.map((m) => `${m.rank} ${m.name}`).join(", ")));

  // 5) 팀원이 밖에서 들어올 통로(터널)가 열려 있나
  let tunnelUp = false;
  try {
    execFileSync("pgrep", ["-f", "cloudflared tunnel"], { timeout: 3000 });
    tunnelUp = true;
  } catch { /* 안 돌고 있으면 pgrep이 비정상 종료한다 */ }
  out.push(chk("tunnel", "외부 접속 터널", tunnelUp ? "ok" : "warn",
    tunnelUp ? "열려 있음" : "닫혀 있음",
    tunnelUp ? "" : "지금은 같은 와이파이에서만 접속됩니다. 밖에서 들어오려면 office/tunnel.sh를 실행하세요."));

  // 6) 비서실 아카이버 담당이 쓰는 DB가 제자리에 있나
  const dbOk = fs.existsSync(ARCHIVE_DB);
  out.push(chk("archive", "아카이버 DB", dbOk ? "ok" : "warn",
    dbOk ? "연결 가능" : "파일 없음",
    dbOk ? "" : `${ARCHIVE_DB} 가 없습니다. 아카이버 담당 도구만 실패하고 나머지는 정상입니다.`));

  // 7) 서버 자체
  out.push(chk("server", "사무실 서버", "ok",
    `가동 ${since(SERVER_STARTED).replace(" 전", "")} · 감시 주기 ${PR_POLL_MS / 1000}초`));

  return out;
}

// 사장님이 "왜?"를 눌렀을 때만 부르는 진단. 도구 없이 한 번만 물어본다 — 짧게, 싸게.
// 서버 로그 꼬리를 함께 넘겨서 추측이 아니라 실제 흔적을 보고 말하게 한다.
function recentLog(lines = 40) {
  try {
    const text = fs.readFileSync("/tmp/office.log", "utf8");
    return text.split("\n").slice(-lines).join("\n").slice(-4000);
  } catch {
    return "(로그를 읽지 못함)";
  }
}

async function diagnose(item) {
  const prompt =
    `너는 사내 AI 사무실 시스템("TERRA 연구실")의 운영 담당이다. 관제 점검에서 아래 항목이 걸렸다.\n\n` +
    `[항목] ${item.title}\n[판정] ${item.level}\n[상태] ${item.detail}\n` +
    (item.hint ? `[규칙이 붙인 설명] ${item.hint}\n` : "") +
    `\n[서버 로그 최근 기록]\n${recentLog()}\n\n` +
    `사장님(개발자지만 이 시스템 내부는 다 기억 못 함)에게 한국어로 설명해라.\n` +
    `1) 지금 무슨 일이 벌어지고 있는지 두세 문장\n` +
    `2) 당장 해야 할 일이 있으면 구체적인 명령·클릭 순서로. 없으면 "지켜봐도 됩니다"라고 분명히 말해라.\n` +
    `로그에 근거가 없으면 지어내지 말고 "로그만으로는 알 수 없다"고 해라. 전체 8줄을 넘기지 마라.`;

  const q = query({
    prompt,
    options: {
      model: "claude-haiku-4-5", // 판단이 아니라 설명이라 작은 모델로 충분하다
      systemPrompt: "너는 간결하고 정확한 운영 담당이다. 추측을 사실처럼 말하지 않는다.",
      allowedTools: [],
      disallowedTools: BLOCKED_BUILTINS,
      maxTurns: 1,
      cwd: HOME,
      env: AGENT_ENV,
    },
  });
  let answer = "";
  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const c of msg.message.content || []) if (c.type === "text") answer += c.text;
    }
  }
  return answer.trim() || "(진단 내용을 받지 못했습니다)";
}

// 팀원에게 위임된 업무 하나를 수행시키고 최종 보고를 받는다
async function runEmployee(dept, session, id, request) {
  const emp = dept.employees[id];
  const { tools, extraAllowed } = buildEmployeeTools(dept, session, id, emp);
  const report = await runAgentQuery(dept, session, id, emp, request, tools, extraAllowed);
  return report || "(보고 내용 없음)";
}

async function work(dept, session, text, name, files = null, rank = "") {
  // 파일 하나만 넘겨도(구버전 호출) 배열로 감싼다
  const fileList = Array.isArray(files) ? files : files ? [files] : [];
  dept.busy = true;
  dept.busySince = Date.now(); // 관제실이 "몇 분째 붙잡혀 있나"를 보려고 쓴다
  record(dept, session, {
    type: "user", text, name, rank,
    ...(fileList.length ? { files: fileList.map((f) => ({ name: f.name, url: f.url, size: f.size })) } : {}),
  });

  try {
    // 여러 명이 접속하는 사무실이라 발언자 이름·직급을 실장에게도 알려준다
    const who = [rank, name].filter(Boolean).join(" ");
    let prompt = who ? `[${who}] ${text}` : text;
    if (rank && rank !== "사장") {
      prompt +=
        `\n\n(발신자 직급: ${rank}. 회사 서열은 사장 > 이사 > 본부장 > AI 직원 순이며, ` +
        `${rank}님은 직원들의 상급자다. 지시는 그대로 따르되, 결재가 필요한 작업은 사장님 결재만 유효하다.)`;
    }
    if (fileList.length) {
      const lines = fileList
        .map((f) => `- ${f.name} (${Math.max(1, Math.round(f.size / 1024))}KB) — 경로: ${f.path}`)
        .join("\n");
      prompt +=
        `${prompt ? "\n\n" : ""}[첨부 파일 ${fileList.length}개]\n${lines}\n` +
        `너(실장)는 read_file/list_files 도구를 가지고 있으니 이 경로로 직접 내용을 읽을 수 있다 (텍스트 파일만). ` +
        `내용 확인이 필요하면 직접 읽고, 전문 처리가 필요하면 담당 직원에게 경로와 함께 위임하라.`;
    }
    const answer = await runAgentQuery(dept, session, "chief", dept.chief, prompt, buildChiefTools(dept, session));
    record(dept, session, { type: "assistant", text: answer });
  } catch (err) {
    console.error(err);
    record(dept, session, { type: "error", text: err?.message || String(err) });
  }

  dept.busy = false;
  dept.busySince = 0;
  broadcast({ type: "done", dept: dept.id, session: session.id });
  try {
    saveSession(dept, session);
  } catch (err) {
    console.error("세션 저장 실패:", err);
  }
}

// ── HTTP 서버 ─────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // GET(로컬용)과 POST(터널용 — cloudflared가 GET 스트림을 버퍼링해서) 둘 다 받는다
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // 터널(cloudflared) 등 중간 프록시가 작은 응답을 버퍼링하지 않도록 주석 패딩을 먼저 보낸다
    res.write(":" + " ".repeat(16384) + "\n\n");
    const me = whoIs(req);
    const boss = RANKS[me?.rank] >= RANKS.사장;
    const departments = Object.values(DEPARTMENTS)
      .filter((d) => !(d.private && !boss)) // 비공개 부서(비서실)는 사장만
      .sort((a, b) => a.order - b.order)
      .map((d) => ({
        id: d.id,
        name: d.name,
        busy: d.busy,
        theme: d.theme,
        prBoard: d.prBoard,
        prStats: readPrStats()[d.id] || {},
        gitLog: readGitLog()[d.id] || [],
        gitRepo: readJson(WATCH_FILE, []).find((w) => w?.dept === d.id)?.repo || "",
        sessions: Object.values(d.sessions)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt })),
        roster: {
          chief: { name: d.chief.title, color: d.chief.color, model: modelLabel(d.chief.model) },
          employees: Object.entries(d.employees).map(([id, e]) => ({
            id, name: e.title, color: e.color, duty: e.duty, model: modelLabel(e.model),
          })),
        },
      }));
    // 아직 안 끝난 결재를 함께 내려보낸다 — 새로고침해도 승인 버튼이 사라지지 않도록.
    // 비공개 부서(비서실)의 결재는 사장에게만 보인다.
    const pending = [...pendingConfirms.values()]
      .map((p) => p.event)
      .filter((e) => !(DEPARTMENTS[e.dept]?.private && !boss));
    res.write(
      `data: ${JSON.stringify({
        type: "hello",
        notes: noteCount(),
        departments,
        owner: boss,
        me: me ? { name: me.name, rank: me.rank, level: RANKS[me.rank] || 0 } : null,
        pendingConfirms: pending,
        presence: presenceList(),
      })}\n\n`
    );
    const client = { res, boss, member: me };
    sseClients.add(client);
    if (me) broadcastPresence(); // 새로 들어온 사람을 모두에게 알린다
    req.on("close", () => {
      sseClients.delete(client);
      if (client.member) broadcastPresence(); // 나간 사람도 반영한다
    });
    return;
  }

  // ── 관제실 ──────────────────────────────────────────────────
  // 전 부서·사원 접속·터널까지 한눈에 보는 화면이라 사장 전용이다.
  if (url.pathname === "/ops" || url.pathname === "/ops/diagnose") {
    if (!isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"boss only"}');
      return;
    }
    if (req.method === "GET" && url.pathname === "/ops") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ checks: runChecks(), at: new Date().toISOString() }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/ops/diagnose") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let id = "";
      try { id = String(JSON.parse(body || "{}").id || ""); } catch {}
      const item = runChecks().find((c) => c.id === id);
      if (!item) {
        res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"no such check"}');
        return;
      }
      try {
        const text = await diagnose(item);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: String(err?.message || err).slice(0, 300) }));
      }
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json" }).end('{"error":"method not allowed"}');
    return;
  }

  // 로그인 화면의 이름 목록 — 코드는 절대 내려보내지 않는다
  if (req.method === "GET" && url.pathname === "/members") {
    const list = readMembers()
      .map((m) => ({ name: m.name, rank: m.rank }))
      .sort((a, b) => (RANKS[b.rank] || 0) - (RANKS[a.rank] || 0));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ members: list }));
    return;
  }

  // 출근: 이름 + 개인 접속 코드 → 토큰 발급 (브라우저가 보관하고 매 요청에 붙인다)
  if (req.method === "POST" && url.pathname === "/login") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let name = "", code = "";
    try {
      const parsed = JSON.parse(body || "{}");
      name = String(parsed.name || "").trim();
      code = String(parsed.code || "").trim().toUpperCase();
    } catch {}
    const m = readMembers().find((x) => x.name === name && String(x.code).toUpperCase() === code);
    if (!m) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"wrong code"}');
      return;
    }
    const token = crypto.randomBytes(24).toString("base64url");
    const tokens = readTokens();
    tokens[token] = m.id;
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    console.log(`출근: ${m.rank} ${m.name}`);
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ token, name: m.name, rank: m.rank, level: RANKS[m.rank] || 0 })
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/confirm") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let id = "", approve = false;
    try {
      const parsed = JSON.parse(body || "{}");
      id = String(parsed.id || "");
      approve = Boolean(parsed.approve);
    } catch {}
    // 결재는 사장님 전용 — 이사·본부장은 결재 카드를 볼 수만 있다
    if (!isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"boss only"}');
      return;
    }
    const pending = pendingConfirms.get(id);
    if (!pending) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"no such confirm"}');
      return;
    }
    pendingConfirms.delete(id);
    pending.resolve(approve);
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    return;
  }

  if (req.method === "POST" && url.pathname === "/say") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let text = "", deptId = "", sessionId = "", create = false, name = "", fileRefs = [];
    try {
      const parsed = JSON.parse(body || "{}");
      text = String(parsed.text || "").trim();
      deptId = String(parsed.dept || "");
      sessionId = String(parsed.session || "");
      create = Boolean(parsed.create);
      name = String(parsed.name || "").trim().slice(0, 20);
      // files(배열) 우선, 없으면 옛 file(단일)도 받는다
      fileRefs = Array.isArray(parsed.files) ? parsed.files : parsed.file ? [parsed.file] : [];
    } catch {}
    // 이름·직급은 명부에서 가져온다 (본문의 name은 못 믿는다).
    // 커밋 훅·PR 감시 같은 서버 내부 호출은 localhost라 사장으로 통과한다.
    const me = whoIs(req);
    if (!me) {
      res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"login required"}');
      return;
    }
    name = me.name;
    const rank = me.rank;
    const dept = DEPARTMENTS[deptId];
    if (dept?.private && !isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"private dept"}');
      return;
    }
    // 세션은 id 우선, 없으면 제목으로 찾는다 (git 훅 등 외부 호출은 id를 모른다)
    let session = dept?.sessions[sessionId];
    if (dept && !session && sessionId) {
      session = Object.values(dept.sessions).find((s) => s.title === sessionId);
      if (!session && create) {
        session = createSession(dept, sessionId);
        broadcast({
          type: "session_created",
          dept: dept.id,
          session: { id: session.id, title: session.title, createdAt: session.createdAt },
        });
      }
    }
    // 첨부 파일: /upload가 돌려준 stored 값만 신뢰한다 (임의 경로 지정 차단)
    const files = [];
    for (const fileRef of fileRefs.slice(0, 10)) { // 한 번에 최대 10개
      if (!fileRef || !fileRef.stored) continue;
      const abs = path.resolve(UPLOADS_DIR, String(fileRef.stored));
      if (abs.startsWith(UPLOADS_DIR + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        files.push({
          name: path.basename(abs).replace(/^[0-9a-f]{8}-/, ""),
          path: abs,
          url: "/uploads/" + String(fileRef.stored).split("/").map(encodeURIComponent).join("/"),
          size: fs.statSync(abs).size,
        });
      }
    }
    if ((!text && !files.length) || !dept || !session) {
      res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"bad request"}');
      return;
    }
    if (dept.busy) {
      res.writeHead(409, { "Content-Type": "application/json" }).end('{"error":"busy"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    registerPrMember(dept, name);
    work(dept, session, text, name, files, rank);
    return;
  }

  // 메신저 첨부 업로드: 파일 본문을 그대로 받는다 (?dept=부서&name=원본파일명)
  if (req.method === "POST" && url.pathname === "/upload") {
    const dept = DEPARTMENTS[url.searchParams.get("dept") || ""];
    if (!dept) {
      res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"bad request"}');
      return;
    }
    if (dept.private && !isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"private dept"}');
      return;
    }
    const orig =
      path.basename(String(url.searchParams.get("name") || "파일"))
        .replace(/[\x00-\x1f"\\]/g, "_")
        .slice(-80) || "파일";
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > UPLOAD_MAX) {
        res.writeHead(413, { "Content-Type": "application/json" }).end('{"error":"too large"}');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    // 앞에 난수를 붙여 같은 이름끼리 덮어쓰지 않게 한다
    const stored = crypto.randomBytes(4).toString("hex") + "-" + orig;
    const dir = path.join(UPLOADS_DIR, dept.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, stored), Buffer.concat(chunks));
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ ok: true, file: { stored: dept.id + "/" + stored, name: orig, size } })
    );
    return;
  }

  // 첨부 파일 다운로드
  if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
    let rel = "";
    try {
      rel = decodeURIComponent(url.pathname.slice("/uploads/".length));
    } catch {}
    const abs = path.resolve(UPLOADS_DIR, rel);
    if (!abs.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    if (DEPARTMENTS[rel.split("/")[0]]?.private && !isBoss(req)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    // 올린 파일이 HTML이어도 브라우저에서 실행되지 않게 무조건 다운로드로 내려준다
    const downName = path.basename(abs).replace(/^[0-9a-f]{8}-/, "");
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downName)}`,
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/session") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let deptId = "", title = "";
    try {
      const parsed = JSON.parse(body || "{}");
      deptId = String(parsed.dept || "");
      title = String(parsed.title || "").trim();
    } catch {}
    const dept = DEPARTMENTS[deptId];
    if (dept?.private && !isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"private dept"}');
      return;
    }
    if (!dept || !title) {
      res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"bad request"}');
      return;
    }
    const s = createSession(dept, title);
    broadcast({
      type: "session_created",
      dept: dept.id,
      session: { id: s.id, title: s.title, createdAt: s.createdAt },
    });
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ id: s.id, title: s.title, createdAt: s.createdAt })
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/session/delete") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let deptId = "", sessionId = "";
    try {
      const parsed = JSON.parse(body || "{}");
      deptId = String(parsed.dept || "");
      sessionId = String(parsed.session || "");
    } catch {}
    const dept = DEPARTMENTS[deptId];
    if (dept?.private && !isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"private dept"}');
      return;
    }
    // 대화방 정리는 사장만 (이사·본부장은 새 세션을 만들 수만 있다)
    if (!isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"boss only"}');
      return;
    }
    const s = dept?.sessions[sessionId];
    if (!s) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    if (dept.busy) {
      res.writeHead(409, { "Content-Type": "application/json" }).end('{"error":"busy"}');
      return;
    }
    delete dept.sessions[sessionId];
    fs.rmSync(path.join(SESS_DIR, dept.id, sessionId + ".json"), { force: true });
    broadcast({ type: "session_deleted", dept: dept.id, session: sessionId });
    // 마지막 세션을 지웠으면 기본 세션을 새로 만들어준다
    if (!Object.keys(dept.sessions).length) {
      const fresh = createSession(dept, "기본 업무");
      broadcast({
        type: "session_created",
        dept: dept.id,
        session: { id: fresh.id, title: fresh.title, createdAt: fresh.createdAt },
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    return;
  }

  if (req.method === "GET" && url.pathname === "/board") {
    const dept = DEPARTMENTS[url.searchParams.get("dept") || ""];
    if (!dept) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    if (dept.private && !isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"private dept"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ memos: readBoard(dept.id) }));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/board" || url.pathname === "/board/delete")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    let deptId = "", text = "", name = "", memoId = "";
    try {
      const parsed = JSON.parse(body || "{}");
      deptId = String(parsed.dept || "");
      text = String(parsed.text || "").trim().slice(0, 500);
      name = String(parsed.name || "").trim().slice(0, 20);
      memoId = String(parsed.id || "");
    } catch {}
    const dept = DEPARTMENTS[deptId];
    if (!dept) {
      res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"bad request"}');
      return;
    }
    if (dept.private && !isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"private dept"}');
      return;
    }
    const me = whoIs(req);
    if (!me) {
      res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"login required"}');
      return;
    }
    name = me.name;
    let memos = readBoard(dept.id);
    if (url.pathname === "/board") {
      if (!text) {
        res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"bad request"}');
        return;
      }
      memos.push({ id: newId(), name, rank: me.rank, text, at: new Date().toISOString() });
      registerPrMember(dept, name);
    } else {
      // 남의 메모를 떼는 건 사장만. 이사·본부장은 자기가 붙인 것만 뗀다.
      const target = memos.find((m) => m.id === memoId);
      const mine = target && target.name === me.name;
      if (!mine && !isBoss(req)) {
        res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"boss only"}');
        return;
      }
      memos = memos.filter((m) => m.id !== memoId);
    }
    saveBoard(dept.id, memos);
    broadcast({ type: "board_updated", dept: dept.id, memos });
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    return;
  }

  // ── 메모함: 보기·쓰기 전부 사장 전용 (직원이 사장님 배경까지 적어두는 곳이라) ──
  if (url.pathname === "/notes" || url.pathname === "/note" || url.pathname === "/note/delete") {
    if (!isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"boss only"}');
      return;
    }
    const json = (code, obj) =>
      res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(obj));

    if (req.method === "GET" && url.pathname === "/notes") {
      json(200, { notes: listNotes() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/note") {
      const title = url.searchParams.get("title") || "";
      const file = noteFile(title);
      if (!title || !fs.existsSync(file)) {
        json(404, { error: "not found" });
        return;
      }
      json(200, { title: path.basename(file).replace(/\.md$/, ""), text: fs.readFileSync(file, "utf8") });
      return;
    }
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let title = "", text = "", oldTitle = "";
      try {
        const parsed = JSON.parse(body || "{}");
        title = String(parsed.title || "").trim().slice(0, 80);
        text = String(parsed.text ?? "");
        oldTitle = String(parsed.oldTitle || "").trim();
      } catch {}
      if (!title) {
        json(400, { error: "no title" });
        return;
      }
      const file = noteFile(title);
      if (url.pathname === "/note/delete") {
        if (!fs.existsSync(file)) {
          json(404, { error: "not found" });
          return;
        }
        fs.unlinkSync(file);
      } else {
        // 제목을 바꿨으면 새 이름으로 쓰고 예전 파일을 지운다 (직원이 read_note로 찾는 이름이 곧 파일명)
        fs.writeFileSync(file, text);
        if (oldTitle && oldTitle !== title) fs.rmSync(noteFile(oldTitle), { force: true });
      }
      notesChanged();
      json(200, { ok: true, title });
      return;
    }
    json(405, { error: "method not allowed" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/history") {
    const dept = DEPARTMENTS[url.searchParams.get("dept") || ""];
    if (dept?.private && !isBoss(req)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"private dept"}');
      return;
    }
    const session = dept?.sessions[url.searchParams.get("session") || ""];
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ events: session.events }));
    return;
  }

  const p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache", // 코드 갱신 시 옛 버전이 보이지 않도록
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`사무실 오픈: http://localhost:${PORT}`);
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  if (lan) console.log(`팀원 접속 (같은 와이파이): http://${lan.address}:${PORT}`);
  const roster = readMembers();
  console.log(`사원 ${roster.length}명 — ${roster.map((m) => `${m.rank} ${m.name}`).join(", ")}`);
});

// ── PR 감시자: 맥에서 gh로 깃허브를 폴링한다 (외부에서 들어오는 연결 없음) ──
// office/pr-watch.json: [{ "repo": "계정/이름", "session": "세션 제목", "dept": "부서명(생략 시 개발실)" }, ...]
//   "watch": "branches"를 주면 PR 대신 브랜치 push를 감시한다 (사무실 PR 방식 — 팀원은 push만 하면 됨).
//   브랜치 감시에는 "path"(맥에 있는 로컬 클론 절대 경로)도 함께 적는다. main/master push는 무시.
// office/pr-seen.json: 이미 본 PR의 head 커밋 기록 (새 PR·새 커밋 감지용)
const WATCH_FILE = path.join(__dirname, "pr-watch.json");
const SEEN_FILE = path.join(__dirname, "pr-seen.json");
// 깃허브에 "새 push 있냐"고 물어보는 간격. 대회 중 기다리는 시간을 줄이려고 1분으로 둔다.
// 더 짧게·길게 쓰려면 PR_POLL_MS 환경변수로 덮어쓴다 (예: PR_POLL_MS=30000 node office/server.mjs)
const PR_POLL_MS = Number(process.env.PR_POLL_MS) || 60000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function findOrCreateSession(dept, title) {
  const found = Object.values(dept.sessions).find((s) => s.title === title);
  if (found) return found;
  const s = createSession(dept, title);
  broadcast({
    type: "session_created",
    dept: dept.id,
    session: { id: s.id, title: s.title, createdAt: s.createdAt },
  });
  return s;
}

async function pollPRs() {
  const watches = readJson(WATCH_FILE, []);
  if (!Array.isArray(watches) || !watches.length) return;
  pollHealth.lastRun = Date.now();
  const seen = readJson(SEEN_FILE, {});

  for (const w of watches) {
    if (!w?.repo) continue;
    const dept = DEPARTMENTS[w.dept] || DEPARTMENTS["개발실"];

    // 브랜치 감시 모드: PR 없이 push만으로 점검이 접수된다
    if (w.watch === "branches") {
      let branches;
      try {
        branches = JSON.parse(gh(["api", `repos/${w.repo}/branches`,
          "--jq", "[.[] | {name: .name, sha: .commit.sha}]"]));
      } catch (err) {
        console.error(`브랜치 감시 실패 (${w.repo}):`, err.message?.slice(0, 200));
        notePollFail(w.repo, err);
        continue;
      }
      notePollOk(w.repo);
      const key = w.repo + "@branches";
      if (!seen[key]) {
        seen[key] = Object.fromEntries(branches.map((b) => [b.name, b.sha]));
        fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
        console.log(`브랜치 감시 시작: ${w.repo} (기준선 ${branches.length}개 브랜치)`);
        continue;
      }
      const fresh = branches.filter(
        (b) => b.name !== "main" && b.name !== "master" && seen[key][b.name] !== b.sha
      );
      if (!fresh.length) continue;
      if (dept.busy) continue; // 다음 폴링 때 재시도

      const b = fresh[0]; // 한 번에 하나씩만 접수
      const prevSha = seen[key][b.name]; // 새 브랜치면 undefined
      seen[key][b.name] = b.sha;
      fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));

      // push한 사람 집계: 깃허브 계정·커밋 작성자·브랜치 이름 순으로 대조
      let author = {};
      try {
        author = JSON.parse(gh(["api", `repos/${w.repo}/commits/${b.sha}`,
          "--jq", '{name: .commit.author.name, login: (.author.login // "")}']));
      } catch {}
      // 이번 push로 바뀐 줄 수: 직전 sha(새 브랜치면 main)와 비교 (기여도 계산 재료)
      let lines = 0;
      try {
        lines = Number(gh(["api", `repos/${w.repo}/compare/${prevSha || "main"}...${b.sha}`,
          "--jq", "[.files[] | .additions + .deletions] | add // 0"]));
      } catch {}
      const who = creditPr(dept, w, [author.login, author.name, b.name], lines);
      const pusher = who || author.name || author.login || "?";
      if (!who) console.log(`PR 집계 보류: ${w.repo} ${b.name} push한 "${pusher}"가 스코어보드 이름과 안 맞음`);

      branchPusher.set(b.name, pusher); // 나중에 반려 알림에 "누가 고쳐야 하는지" 적는다
      const session = findOrCreateSession(dept, w.session || w.repo.split("/").pop());
      console.log(`브랜치 push 감지: ${w.repo} ${b.name} → 세션 "${session.title}"`);
      logGit(dept, "push", `PUSH: ${b.name} — ${pusher} (${b.sha.slice(0, 7)}${lines ? `, ${lines}줄` : ""})`);
      work(dept, session,
        `[자동 알림] 깃허브 저장소 ${w.repo}의 브랜치 "${b.name}"에 새 push 감지 (커밋 ${b.sha.slice(0, 7)}, 작성자 ${pusher}). ` +
        (w.path ? `로컬 저장소 경로는 ${w.path}. ` : "") +
        `코드 점검관에게 git_fetch 후 git_diff(target: origin/${b.name})로 main과의 변경사항을 점검시켜줘. ` +
        `치명 항목이 있으면 반려 사유를 보고하고, 없으면 "머지해도 됨"이라고 짧게 보고해줘. 병합은 별도 지시가 있을 때만 한다.`, "자동");
      return; // 이번 턴은 하나만
    }

    let prs;
    try {
      prs = JSON.parse(gh(["pr", "list", "--repo", String(w.repo),
        "--json", "number,title,author,headRefOid,isDraft"]));
    } catch (err) {
      console.error(`PR 감시 실패 (${w.repo}):`, err.message?.slice(0, 200));
      notePollFail(w.repo, err);
      continue;
    }

    notePollOk(w.repo);

    // 처음 보는 저장소는 기준선만 잡는다 (기존 PR을 몰아서 점검하지 않음)
    if (!seen[w.repo]) {
      seen[w.repo] = Object.fromEntries(prs.map((p) => [p.number, p.headRefOid]));
      fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
      console.log(`PR 감시 시작: ${w.repo} (기준선 ${prs.length}개 PR)`);
      continue;
    }

    const fresh = prs.filter((p) => !p.isDraft && seen[w.repo][p.number] !== p.headRefOid);
    if (!fresh.length) continue;
    if (dept.busy) continue; // 다음 폴링 때 재시도

    const p = fresh[0]; // 한 번에 하나씩만 접수 (몰림 방지)
    seen[w.repo][p.number] = p.headRefOid;
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
    creditPr(dept, w, [p.author?.login]);

    const session = findOrCreateSession(dept, w.session || w.repo.split("/").pop());
    console.log(`PR 감지: ${w.repo} #${p.number} → 세션 "${session.title}"`);
    logGit(dept, "pr", `PR #${p.number}: ${p.title} — ${p.author?.login || "?"}`);
    work(dept, session,
      `[자동 알림] 깃허브 저장소 ${w.repo}에 PR 감지 — #${p.number} "${p.title}" (작성자: ${p.author?.login || "?"}). ` +
      `코드 점검관에게 gh_pr_view로 충돌 여부(mergeable)를 확인하고 gh_pr_diff로 변경사항을 점검시켜줘. ` +
      `치명 항목이나 충돌이 있으면 반려 사유를 보고하고, 없으면 통과라고 짧게 보고해줘.`, "자동");
    return; // 이번 턴은 하나만, 나머지는 다음 폴링에서
  }
}

setInterval(() => pollPRs().catch((e) => console.error("PR 감시 오류:", e)), PR_POLL_MS);
pollPRs().catch((e) => console.error("PR 감시 오류:", e));

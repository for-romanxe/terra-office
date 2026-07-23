#!/usr/bin/env node
// 사원 명부 관리 — office/members.json을 손으로 고치지 않기 위한 CLI.
// 서버는 요청마다 파일을 다시 읽으므로 재시작할 필요가 없다.
//
//   node office/members.mjs                  명부 보기 (접속 코드 포함)
//   node office/members.mjs add 민수 이사      팀원 추가 + 코드 발급
//   node office/members.mjs code 민수          코드 재발급 (기존 로그인 전부 해제)
//   node office/members.mjs rank 민수 본부장    직급 변경
//   node office/members.mjs remove 민수        퇴사 (로그인도 회수)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMBERS_FILE = path.join(__dirname, "members.json");
const TOKENS_FILE = path.join(__dirname, "tokens.json");
const RANKS = ["사장", "이사", "본부장"];

const read = (f, fb) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return fb;
  }
};
const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
const newCode = () => crypto.randomBytes(4).toString("hex").toUpperCase();

let members = read(MEMBERS_FILE, []);
const find = (name) => members.find((m) => m.name === name);

// 이 사람으로 발급된 토큰을 전부 무효화한다 (코드 재발급·퇴사 시)
function revoke(id) {
  const tokens = read(TOKENS_FILE, {});
  let n = 0;
  for (const [t, mid] of Object.entries(tokens)) {
    if (mid === id) {
      delete tokens[t];
      n++;
    }
  }
  write(TOKENS_FILE, tokens);
  return n;
}

function list() {
  if (!members.length) return console.log("명부가 비어 있습니다. 서버를 한 번 켜면 사장이 등록됩니다.");
  console.log("\n  직급     이름                 접속 코드");
  console.log("  ────────────────────────────────────────");
  for (const m of [...members].sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))) {
    console.log(`  ${m.rank.padEnd(7)}  ${m.name.padEnd(18)} ${m.code}`);
  }
  console.log("");
}

const [cmd, name, arg] = process.argv.slice(2);

if (!cmd) {
  list();
} else if (cmd === "add") {
  if (!name || !RANKS.includes(arg)) {
    console.error(`사용법: node office/members.mjs add <이름> <${RANKS.join("|")}>`);
    process.exit(1);
  }
  if (find(name)) {
    console.error(`이미 있는 이름입니다: ${name}`);
    process.exit(1);
  }
  const m = { id: crypto.randomBytes(6).toString("base64url"), name, rank: arg, code: newCode() };
  members.push(m);
  write(MEMBERS_FILE, members);
  console.log(`\n  ${m.rank} ${m.name} 등록 — 접속 코드 ${m.code}`);
  console.log("  이 코드를 본인에게만 전달하세요.\n");
} else if (cmd === "code") {
  const m = find(name);
  if (!m) {
    console.error(`명부에 없는 이름입니다: ${name}`);
    process.exit(1);
  }
  m.code = newCode();
  write(MEMBERS_FILE, members);
  const n = revoke(m.id);
  console.log(`\n  ${m.rank} ${m.name} 새 접속 코드 ${m.code} (기존 로그인 ${n}건 해제)\n`);
} else if (cmd === "rank") {
  const m = find(name);
  if (!m || !RANKS.includes(arg)) {
    console.error(`사용법: node office/members.mjs rank <이름> <${RANKS.join("|")}>`);
    process.exit(1);
  }
  const before = m.rank;
  m.rank = arg;
  write(MEMBERS_FILE, members);
  console.log(`\n  ${m.name}: ${before} → ${arg} (다음 새로고침부터 적용)\n`);
} else if (cmd === "remove") {
  const m = find(name);
  if (!m) {
    console.error(`명부에 없는 이름입니다: ${name}`);
    process.exit(1);
  }
  if (m.rank === "사장" && members.filter((x) => x.rank === "사장").length === 1) {
    console.error("마지막 사장은 지울 수 없습니다.");
    process.exit(1);
  }
  members = members.filter((x) => x.id !== m.id);
  write(MEMBERS_FILE, members);
  const n = revoke(m.id);
  console.log(`\n  ${m.rank} ${m.name} 퇴사 처리 (로그인 ${n}건 회수)\n`);
} else {
  console.error("모르는 명령입니다. add / code / rank / remove 또는 인자 없이 실행하세요.");
  process.exit(1);
}

#!/usr/bin/env node
// 방별 쉘 허용 관리 — office/shell.json을 손으로 고치지 않기 위한 CLI.
// 서버는 직원을 부를 때마다 파일을 다시 읽으므로 재시작할 필요가 없다.
//
//   node office/shell.mjs                  어느 방에 쉘이 켜져 있나 보기
//   node office/shell.mjs on 크몽작업실      그 방 직원에게 쉘 허용
//   node office/shell.mjs off 크몽작업실     회수
//
// 쉘을 켜면 그 방 직원은 사장님 계정으로 아무 명령이나 돌릴 수 있다.
// .ssh·.env·토큰을 막아둔 경로 안전장치도 쉘 앞에서는 소용이 없다.
// 그러니 사장님이 직접 쓰는 방만 켜고, 친구들이 지시하거나 PR·훅으로
// 외부 텍스트가 흘러드는 방은 꺼 둔다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHELL_FILE = path.join(__dirname, "shell.json");
const DEPTS_DIR = path.join(__dirname, "departments");

const read = () => {
  try {
    const v = JSON.parse(fs.readFileSync(SHELL_FILE, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const write = (list) => fs.writeFileSync(SHELL_FILE, JSON.stringify(list, null, 2) + "\n");

const allDepts = () =>
  fs
    .readdirSync(DEPTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

function show() {
  const on = new Set(read());
  console.log("방별 쉘 허용 상태\n");
  for (const d of allDepts()) {
    console.log(`  ${on.has(d) ? "● 켜짐" : "○ 꺼짐"}  ${d}`);
  }
  if (on.size) {
    console.log("\n※ 켜진 방의 직원은 사장님 계정으로 아무 명령이나 돌릴 수 있습니다.");
    console.log("   쓰고 나면 끄는 편이 안전합니다: node office/shell.mjs off <방이름>");
  }
}

const [cmd, dept] = process.argv.slice(2);

if (!cmd) {
  show();
} else if (cmd === "on" || cmd === "off") {
  if (!dept) {
    console.error(`방 이름이 필요합니다. 예: node office/shell.mjs ${cmd} 크몽작업실`);
    process.exit(1);
  }
  if (!allDepts().includes(dept)) {
    console.error(`그런 방이 없습니다: ${dept}\n있는 방: ${allDepts().join(", ")}`);
    process.exit(1);
  }
  const list = read().filter((d) => d !== dept);
  if (cmd === "on") list.push(dept);
  write(list);
  console.log(cmd === "on" ? `${dept}: 쉘 켜짐 — 직원이 명령을 돌릴 수 있습니다.` : `${dept}: 쉘 꺼짐.`);
  console.log("(서버 재시작 필요 없음 — 다음 지시부터 반영됩니다)");
} else {
  console.error(`알 수 없는 명령: ${cmd}\n사용법: node office/shell.mjs [on|off] <방이름>`);
  process.exit(1);
}

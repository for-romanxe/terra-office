// 3단계: 나를 위해 일하는 "비서 직원" 에이전트
// - 메모 저장/조회 (파일 시스템 = 비서의 기억)
// - 웹 검색 (Anthropic 서버에서 실행되는 도구 — 내가 구현할 필요 없음)
// - 대화형 REPL: 대화 기록이 유지되므로 이전 대화를 기억한다
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { fileURLToPath } from "url";

const NOTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "notes");
fs.mkdirSync(NOTES_DIR, { recursive: true });

const client = new Anthropic();

const tools = [
  // 서버 도구: 선언만 하면 Anthropic 서버가 알아서 검색까지 해준다
  { type: "web_search_20260209", name: "web_search", max_uses: 3 },

  // 아래는 내 코드가 실행하는 클라이언트 도구들
  {
    name: "save_note",
    description:
      "메모를 markdown 파일로 저장한다. 사용자가 기억해달라고 하거나, 나중에 필요할 정보가 나오면 사용.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "파일명이 될 짧은 제목 (확장자 제외)" },
        content: { type: "string", description: "저장할 내용 (markdown)" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "list_notes",
    description: "저장된 메모 파일 목록을 반환한다.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_note",
    description: "저장된 메모 하나의 내용을 읽는다.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string", description: "메모 제목 (확장자 제외)" } },
      required: ["title"],
    },
  },
];

function runTool(name, input) {
  // 모델이 준 제목을 파일명으로 쓰기 전에 경로 탈출을 막는다
  const safeName = (t) => path.basename(String(t)).replace(/\.md$/, "");

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
  throw new Error(`알 수 없는 도구: ${name}`);
}

const system = `너는 사용자의 개인 비서 직원이다. 한국어로 간결하게 대답한다.
- 사용자가 기억해달라는 것, 나중에 쓸 정보는 save_note로 저장한다.
- 과거에 말한 내용을 물어보면 list_notes / read_note로 먼저 찾아본다.
- 최신 정보(뉴스, 가격, 일정 등)가 필요하면 web_search를 사용한다.`;

const messages = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('비서 에이전트 시작. 종료하려면 "exit" 입력.\n');

while (true) {
  let userInput;
  try {
    userInput = (await rl.question("나> ")).trim();
  } catch {
    break; // 입력이 닫힘 (Ctrl+D, 파이프 종료 등)
  }
  if (!userInput) continue;
  if (userInput === "exit") break;
  messages.push({ role: "user", content: userInput });

  // 에이전트 루프: 이 사용자 발화에 대해 도구 호출이 끝날 때까지 반복
  while (true) {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    // 서버 도구(웹 검색)가 진행 중 멈춘 경우 — 그대로 다시 보내면 이어서 실행된다
    if (response.stop_reason === "pause_turn") continue;

    if (response.stop_reason !== "tool_use") {
      for (const block of response.content) {
        if (block.type === "text") console.log(`\n비서> ${block.text}\n`);
      }
      break;
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`  [${block.name}] ${JSON.stringify(block.input).slice(0, 100)}`);
      try {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: runTool(block.name, block.input),
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(err),
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }
}

rl.close();
console.log("비서 퇴근합니다. 👋");

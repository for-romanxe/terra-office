// 2단계: 에이전트의 핵심 = 도구 정의 + 실행 루프
// 모델에게 "폴더 목록 보기" 도구를 주고, 실제로 내 홈 폴더를 조사하게 한다.
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import os from "os";

const client = new Anthropic();

// ① 도구 정의: 이름 + 설명 + 입력 스키마. 모델은 "설명"을 보고 언제 쓸지 판단한다.
const tools = [
  {
    name: "list_directory",
    description:
      "지정한 디렉토리 안의 파일과 폴더 목록을 반환한다. 사용자 컴퓨터의 폴더 구조를 확인할 때 사용.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "확인할 디렉토리의 절대 경로" },
      },
      required: ["path"],
    },
  },
];

// ② 도구의 실제 구현: 모델이 요청하면 "내 코드"가 실행한다.
function listDirectory(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
    .join("\n");
}

const messages = [
  {
    role: "user",
    content: `내 홈 폴더(${os.homedir()})를 살펴보고, 개발 프로젝트로 보이는 폴더만 골라서 한 줄씩 뭘 하는 프로젝트일지 추측해줘.`,
  },
];

// ③ 에이전트 루프: 모델이 도구 요청을 멈출 때까지 반복
while (true) {
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    tools,
    messages,
  });

  // 모델의 응답(도구 요청 포함)을 대화 기록에 그대로 추가
  messages.push({ role: "assistant", content: response.content });

  // 도구 요청이 없으면 최종 답변 — 루프 종료
  if (response.stop_reason !== "tool_use") {
    for (const block of response.content) {
      if (block.type === "text") console.log(block.text);
    }
    break;
  }

  // 도구 요청을 전부 실행하고, 결과를 user 메시지 하나로 묶어서 돌려준다
  const toolResults = [];
  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    console.log(`[도구 실행] ${block.name}(${JSON.stringify(block.input)})`);
    try {
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id, // 어떤 요청에 대한 결과인지 반드시 짝을 맞춘다
        content: listDirectory(block.input.path),
      });
    } catch (err) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: String(err),
        is_error: true, // 에러도 돌려주면 모델이 알아서 다른 방법을 시도한다
      });
    }
  }
  messages.push({ role: "user", content: toolResults });
}

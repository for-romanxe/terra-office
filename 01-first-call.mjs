// 1단계: 모델은 그냥 "텍스트 넣으면 텍스트 나오는 함수"라는 걸 확인
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // ANTHROPIC_API_KEY 환경변수를 자동으로 읽음

const response = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 1024,
  messages: [{ role: "user", content: "안녕! 너 자신을 한 문장으로 소개해줘." }],
});

// 응답은 블록의 배열이라서 text 타입만 골라서 출력
for (const block of response.content) {
  if (block.type === "text") console.log(block.text);
}

console.log("\n--- 사용량 ---");
console.log(`입력 토큰: ${response.usage.input_tokens}, 출력 토큰: ${response.usage.output_tokens}`);

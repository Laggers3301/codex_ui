import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ToolQuestionMessage } from "../src/ToolQuestionCard";
import { parseQuestionTool, parseQuestionToolItem, questionHasLaterUserMessage } from "../src/questionTool";
import { coalesceToolOutputs } from "../src/conversationTimeline";
import "../src/styles.css";

function Harness() {
  const [receipt, setReceipt] = useState(false);
  const [answer, setAnswer] = useState("");
  const [fail, setFail] = useState(false);
  const multiple = new URLSearchParams(location.search).has("multiple");
  const native = new URLSearchParams(location.search).has("native");
  const nativeItems = coalesceToolOutputs([
    { id: "q", type: "functionCall", name: "request_user_input_async", arguments: JSON.stringify({ questions: [{ title: "是否允许独立浏览器验收？", options: ["允许独立浏览器验收", "先保留代码，不上线"] }] }), call_id: "q" },
    { id: "receipt", type: "function_call_output", call_id: "q", output: '{"accepted":true}' },
  ]);
  const questions = native ? parseQuestionToolItem(nativeItems[0])! : parseQuestionTool("request_user_input_async", { questions: multiple
    ? [{ title: "先执行哪一步？", options: ["先测试", "再发布"] }, { title: "请提供验收脚本路径" }]
    : [{ title: "请提供 C300、C301 验收脚本路径" }] })!;
  const items = [{ id: "q", type: "toolCall" }, ...(receipt ? [{ id: "receipt", type: "toolCallOutput", output: '{"accepted":true}' }] : []), ...(answer ? [{ id: "reply", type: "userMessage" }] : [])];
  return <main style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}>
    <button onClick={() => setReceipt(true)}>模拟工具接收回执</button>
    <button onClick={() => setFail(true)}>模拟发送失败</button>
    <ToolQuestionMessage open={!questionHasLaterUserMessage(items, "q")} questions={questions} onChoose={async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (fail) { setFail(false); return false; }
      setAnswer(text); return true;
    }} />
    <p data-testid="answer">{answer}</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);

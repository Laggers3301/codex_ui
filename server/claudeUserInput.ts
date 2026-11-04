import { validateUserInputResponse } from "./userInput.js";

export function claudeQuestions(input: Record<string, unknown>, toolUseId: string) {
  const raw=Array.isArray(input.questions)&&input.questions.length<=4?input.questions:[];
  return raw.map((value,index)=>{
    const row=value&&typeof value==="object"?value as Record<string,unknown>:{};
    return {...row,id:`claude:${toolUseId}:${index}`,question:row.question,
      multiSelect:row.multiSelect===true};
  });
}

/** Keep the native questions/tool arguments immutable. Only validated user
 * answers are added, keyed by the original question text as the SDK expects. */
export function claudeQuestionAnswer(input: Record<string, unknown>, toolUseId: string, result: unknown) {
  const questions=claudeQuestions(input,toolUseId);
  if(!questions.length||questions.some(q=>typeof q.question!=="string"||!q.question.trim())
    ||new Set(questions.map(q=>q.question)).size!==questions.length)throw new Error("Claude 提问格式不完整，未提交答案。");
  const {answers}=validateUserInputResponse({questions},result);
  return {...structuredClone(input),answers:Object.fromEntries(questions.map(q=>[String(q.question),answers[q.id].answers.join(", ")]))};
}

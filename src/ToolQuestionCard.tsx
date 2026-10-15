import { useState } from "react";
import { Send } from "lucide-react";
import { ToolReveal } from "./ToolReveal";
import type { ToolQuestion } from "./questionTool";
import { AccountUpdateIndicator } from "./AccountUpdateIndicator";
import { getApiUserId } from "./api";

export function ToolQuestionCard({ questions, onChoose }: { questions: ToolQuestion[]; onChoose: (answer: string, answers: string[]) => Promise<boolean> }) {
  const [answers, setAnswers] = useState<(string | null)[]>(() => questions.map(() => null));
  const [customAnswers, setCustomAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const selectOption = async (questionIndex: number, option: string) => {
    if (submitting || !option.trim()) return;
    const next = [...answers];
    next[questionIndex] = option;
    setAnswers(next);
    if (next.some((answer) => answer === null)) return;
    setSubmitting(true);
    const reply = questions.length === 1 ? option : questions.map((question, index) => `${question.title}：${next[index]}`).join("\n");
    try {
      if (!await onChoose(reply, next.map(answer => answer!))) setSubmitting(false);
    } catch {
      setSubmitting(false);
    }
  };
  const hasChoices = questions.some((question) => question.options.length > 0);
  return <div className={`toolQuestionCard${submitting ? " submitting" : ""}`} aria-label="向用户提出的问题">
    {questions.map((question, index) => <section className="toolQuestionBlock" key={`${index}:${question.title}`}>
      <div className="toolQuestionHeading"><span className="toolQuestionTag">{question.options.length ? "选择题" : "问题"} {questions.length > 1 ? index + 1 : ""}{index === 0 ? <AccountUpdateIndicator userId={getApiUserId()} menuOpen={answers.some(answer => answer !== null)} target="questions" /> : null}</span><span>{question.title}</span></div>
      <div className="toolQuestionOptions">
        {question.options.map((option, optionIndex) => <button type="button" className={`toolQuestionOption${answers[index] === option ? " selected" : ""}`} key={`${optionIndex}:${option}`} disabled={submitting} aria-pressed={answers[index] === option} onClick={(event) => { event.stopPropagation(); void selectOption(index, option); }} title="选择并发送答案">
          <span className="toolQuestionOptionNumber">{optionIndex + 1}</span><span>{option}</span>
        </button>)}
        <div className="toolQuestionOther">
          <input type="text" value={customAnswers[index] ?? ""}
            onChange={(event) => setCustomAnswers((current) => current.map((value, position) => position === index ? event.target.value : value))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                const answer = customAnswers[index]?.trim();
                if (answer) void selectOption(index, answer);
              }
            }}
            disabled={submitting} spellCheck={false}
            aria-label={`自行输入答案：${question.title}`}
            placeholder={question.options.length ? "其他想法，自行输入…" : "输入你的回答…"} />
          <button type="button" disabled={submitting || !customAnswers[index]?.trim()} onClick={(event) => { event.stopPropagation(); void selectOption(index, customAnswers[index].trim()); }} aria-label="发送自定义答案" title="发送自定义答案"><Send size={15} /></button>
        </div>
      </div>
    </section>)}
    <p className="toolQuestionHint">{submitting ? "正在发送答案…" : questions.length > 1 ? "回答所有问题后发送；也可以在输入框输入自己的回答。" : hasChoices ? "点击选项后自动发送；也可以输入自己的回答。" : "输入回答后按 Enter 或点击发送。"}</p>
  </div>;
}

/** Receipt/completion does not close a question. Only an actual user reply does. */
export function ToolQuestionMessage({ open, questions, onChoose }: { open: boolean; questions: ToolQuestion[]; onChoose: (answer: string, answers: string[]) => Promise<boolean> }) {
  return <ToolReveal open={open} className="toolQuestionPresence">
    <article className="messageItem kind-question">
      <ToolQuestionCard questions={questions} onChoose={onChoose} />
    </article>
  </ToolReveal>;
}

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownComposerEditor } from "../src/App";
import "../src/styles.css";

const emittedValues: string[] = [];

function Harness() {
  const [value, setValue] = useState("前文 `code` 后文 ");
  const [emitted, setEmitted] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(0);
  const [parentRenders, setParentRenders] = useState(0);
  return <main style={{ maxWidth: 900, margin: "40px auto", padding: 16 }}>
    <MarkdownComposerEditor value={value} onChange={next => {
      emittedValues.push(next);
      setEmitted(values => [...values, next]);
      // Delayed parent echoes expose a document replacement during composition.
      window.setTimeout(() => setValue(next), /(?:sh|ch|zh)$/.test(next) ? 10 : 50);
    }} onSubmit={() => setSubmitted(count => count + 1)} placeholder="输入法验收" />
    <button onClick={() => setValue("外部替换后的草稿")}>替换草稿</button>
    <button onClick={() => setValue("")}>清空草稿</button>
    <button data-testid="refresh-parent" onClick={() => setParentRenders(count => count + 1)}>刷新父组件</button>
    <output data-testid="value">{value}</output>
    <output data-testid="emitted">{JSON.stringify(emitted)}</output>
    <output data-testid="submitted">{submitted}</output>
    <output data-testid="parent-renders">{parentRenders}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);

/** Synthetic composition events exercise the document synchronization race.
 * The actual system IME still needs verification on the affected machine. */
async function runComposerImeCases() {
  const input = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
  const editor = (input as HTMLElement & { editor: import("@tiptap/core").Editor }).editor;
  const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
  const emitted = () => emittedValues.slice();
  const results: Array<Record<string, unknown>> = [];
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const prepare = async (markdown: string) => {
    editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: true });
    editor.commands.focus("end");
    await wait(100);
  };
  const compose = () => {
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    const selection = document.getSelection()!;
    let node = selection.anchorNode!;
    let offset = selection.anchorOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      const container = input.contains(node) ? node : input.querySelector("p")!;
      const next = container.childNodes[offset] ?? null;
      node = document.createTextNode("");
      container.insertBefore(node, next);
      offset = 0;
    }
    const before = node.nodeValue!.slice(0, offset);
    const after = node.nodeValue!.slice(offset);
    return (text: string, caretAtStart = false) => {
      input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
      input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertCompositionText", isComposing: true, data: text }));
      node.nodeValue = before + text + after;
      selection.collapse(node, before.length + (caretAtStart ? 0 : text.length));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data: text }));
    };
  };
  for (const prefix of ["", "前文 `code` 后文", "前文 [链接](https://example.com) 后文"]) {
    for (const initial of ["sh", "ch", "zh"]) {
      await prepare(prefix);
      const startEmitted = emitted().length;
      let replacements = 0;
      const onTransaction = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
        if (transaction.docChanged && transaction.getMeta("preventUpdate") === true) replacements++;
      };
      editor.on("transaction", onTransaction);
      const write = compose();
      write(initial);
      await wait(0);
      write("中");
      await wait(80);
      check(replacements === 0, "Composition must not replace the document: " + prefix + initial);
      check(emitted().length === startEmitted, "Preedit text must not be echoed into controlled props");
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
      const beforeSubmit = document.querySelector('[data-testid="submitted"]')!.textContent;
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", keyCode: 13, isComposing: false }));
      await wait(100);
      check(document.querySelector('[data-testid="submitted"]')!.textContent === beforeSubmit, "IME confirmation must not send the prompt");
      check(editor.getMarkdown() === prefix + "中", "Committed text/caret must remain at the input position");
      check(editor.state.selection.from === editor.state.doc.content.size - 1, "Caret must remain after committed text");
      check(emitted().slice(startEmitted).length === 1, "Commit must publish once");
      if (prefix.includes("`")) check(input.querySelector("code")?.textContent === "code", "Inline code must stay intact");
      if (prefix.includes("https:")) check(input.querySelector("a")?.textContent === "链接", "Link must stay intact");
      editor.off("transaction", onTransaction);
      results.push({ prefix: prefix || "plain", initial, replacements, committedOnce: true, caretPreserved: true });
    }
  }
  const refreshParent = document.querySelector<HTMLButtonElement>('[data-testid="refresh-parent"]')!;
  for (const { format, markdown } of [
    { format: "plain", markdown: "甲乙后文" },
    { format: "code", markdown: "前文 `code` 甲乙后文" },
    { format: "link", markdown: "前文 [链接](https://example.com) 甲乙后文" },
  ]) {
    for (const placement of ["middle", "end"]) {
      for (const caretAtStart of [false, true]) {
        const label = `${format}/${placement}/${caretAtStart ? "preedit-start" : "preedit-end"}`;
        await prepare(markdown);
        let insertionPosition = editor.state.doc.content.size - 1;
        if (placement === "middle") {
          editor.state.doc.descendants((node, position) => {
            const offset = node.text?.indexOf("后文") ?? -1;
            if (node.isText && offset >= 0) insertionPosition = position + offset;
          });
        }
        editor.commands.setTextSelection(insertionPosition);
        await wait(0);
        const startEmitted = emitted().length;
        const startRenders = Number(document.querySelector('[data-testid="parent-renders"]')!.textContent);
        let replacements = 0;
        const onTransaction = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
          if (transaction.docChanged && transaction.getMeta("preventUpdate") === true) replacements++;
        };
        editor.on("transaction", onTransaction);
        const write = compose();
        const checkPending = (caretStart: number, caretEnd = caretStart) => {
          check(replacements === 0, "A slow composition must not replace the document: " + label);
          check(emitted().length === startEmitted, "A slow preedit must not reach controlled props: " + label);
          const selection = document.getSelection();
          const domCaret = selection?.isCollapsed && selection.anchorNode && input.contains(selection.anchorNode)
            ? editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset) : -1;
          const caret = editor.state.selection;
          check(caret.empty && caret.from >= caretStart && caret.from <= caretEnd && domCaret >= caretStart && domCaret <= caretEnd, "A parent render must keep the pending IME caret within the composing text: " + label + JSON.stringify({ expected: [caretStart, caretEnd], model: caret.toJSON(), domCaret }));
          check(document.activeElement === input, "A slow composition must keep editor focus: " + label);
        };
        // No preedit text arrives for over a second while unrelated UI updates.
        // Programmatic clicks avoid moving focus away from the editor.
        for (let tick = 0; tick < 4; tick++) {
          refreshParent.click();
          await wait(275);
          checkPending(insertionPosition);
        }
        write("sh", caretAtStart);
        refreshParent.click();
        await wait(200);
        // ProseMirror normalizes Chrome's preedit caret to the end. Both the
        // model and visible caret must stay inside the active preedit span.
        checkPending(insertionPosition + (caretAtStart ? 0 : 2), insertionPosition + 2);
        write("中", caretAtStart);
        refreshParent.click();
        await wait(200);
        checkPending(insertionPosition + (caretAtStart ? 0 : 1), insertionPosition + 1);
        // A native IME places the committed caret after the selected candidate.
        write("中");
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
        const beforeSubmit = document.querySelector('[data-testid="submitted"]')!.textContent;
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", keyCode: 13, isComposing: false }));
        await wait(100);
        const expected = placement === "end" ? markdown + "中" : markdown.replace("甲乙后文", "甲乙中后文");
        check(editor.getMarkdown() === expected, "A slow commit must preserve surrounding text and formatting: " + label);
        check(editor.state.selection.from === insertionPosition + 1, "A slow commit must keep the caret at the insertion position: " + label);
        check(emitted().length === startEmitted + 1, "A slow commit must publish once: " + label);
        check(document.querySelector('[data-testid="submitted"]')!.textContent === beforeSubmit, "Confirming a slow IME candidate must not submit: " + label);
        const parentRenders = Number(document.querySelector('[data-testid="parent-renders"]')!.textContent) - startRenders;
        check(parentRenders === 6, "The slow IME case must exercise parent renders: " + label);
        editor.off("transaction", onTransaction);
        results.push({ scenario: "slowComposition", format, placement, preeditCaret: caretAtStart ? "start" : "end", firstPreeditDelayMs: 1100, parentRenders, committedOnce: true, caretPreserved: true });
      }
    }
  }
  await prepare("`code`");
  const position = editor.state.doc.content.size - 1;
  const handler = editor.options.editorProps.handleTextInput!;
  for (const initial of ["sh", "ch", "zh"]) {
    const before = editor.state.doc;
    const handled = handler.call(editor.view, editor.view, position, position, initial, () => editor.state.tr.insertText(initial));
    check(handled === false && editor.state.doc.eq(before), "Multicharacter input must use native handling");
  }
  const spaceHandled = handler.call(editor.view, editor.view, position, position, " ", () => editor.state.tr.insertText(" "));
  check(spaceHandled === true, "Ordinary space must still exit an inline mark");
  check(editor.state.doc.lastChild!.lastChild!.marks.length === 0, "Text after inline code must be unformatted");
  await wait(100);
  await prepare("等待输入");
  const write = compose();
  write("sh");
  await wait(0);
  [...document.querySelectorAll("button")].find(button => button.textContent === "替换草稿")!.click();
  await wait(30);
  check(editor.getMarkdown().includes("sh"), "An external replacement must wait for composition to finish");
  write("中");
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
  await wait(100);
  check(editor.getMarkdown() === "外部替换后的草稿", "A queued external draft replacement must survive the commit");
  results.push({ ordinaryFormattingPreserved: true, externalReplacementDeferred: true });
  await prepare("及时同步");
  const beforeCommit = emitted().length;
  const commit = compose();
  commit("sh");
  await wait(0);
  commit("中");
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
  await Promise.resolve();
  check(emitted().slice(beforeCommit).join("") === "及时同步中", "The final input must reach the parent before the next click can send it");
  await wait(100);
  check(emitted().length === beforeCommit + 1, "The completion frame must not publish twice");
  results.push({ finalMutationFlushed: true, committedBeforeNextClick: true });
  return { userAgent: navigator.userAgent, results };
}
Object.assign(window, { runComposerImeCases });

// @vitest-environment jsdom
import { expect, it } from "vitest";
import { isToolSummaryClick, recordToolDisclosurePointerDown } from "./toolDisclosure";
it("only toggles the card's own summary, not output, nested tools or actionable controls", () => {
  document.body.innerHTML = '<article id="card"><div class="messageMeta"><span>exec</span><button>copy</button></div><pre>select this output</pre><article><div class="messageMeta">nested</div></article></article>';
  const card = document.getElementById("card")!;
  expect(isToolSummaryClick(card.querySelector("span"), card)).toBe(true);
  expect(isToolSummaryClick(card.querySelector("pre"), card)).toBe(false);
  expect(isToolSummaryClick(card.querySelector("button"), card)).toBe(false);
  expect(isToolSummaryClick(card.querySelector(":scope > article > .messageMeta"), card)).toBe(false);
  const range = document.createRange(); range.selectNodeContents(card.querySelector("pre")!);
  window.getSelection()!.addRange(range);
  expect(isToolSummaryClick(card.querySelector("span"), card)).toBe(true);
  expect(isToolSummaryClick(card.querySelector("pre"), card)).toBe(false);
  window.getSelection()!.removeAllRanges();
  range.selectNodeContents(card.querySelector("span")!);
  window.getSelection()!.addRange(range);
  expect(isToolSummaryClick(card.querySelector("span"), card)).toBe(true);
  recordToolDisclosurePointerDown(card, { clientX: 5, clientY: 5 });
  expect(isToolSummaryClick(card.querySelector("span"), card, { clientX: 50, clientY: 5 })).toBe(false);
  recordToolDisclosurePointerDown(card, { clientX: 5, clientY: 5 });
  expect(isToolSummaryClick(card.querySelector("span"), card, { clientX: 5, clientY: 5 })).toBe(true);
  window.getSelection()!.removeAllRanges();
  expect(isToolSummaryClick(card, card)).toBe(true);
  card.classList.add("toolExpanded");
  expect(isToolSummaryClick(card, card, { clientY: 3 })).toBe(true);
  expect(isToolSummaryClick(card, card, { clientY: 200 })).toBe(false);
});

// @vitest-environment jsdom
import {expect,it,vi} from "vitest";
import {measureCommittedConversationRows} from "./committedConversationMeasurements";
it("measures only mounted direct virtual rows with actual positive heights",()=>{
 const root=document.createElement("div");root.innerHTML='<div class="virtualConversationSizer"><div class="virtualConversationRow" data-index="7"><p>new older row</p></div><div class="virtualConversationRow" data-index="8"></div><div class="virtualConversationRow" data-index="invalid"></div><div class="virtualConversationRow"></div></div><div class="virtualConversationFlowRow" data-index="0"></div>';
 for(const [i,row] of [...root.querySelectorAll<HTMLElement>('.virtualConversationRow')].entries())Object.defineProperty(row,'offsetHeight',{value:i===1?0:900});
 const resize=vi.fn();measureCommittedConversationRows(root,resize);expect(resize.mock.calls).toEqual([[7,900]]);
});

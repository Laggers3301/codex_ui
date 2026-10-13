import {describe,it,expect} from "vitest";
import {archivedOutputPreview,toolArchiveRoot,toolArchivePath} from "./toolOutputArchive.js";
const make=(output:unknown)=>({timestamp:"2026-10-01T00:00:00Z",type:"response_item",payload:{type:"custom_tool_call_output",id:"item",call_id:"call",internal_chat_message_metadata_passthrough:{turn_id:"old",opaque:"unchanged"},output}});
describe("tool archive preview",()=>{
 it("preserves small results",()=>expect(archivedOutputPreview(make("small"),"/private/result.gz")).toBeNull());
 it("keeps exact identity metadata and text head/tail",()=>{
  const row=make(`HEAD🙂${"x".repeat(200000)}TAIL结束`),next=archivedOutputPreview(row,"/private/result.gz")!;
  expect(next.payload.call_id).toBe("call");expect(next.payload.id).toBe("item");expect(next.payload.internal_chat_message_metadata_passthrough).toBe(row.payload.internal_chat_message_metadata_passthrough);
  expect(next.payload.output).toContain("HEAD🙂");expect(next.payload.output).toContain("TAIL结束");expect(next.payload.output).toContain("call_id=call");expect(next.payload.output.length).toBeLessThan(40000);
  expect(row.payload.output).toContain("x".repeat(200000));
 });
 it("keeps encrypted blocks and unknown blocks verbatim, archives large tool images",()=>{
  const encrypted={type:"encrypted_content",encrypted_content:"opaque"},unknown={type:"future_type",data:"keep"};
  const row=make([{type:"input_text",text:`START${"x".repeat(200000)}END`},encrypted,unknown,{type:"input_image",image_url:`data:image/png;base64,${"a".repeat(200000)}`}]);
  const next=archivedOutputPreview(row,"/private/result.gz")!;
  expect(next.payload.output).toContain(encrypted);expect(next.payload.output).toContain(unknown);
  expect(next.payload.output.some((b:any)=>b.type==="input_image")).toBe(false);
  expect(next.payload.output.some((b:any)=>b.text?.includes("工具图片"))).toBe(true);
 });
 it("does not claim reduction for an opaque-only large result",()=>expect(archivedOutputPreview(make([{type:"encrypted_content",encrypted_content:"z".repeat(200000)}]),"/private/result.gz")).toBeNull());
 it("isolates user archive paths and rejects path traversal",()=>{
  expect(toolArchiveRoot("/data","alice")).not.toBe(toolArchiveRoot("/data","bob"));
  expect(()=>toolArchivePath("/data","../private")).toThrow();
 });
});

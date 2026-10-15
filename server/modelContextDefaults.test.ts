import{it,expect}from"vitest";
import{applyPoolContextDefaults}from"./modelContextDefaults.js";
it("raises only Sol defaults and preserves capability/compaction metadata",()=>{
 const model={slug:"gpt-6.1-sol",context_window:272000,max_context_window:872000,effective_context_window_percent:95};
 const other={slug:"gpt-6-sol",context_window:272000};const catalog={models:[model,other]};
 applyPoolContextDefaults(catalog);expect(model).toEqual({...model,context_window:500000});expect(other.context_window).toBe(272000);
 model.context_window=600000;applyPoolContextDefaults(catalog);expect(model.context_window).toBe(600000);
});
it("rejects a catalog that cannot support the authorized default",()=>{
 expect(()=>applyPoolContextDefaults({models:[{slug:"gpt-6.1-sol",context_window:128000,max_context_window:128000}]})).toThrow();
});

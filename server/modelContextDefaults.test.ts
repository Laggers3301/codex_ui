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
it("raises supported Astra as well, without changing compaction or the maximum",()=>{
 const astra={slug:"gpt-6-astra",context_window:272000,max_context_window:872000,effective_context_window_percent:95,auto_compact_token_limit:240000};
 applyPoolContextDefaults({models:[astra]});
 expect(astra).toEqual({...astra,context_window:500000});
 expect(astra.auto_compact_token_limit).toBe(240000);
 expect(astra.max_context_window).toBe(872000);
});
it("does not assume Astra support when no sufficient maximum is advertised",()=>{
 const astra={slug:"gpt-6-astra",context_window:272000};
 expect(()=>applyPoolContextDefaults({models:[astra]})).toThrow();
 expect(astra.context_window).toBe(272000);
});
it("validates all models before mutating any",()=>{
 const sol={slug:"gpt-6.1-sol",context_window:272000,max_context_window:872000};
 const astra={slug:"gpt-6-astra",context_window:272000,max_context_window:300000};
 expect(()=>applyPoolContextDefaults({models:[sol,astra]})).toThrow();
 expect(sol.context_window).toBe(272000);
 expect(astra.context_window).toBe(272000);
});
it("preserves larger windows and unrelated Astra variants",()=>{
 const astra={slug:"gpt-6-astra",context_window:600000,max_context_window:872000};
 const other={slug:"gpt-6-astra-ultrafast",context_window:272000,max_context_window:872000};
 applyPoolContextDefaults({models:[astra,other]});
 expect(astra.context_window).toBe(600000);
 expect(other.context_window).toBe(272000);
});
it.each([NaN,Infinity,0,-1])("rejects invalid advertised maxima %s",maximum=>{
 expect(()=>applyPoolContextDefaults({models:[{slug:"gpt-6-astra",context_window:272000,max_context_window:maximum}]})).toThrow();
});

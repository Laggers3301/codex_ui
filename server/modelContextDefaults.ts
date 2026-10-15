/** Keep the pool's authorized Sol default during staggered upstream rollouts.
 * Explicit per-thread context settings and other models are unaffected. */
export function applyPoolContextDefaults(catalog: {models?:unknown[]}) {
  for(const entry of catalog.models??[]){
    if(!entry||typeof entry!=="object")continue;
    const model=entry as Record<string,unknown>;
    if(model.slug!=="gpt-6.1-sol")continue;
    const current=Number(model.context_window);
    const maximum=Number(model.max_context_window??500000);
    if(!Number.isFinite(current)||maximum<500000)throw new Error("GPT-6.1 Sol 模型目录不支持 500k 上下文，已保留当前目录。");
    if(current<500000)model.context_window=500000;
  }
}

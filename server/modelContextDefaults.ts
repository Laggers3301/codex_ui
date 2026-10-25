/** Keep the pool's authorized Sol/Astra defaults during staggered upstream rollouts.
 * Explicit per-thread context settings and other models are unaffected. */
export function applyPoolContextDefaults(catalog: {models?:unknown[]}) {
  const updates: Record<string, unknown>[] = [];
  for(const entry of catalog.models??[]){
    if(!entry||typeof entry!=="object")continue;
    const model=entry as Record<string,unknown>;
    if(model.slug!=="gpt-6.1-sol" && model.slug!=="gpt-6-astra")continue;
    const current=Number(model.context_window);
    // Sol keeps its previously authorized fallback. Astra must explicitly
    // advertise a sufficiently large maximum; never invent account support.
    const maximum=Number(model.max_context_window??(model.slug==="gpt-6.1-sol"?500000:current));
    if(!Number.isFinite(current)||!Number.isFinite(maximum)||current<=0||maximum<500000) {
      throw new Error(`${model.slug} 模型目录不支持 500k 上下文，已保留当前目录。`);
    }
    if(current<500000)updates.push(model);
  }
  // Validate every target before changing any: one unsupported model must not
  // leave a partially transformed catalog behind.
  for(const model of updates)model.context_window=500000;
}

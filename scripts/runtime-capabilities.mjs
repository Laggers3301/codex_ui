/** Detect protocol deltas, not marketing claims. Unknown capabilities are
 * reported for review, never used to auto-rewrite production source. */
export const validationRevision=2;
export function inspectCapabilities(version, protocol, featuresText, previous={}) {
  const methods=[...new Set([...protocol.matchAll(/"method":\s*"([^\"]+)"/g)].map(m=>m[1]))].sort();
  const old=new Set(previous.methods??[]), now=new Set(methods);
  const features=featuresText.trim().split('\n').filter(Boolean).map(line=>{
    const match=line.match(/^(\S+)\s+(.+?)\s+(true|false)$/);
    return match?{name:match[1],stage:match[2].trim(),enabled:match[3]==='true'}:null;
  }).filter(Boolean);
  return {version,validationRevision,checkedAt:new Date().toISOString(),methods,features,
    addedMethods:previous.methods?methods.filter(x=>!old.has(x)):[],
    removedMethods:(previous.methods??[]).filter(x=>!now.has(x)),
    storage:{nativeCompression:now.has('rollout/compress'),adaptation:'requires_history_search_fork_rollback_tests'},
    autoRewriteProductionCode:false};
}

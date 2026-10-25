// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderQuotaDetails, providerRemaining } from "./providerQuota";
import { providerQuotaRestriction } from "../shared/providerQuota";
import { modelErrorDetails, modelErrorSummary } from "../shared/modelError";
import { classifyProviderFailure, providerFailureCopy } from "./providerFailure";
import type { ProviderQuotaView } from "../shared/providerQuota";

const item: ProviderQuotaView = {id:"ark",name:"Ark",status:"ready",stale:false,message:null,updatedAt:"2026-10-25T07:00:00Z",periods:[
  {label:"session",usedPercent:0,resetsAt:"2026-10-25T20:13:47+08:00"},
  {label:"weekly",usedPercent:100,resetsAt:"2026-10-26T00:00:00+08:00"},
]};
it("uses the limiting active window without falsifying individual percentages",()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-25T07:20:00Z"));
  try {
    expect(providerRemaining(item)).toBe("0%");expect(item.periods[0].usedPercent).toBe(0);
    expect(providerQuotaRestriction(item)).toContain("每周额度已耗尽");
    expect(providerQuotaRestriction(item)).toContain("2026/10/26 00:00");
    const html=renderToStaticMarkup(<ProviderQuotaDetails item={item} formatPeriod={p=>`${100-p.usedPercent}%`}/>);
    expect(html).toContain("100%");expect(html).toContain("0%");expect(html).toContain("当前不可用");
    expect(providerRemaining({...item,periods:[{label:"session",usedPercent:10,resetsAt:null},{label:"weekly",usedPercent:60,resetsAt:null}]})).toBe("40%");
    vi.setSystemTime(new Date("2026-10-26T00:01:00+08:00"));
    expect(providerQuotaRestriction(item)).toBeNull();expect(providerRemaining(item)).toBe("--");
  } finally {vi.useRealTimers();}
});
it("extracts quota type and exact reset time from JSON encoded upstream errors",()=>{
  const raw={message:JSON.stringify({error:{code:"AccountQuotaExceeded",message:"You have exceeded the weekly usage quota. It will reset at 2026-10-26 00:00:00 +0800 CST. Request id: example-123"}}),httpStatusCode:429};
  expect(modelErrorDetails(raw).signature).toContain("AccountQuotaExceeded");
  const copy=providerFailureCopy(classifyProviderFailure("kimi-k3",raw)!);
  expect(copy.message).toContain("每周额度已耗尽");expect(copy.message).toContain("2026-10-26 00:00:00 +0800");
  expect(copy.message).not.toContain("example-123");
});
it("puts specific non-quota causes in the banner while redacting secrets",()=>{
  const raw={httpStatusCode:400,message:'Unsupported image format; Bearer supersecret https://example.test/?token=abc123&code=xyz789'};
  const message=providerFailureCopy(classifyProviderFailure("kimi-k3",raw)!).message;
  expect(message).toContain("Unsupported image format");expect(message).not.toMatch(/supersecret|abc123|xyz789/);
  expect(modelErrorSummary({message:"ModelNotFound: requested model is unavailable"})).toContain("ModelNotFound");
});

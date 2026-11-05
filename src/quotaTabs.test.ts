import { expect, it } from "vitest";
import { visibleProviderQuotas } from "./quotaTabs";
import type { ProviderQuotaView } from "../shared/providerQuota";

it("hides only the MiMo quota tab and puts Ark first without mutating model or source data", () => {
  const items = ["mimo", "other", "ark"].map(id => ({ id, name: id }) as ProviderQuotaView);
  expect(visibleProviderQuotas(items).map(item => item.id)).toEqual(["ark", "other"]);
  expect(items.map(item => item.id)).toEqual(["mimo", "other", "ark"]);
});

// @vitest-environment jsdom
import { expect, it } from "vitest";
import { shouldDismissMobileSidebar } from "./mobileSidebarActions";

it("dismisses explicit external actions, not local management or disabled controls", () => {
  const sidebar = document.createElement("nav");
  sidebar.innerHTML = '<button data-mobile-sidebar-dismiss="true"><svg><path /></svg></button><button class="projectRenameButton"></button><button class="projectDeleteButton confirm"></button><button class="threadDeleteButton confirm"></button><button class="v2SidebarSearchButton" data-mobile-sidebar-dismiss="true" disabled></button><button class="refresh"></button><input />';
  expect(shouldDismissMobileSidebar(sidebar.querySelector("path"), sidebar)).toBe(true);
  for (const target of sidebar.querySelectorAll('.projectRenameButton,.projectDeleteButton,.threadDeleteButton,.refresh,input,:disabled')) expect(shouldDismissMobileSidebar(target, sidebar)).toBe(false);
  const outside = document.createElement("button"); outside.dataset.mobileSidebarDismiss = "true";
  expect(shouldDismissMobileSidebar(outside, sidebar)).toBe(false);
  expect(shouldDismissMobileSidebar(null, sidebar)).toBe(false);
  const first = sidebar.querySelector("button")!; first.setAttribute("aria-disabled", "true");
  expect(shouldDismissMobileSidebar(first, sidebar)).toBe(false);
});

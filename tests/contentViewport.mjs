import { expect } from "@playwright/test";

const desktopSidebarOpen = new WeakMap();

/** The mobile conversation list is now a modal drawer. Dismiss it through
 * its real control before testing the transcript/right pane, and restore
 * the desktop sidebar when returning to a larger viewport. */
export async function setContentViewport(page, viewport) {
  const sidebar = page.locator("#conversation-sidebar");
  if (viewport.width <= 720 && !desktopSidebarOpen.has(page)) {
    desktopSidebarOpen.set(page, !(await sidebar.getAttribute("class"))?.split(/\s+/).includes("collapsed"));
  }
  await page.setViewportSize(viewport);
  if (viewport.width <= 720) {
    if (!(await sidebar.getAttribute("class"))?.split(/\s+/).includes("collapsed")) {
      await sidebar.locator(".v2SidebarToggle").click();
      await expect(sidebar).toHaveClass(/\bcollapsed\b/);
    }
  } else if (desktopSidebarOpen.has(page)) {
    if (desktopSidebarOpen.get(page) && (await sidebar.getAttribute("class"))?.split(/\s+/).includes("collapsed")) {
      await sidebar.locator(".v2SidebarToggle").click();
      await expect(sidebar).not.toHaveClass(/\bcollapsed\b/);
    }
    desktopSidebarOpen.delete(page);
  }
}

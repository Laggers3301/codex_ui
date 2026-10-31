/** Only explicitly external actions dismiss the mobile drawer. Local list
 * management (rename, pin, refresh, delete/confirm, folders) is opt-out by default. */
export function shouldDismissMobileSidebar(target: EventTarget | null, sidebar: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const action = target.closest('[data-mobile-sidebar-dismiss="true"]');
  return Boolean(action && sidebar.contains(action) && !action.matches(":disabled,[aria-disabled=true]"));
}

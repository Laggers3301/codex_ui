import { useMobileLayer } from "./MobileLayerProvider";

/** Adapt the existing navigation state; no independent mobile account/session store. */
export function MobileNavigationLayers({ sidebar, workspace, image, onSidebarClose, onWorkspaceClose, onImageClose }: {
  sidebar: boolean; workspace: boolean; image: boolean;
  onSidebarClose: () => void; onWorkspaceClose: () => void; onImageClose: () => void;
}) {
  useMobileLayer(sidebar, onSidebarClose);
  useMobileLayer(workspace, onWorkspaceClose);
  useMobileLayer(image, onImageClose);
  return null;
}

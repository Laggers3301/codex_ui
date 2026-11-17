import { useMobileLayer } from "./MobileLayerProvider";
/** Existing forms keep their business logic, with the phone back contract. */
export function MobileLegacyLayer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useMobileLayer(open, onClose);
  return null;
}

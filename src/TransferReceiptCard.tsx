import { useEffect, useRef, useState, type ReactNode } from "react";
import { transferReceiptPhase, TRANSFER_RECEIPT_EXIT_MS } from "./transferReceipt";
import "./transferReceipt.css";

/** A transient UI receipt only; never deletes model history or retries a transfer. */
export function TransferReceipt({ expiresAt, onExpired, children }: { expiresAt: number; onExpired: () => void; children: ReactNode }) {
  const [phase, setPhase] = useState(() => transferReceiptPhase(expiresAt, Date.now()));
  const expire = useRef(onExpired);
  expire.current = onExpired;
  useEffect(() => {
    const update = () => {
      const next = transferReceiptPhase(expiresAt, Date.now());
      setPhase(next);
      if (next === "expired") expire.current();
    };
    update();
    const closeTimer = window.setTimeout(update, Math.max(0, expiresAt - Date.now()));
    const removeTimer = window.setTimeout(update, Math.max(0, expiresAt + TRANSFER_RECEIPT_EXIT_MS - Date.now()));
    // Browser timers may be throttled in the background. Reconcile before an
    // old receipt can reappear when the user returns to the conversation.
    document.addEventListener("visibilitychange", update);
    return () => { clearTimeout(closeTimer); clearTimeout(removeTimer); document.removeEventListener("visibilitychange", update); };
  }, [expiresAt]);
  if (phase === "expired") return null;
  return <div className={`transientTransferReceipt${phase === "closing" ? " closing" : ""}`} aria-hidden={phase === "closing" ? true : undefined} inert={phase === "closing"}>
    <div className="transientTransferReceiptInner">{children}</div>
  </div>;
}

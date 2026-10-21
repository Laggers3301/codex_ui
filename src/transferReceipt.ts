export const TRANSFER_RECEIPT_HOLD_MS = 6000;
export const TRANSFER_RECEIPT_EXIT_MS = 400;

/** Only confirmed SSH-success receipts expire. Errors and exports stay readable. */
export function isSuccessfulTransferReceipt(meta: string, text: string): boolean {
  return (meta === "Codex Web · file transfer" && /^已通过 SSH 发送到当前(?:访问)?设备：/.test(text))
    || (meta === "Codex Web · 自动发送" && /^已自动通过 SSH 发送生成文件：/.test(text));
}

export function transferReceiptPhase(expiresAt: number, now: number): "visible" | "closing" | "expired" {
  if (now >= expiresAt + TRANSFER_RECEIPT_EXIT_MS) return "expired";
  return now >= expiresAt ? "closing" : "visible";
}

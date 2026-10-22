import { expect, it } from "vitest";
import { isSuccessfulTransferReceipt, transferReceiptPhase, TRANSFER_RECEIPT_HOLD_MS, TRANSFER_RECEIPT_EXIT_MS } from "./transferReceipt";

it("expires only confirmed manual and automatic SSH sends, not failed sends or exports", () => {
  expect(isSuccessfulTransferReceipt("Codex Web · file transfer", "已通过 SSH 发送到当前访问设备：\n- file.md")).toBe(true);
  expect(isSuccessfulTransferReceipt("Codex Web · file transfer", "已通过 SSH 发送到当前设备：\n- file.pdf")).toBe(true);
  expect(isSuccessfulTransferReceipt("Codex Web · 自动发送", "已自动通过 SSH 发送生成文件：\n- file.md")).toBe(true);
  expect(isSuccessfulTransferReceipt("Codex Web · 自动发送", "自动发送 file.md 失败：连接超时")).toBe(false);
  expect(isSuccessfulTransferReceipt("Codex Web · export", "对话记录已导出：\n- 已发送到当前访问设备：file.md")).toBe(false);
  expect(isSuccessfulTransferReceipt("Codex Web · system", "已通过 SSH 发送到当前设备：")).toBe(false);
});

it("holds for six seconds, then exits once, and never revives after expiry", () => {
  const start = 10000, expiresAt = start + TRANSFER_RECEIPT_HOLD_MS;
  expect(transferReceiptPhase(expiresAt, start)).toBe("visible");
  expect(transferReceiptPhase(expiresAt, expiresAt - 1)).toBe("visible");
  expect(transferReceiptPhase(expiresAt, expiresAt)).toBe("closing");
  expect(transferReceiptPhase(expiresAt, expiresAt + TRANSFER_RECEIPT_EXIT_MS)).toBe("expired");
  expect(transferReceiptPhase(expiresAt, expiresAt + 60000)).toBe("expired");
});

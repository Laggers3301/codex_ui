const legacyBranchPinPrefixes = [
  "【原会话最初目标】",
  "【用户固定上下文】\n【原会话最初目标】"
];

/** Old branch code stored its generated summary in the user-editable pin. */
export function isLegacyGeneratedBranchPin(text: string): boolean {
  const clean = text.trim();
  return legacyBranchPinPrefixes.some((prefix) => clean.startsWith(prefix));
}

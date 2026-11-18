/** Protocol-injected user envelopes are not messages authored by the user. */
export function isInternalRuntimeUserText(value: string): boolean {
  const text = value.trimStart();
  return text.startsWith('<environment_context>')
    || text.startsWith('<codex_internal_context_recovery>')
    || text.startsWith('<codex_internal_continuation_recovery>')
    || text.startsWith('<codex_internal_retry>')
    || text.startsWith('<recommended_plugins>')
    || text.startsWith('<permissions instructions>')
    || text.startsWith('<app-context>')
    || text.startsWith('<codex_document_context>')
    || /^# AGENTS\.md instructions(?:\r?\n|$)/.test(text)
    || /^# AGENTS\.md instructions for [^\r\n]+\r?\n\s*<INSTRUCTIONS>/.test(text)
    || /^<skill>\s*<name>[^<]+<\/name>\s*<path>[^<]+SKILL\.md<\/path>/.test(text);
}

import { expect, it } from 'vitest';
import { isInternalRuntimeUserText } from './runtimeUserMessages';

it('identifies native child instruction and environment envelopes, including workspace-specific headers', () => {
  expect(isInternalRuntimeUserText('# AGENTS.md instructions for /workspace/qa\n\n<INSTRUCTIONS>\ninternal rules\n</INSTRUCTIONS>\n<environment_context>\npermissions\n</environment_context>')).toBe(true);
  expect(isInternalRuntimeUserText('  <environment_context>\ninternal runtime values\n</environment_context>')).toBe(true);
  expect(isInternalRuntimeUserText('# AGENTS.md instructions\nlegacy wrapper')).toBe(true);
});

it('preserves ordinary child tasks and questions about instruction documents or environment tags', () => {
  for (const text of ['读取 fixture.txt 并返回实际结果。', '请解释 <environment_context> 的作用。', '# AGENTS.md instructions for an example\n请帮我编辑这篇说明。']) {
    expect(isInternalRuntimeUserText(text)).toBe(false);
  }
});

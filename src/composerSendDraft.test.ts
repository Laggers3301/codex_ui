import {expect,it} from 'vitest';
import {restoreSubmittedText} from './composerSendDraft';
it('restores a rejected draft without duplicating it or losing new typing',()=>{
  expect(restoreSubmittedText('', 'old')).toBe('old');
  expect(restoreSubmittedText('old', 'old')).toBe('old');
  expect(restoreSubmittedText('new', 'old')).toBe('old\n\nnew');
  expect(restoreSubmittedText('new', '')).toBe('new');
});

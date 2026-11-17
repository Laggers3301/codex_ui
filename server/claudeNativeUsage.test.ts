import {describe,it,expect} from 'vitest';
import {parseNativeClaudeUsage} from './claudeNativeUsage.js';
const now=Date.parse('2026-11-10T09:20:00Z');
const text='You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 8% used · resets Nov 10, 9pm (Asia/Singapore)\nCurrent week (all models): 69% used · resets Nov 11, 10am (Asia/Singapore)\nCurrent week (Fable): 0% used · resets Nov 11, 10am (Asia/Singapore)';
describe('native /usage observations',()=>{
 it('reads percentages directly and uses the displayed timezone, not the server timezone',()=>{
  expect(parseNativeClaudeUsage(text,now)).toEqual([
   {kind:'five_hour',percent:8,resetsAt:Date.parse('2026-11-10T13:00:00Z'),observedAt:now,source:'native-command'},
   {kind:'seven_day',percent:69,resetsAt:Date.parse('2026-11-11T02:00:00Z'),observedAt:now,source:'native-command'},
   {kind:'seven_day_fable',percent:0,resetsAt:Date.parse('2026-11-11T02:00:00Z'),observedAt:now,source:'native-command'}
  ]);
 });
 it('handles year rollover and noon/midnight',()=>{
  const at=Date.parse('2026-12-31T12:00:00Z');
  expect(parseNativeClaudeUsage('Current session: 5% used · resets Jan 1, 12am (Asia/Singapore)',at)[0].resetsAt).toBe(Date.parse('2026-12-31T16:00:00Z'));
  expect(parseNativeClaudeUsage('Current week (all models): 5% used · resets Jan 1, 12:30pm (Asia/Singapore)',at)[0].resetsAt).toBe(Date.parse('2027-01-01T04:30:00Z'));
 });
 it('does not invent resets from invalid dates, timezones or old/past dates',()=>{
  for(const reset of ['unknown','Nov 11, 10am (Bad/Zone)','Nov 1, 9pm (Asia/Singapore)','Feb 31, 9pm (Asia/Singapore)'])expect(parseNativeClaudeUsage(`Current session: 8% used · resets ${reset}`,now)[0].resetsAt).toBeNull();
  expect(parseNativeClaudeUsage('Current week (all models): 101% used',now)).toEqual([]);
  expect(parseNativeClaudeUsage('unavailable',now)).toEqual([]);
 });
});

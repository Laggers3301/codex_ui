import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {LeaderboardPanel,leaderboardPersonName,leaderboardPercent} from './LeaderboardPanel';
import type {CodexLeaderboard} from './types';
describe('public leaderboard',()=>{
  it('supports deployment-provided names without publishing a personal roster',()=>{
    expect(leaderboardPersonName({userId:'example',displayName:'Example user'})).toBe('Example user');
    expect(leaderboardPersonName({userId:'unknown'})).toBe('待核实（unknown）');
  });
  it('keeps model and token details collapsed in both boards',()=>{
    const board={currentCycle:{users:[{userId:'example',displayName:'Example user',totalTokens:123456,poolQuotaPercent:3.25,models:[{model:'example-model'}]}]},lifetime:{users:[]}} as unknown as CodexLeaderboard;
    const html=renderToStaticMarkup(<LeaderboardPanel leaderboard={board}/>);
    expect(html).toContain('Example user');expect(html).toContain('3.25%');expect(html).not.toContain('123456');expect(html).not.toContain('example-model');
    expect(html).toContain('data-leaderboard-period="currentCycle"');expect(html).toContain('data-leaderboard-period="lifetime"');
    expect(leaderboardPercent(null)).toBe('—');
  });
});

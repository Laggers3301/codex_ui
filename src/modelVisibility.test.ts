import {expect,it} from 'vitest';
import {visibleConversationModels} from './modelVisibility';
const profiles=[
 {model:'gpt-6-astra'},
 ...['sonnet','opus','fable','fable-5','fable-5-2'].map(name=>({model:`reclaude-${name}@380703`,restrictedToSourceThreadId:'original-pp'})),
 {model:'reclaude-opus@999',restrictedToSourceThreadId:'another-private-source'}
];
it('shows every same-account Claude family in an authorized Sonnet continuation',()=>{
 const visible=visibleConversationModels(profiles,{id:'claude-branch',configuredModel:'reclaude-sonnet@380703'});
 expect(visible.map(p=>p.model)).toEqual(profiles.slice(0,-1).map(p=>p.model));
});
it('keeps the designated GPT source eligible to branch into the private account',()=>{
 expect(visibleConversationModels(profiles,{id:'original-pp',configuredModel:'gpt-6-astra'})).toEqual(profiles.slice(0,-1));
});
it('does not expose a private account in a new chat or unrelated GPT thread',()=>{
 for(const thread of [null,{id:'other',configuredModel:'gpt-6-astra'}])expect(visibleConversationModels(profiles,thread)).toEqual([profiles[0]]);
});
it('does not cross accounts or infer Claude rights from an unrelated provider suffix',()=>{
 expect(visibleConversationModels(profiles,{id:'branch',configuredModel:'reclaude-sonnet@777'})).toEqual([profiles[0]]);
 expect(visibleConversationModels(profiles,{id:'branch',configuredModel:'gpt-example@380703'})).toEqual([profiles[0]]);
});
it('supports the native model fallback and preserves disabled choices and effort variants',()=>{
 const options=[{...profiles[2],id:'low',effort:'low',availability:'disabled'}, {...profiles[2],id:'high',effort:'high',availability:'ready'}];
 expect(visibleConversationModels(options,{id:'branch',model:'reclaude-sonnet@380703'})).toEqual(options);
});

import {describe,it,expect} from 'vitest';
import {activityBundleSummary} from './activityBundle';
describe('activity bundle labels',()=>{
  const thoughts=[{id:'r1',type:'reasoning'},{id:'r2',type:'reasoning'}];
  it('keeps a single thought standalone and bundles consecutive thoughts',()=>{
    expect(activityBundleSummary(thoughts.slice(0,1))).toMatchObject({hasTools:false,bundle:false,count:1});
    expect(activityBundleSummary(thoughts)).toMatchObject({hasTools:false,bundle:true,count:2});
  });
  it('changes to a tool heading only when a tool actually arrives',()=>{
    expect(activityBundleSummary([...thoughts,{id:'t1',type:'toolCall',tool:'exec'}])).toMatchObject({hasTools:true,bundle:true,count:1,toolLabel:'exec'});
    expect(activityBundleSummary([...thoughts,{id:'t1',type:'toolCall',tool:'exec'},{id:'t2',type:'toolCall',tool:'web'}])).toMatchObject({hasTools:true,count:2,toolLabel:'工具'});
  });
  it('does not count reasoning as file changes or tool calls',()=>{
    expect(activityBundleSummary([...thoughts,{id:'f',type:'fileChange'}])).toMatchObject({hasTools:true,count:1});
    expect(activityBundleSummary([])).toMatchObject({hasTools:false,bundle:false,count:0});
  });
});

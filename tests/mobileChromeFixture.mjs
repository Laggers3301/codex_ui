/** All APIs and WebSocket messages stay inside the browser fixture. */
export async function installMobileChromeFixture(context, user) {
  await context.addInitScript(userId => {
    localStorage.setItem('codex-web-user-id', userId);
    localStorage.setItem(`codex-v2-project-${userId}`, 'mobile-project');
    localStorage.setItem(`codex-v2-expanded-projects-${userId}`, '["mobile-project"]');
    class Socket extends EventTarget {
      static OPEN=1;static CONNECTING=0;static CLOSED=3;readyState=0;requests=[];
      constructor(){super();window.mobileQaSocket=this;setTimeout(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));this.emit({type:'hello',data:{liveState:{activeTurns:[],agentMessages:[],reasoningMessages:[],toolItems:[]},turnProgress:[],pendingServerRequests:[]}})},20);}
      emit(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
      send(raw){const request=JSON.parse(raw);this.requests.push(request.type);if(request.type==='transport.ping')this.emit({type:'transport.pong'});else if(request.requestId)this.emit({type:'ack',requestId:request.requestId,ok:true,data:{data:[]}});}
      close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
    }
    window.WebSocket=Socket;
  },user);
  const quota={account:{type:'chatgpt',planType:'pro'},rateLimits:{primary:{usedPercent:75,windowDurationMins:300,resetsAt:null},secondary:null,credits:null,individualLimit:null,planType:'pro',rateLimitReachedType:null},rateLimitsByLimitId:{},resetCredits:null,usage:null,errors:[],updatedAt:new Date().toISOString()};
  const project={id:'mobile-project',name:'移动界面验收',rootPath:'/fixture',userId:user,defaultModel:'gpt-6.1-sol',defaultReasoningEffort:'medium',defaultSandbox:'danger-full-access',defaultApprovalPolicy:'never'};
  const thread={id:'mobile-thread',name:'手机阅读与侧栏',cwd:'/fixture',createdAt:1,updatedAt:1,status:'active',configuredModel:'gpt-6.1-sol',turns:[{id:'mobile-turn',status:'completed',items:[{id:'mobile-user',type:'userMessage',text:'检查手机左栏、正文和右栏。',timelineAt:'2020-01-01T00:00:00Z'},{id:'mobile-answer',type:'agentMessage',text:'这是用于检查字号与玻璃效果的隔离示例。\n\n文字保持统一，菜单和侧栏平滑开合。',completed:true,timelineAt:'2020-01-01T00:00:01Z'}]}]};
  thread.turns[0].items.splice(1,0,...[1,2].map(index=>({id:`mobile-tool-${index}`,type:'toolCall',tool:'exec',input:'fixture only',output:'ok',completed:true})));
  thread.turns[0].items.at(-1).text+='\n\n![示例图A](/fixture/first.png)\n\n![示例图B](/fixture/second.png)';
  await context.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;let json={data:[]};
    if(path.endsWith('/files/raw')){const portrait=route.request().url().includes('second.png');await route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${portrait?600:1200}" height="${portrait?1200:600}"><rect width="100%" height="100%" fill="#74a18b"/></svg>`});return;}
    if(path==='/api/users')json={data:[{id:user,name:'QA'}],defaultUserId:user};
    else if(path==='/api/projects')json={data:[project],projectRoot:'/fixture'};
    else if(path==='/api/projects/mobile-project/threads')json={data:[thread]};
    else if(path==='/api/threads/mobile-thread')json={thread,history:{totalItems:2,returnedItems:2,before:0,hasOlder:false}};
    else if(path.endsWith('/execution-settings'))json={data:{sandbox:'danger-full-access',approvalPolicy:'never'}};
    else if(path.endsWith('/context')||path.endsWith('/side-chat'))json={data:null};
    else if(path.endsWith('/browser'))json={data:null};
    else if(path.endsWith('/subagents'))json={data:[],page:{total:0,activeCount:0,historyCount:0,hasMore:false}};
    else if(path==='/api/pets')json={pets:[],activePetId:null,visible:false,position:null};
    else if(path==='/api/codex/account-pool')json={data:{strategy:'highest-remaining-sticky-thread',accounts:Array.from({length:4},(_,index)=>({id:`fixture-${index}`,label:`Account ${index+1}`,health:'ready',selectedForNewThreads:index===0,assignedThreadCount:0,activeRequests:0,lastError:null,lastCheckedAt:null,quota})),updatedAt:new Date().toISOString()}};
    else if(path==='/api/codex/provider-quotas')json={data:{items:[],loading:false}};
    else if(path==='/api/models')json={data:[{id:'sol',label:'gpt-6.1-sol medium',model:'gpt-6.1-sol',effort:'medium'}]};
    else if(path==='/api/system/resources')json={data:{hostname:'fixture-host',platform:'linux',sampledAt:new Date().toISOString(),cpu:{usagePercent:20,cores:8,model:'fixture CPU',loadAverage:[0,0,0]},memory:{usagePercent:40,usedBytes:4e9,totalBytes:1e10,availableBytes:6e9},volumes:[{labels:['/'],usagePercent:45,usedBytes:45e9,totalBytes:1e11,availableBytes:55e9}],disks:[],warnings:[]}};
    await route.fulfill({json});
  });
  return {project:'mobile-project',thread:'mobile-thread'};
}

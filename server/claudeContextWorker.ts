import {buildMigratedContext,buildNativeForkContext} from './claudeContext.js';
process.stdin.setEncoding('utf8');
let input='';for await(const chunk of process.stdin){input+=String(chunk);if(input.length>16384)throw Error('Invalid context job');}
const {database,threadId,userId,nativeFile}=JSON.parse(input);
process.stdout.write(JSON.stringify(nativeFile?await buildNativeForkContext(nativeFile):await buildMigratedContext(database,threadId,userId)));

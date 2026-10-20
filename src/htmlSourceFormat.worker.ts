import {format} from 'prettier/standalone';
import html from 'prettier/plugins/html';
import postcss from 'prettier/plugins/postcss';
import babel from 'prettier/plugins/babel';
import estree from 'prettier/plugins/estree';
self.onmessage=async(event:MessageEvent<{source:string}>)=>{
 try{const text=await format(event.data.source,{parser:'html',plugins:[html,postcss,babel,estree],printWidth:100,tabWidth:2,htmlWhitespaceSensitivity:'ignore'});self.postMessage({text});}
 catch{self.postMessage({error:true});}
};

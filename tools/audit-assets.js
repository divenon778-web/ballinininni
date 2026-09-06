#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..'),PUB=path.join(ROOT,'public');
const TEXT=new Set(['.html','.js','.css','.json','.svg','.txt']);
const criticalHosts=['bloxflip.com','api.bloxflip.com','cms-media.bloxflip.com','emoji.bloxflip.com','realtime.bloxflip.com','gb-proxy.bloxflip.com','identity.bloxflip.com','notifications-api.bloxflip.com','notifications-ws.bloxflip.com','chat.bloxflip.com'];
let external=[],missing=[],homeMedia=[];
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(TEXT.has(path.extname(p).toLowerCase())){let t='';try{t=fs.readFileSync(p,'utf8')}catch{};for(const h of criticalHosts){const re=new RegExp(`(?:https?:\\/\\/|wss?:\\/\\/)${h.replace(/\./g,'\\.')}(?:[^\\s\"'<>)]*)?`,'gi');for(const m of t.matchAll(re))external.push({file:path.relative(ROOT,p),url:m[0]});}
 for(const m of t.matchAll(/(?:[\"'(=]|url\()\s*(\/__external\/(?:cms-media\.bloxflip\.com|emoji\.bloxflip\.com|fonts\.gstatic\.com|fonts\.googleapis\.com)\/[^\s\"')?#]+)/g)){const rel=m[1];const local=path.join(PUB,decodeURIComponent(rel.split('?')[0]));if(!fs.existsSync(local))missing.push({file:path.relative(ROOT,p),url:rel});}
}}}
walk(PUB);
try{const home=fs.readFileSync(path.join(PUB,'index.html'),'utf8');for(const m of home.matchAll(/%2F_next%2Fstatic%2Fmedia%2F([A-Za-z0-9._-]+)/g)){const rel=`/_next/static/media/${m[1]}`;if(!fs.existsSync(path.join(PUB,rel)))homeMedia.push(rel);}}catch{}
const uniq=(arr,key)=>[...new Map(arr.map(x=>[key(x),x])).values()];external=uniq(external,x=>x.file+'|'+x.url);missing=uniq(missing,x=>x.url);homeMedia=[...new Set(homeMedia)];
console.log(`Critical BloxFlip external runtime references: ${external.length}`);for(const x of external.slice(0,100))console.log('EXTERNAL',x.file,x.url);
console.log(`Missing captured local external assets: ${missing.length}`);for(const x of missing.slice(0,30))console.log('MISSING_CAPTURE',x.url);
console.log(`Missing homepage hashed media sources: ${homeMedia.length}`);for(const x of homeMedia)console.log('MISSING_HOME_MEDIA',x);
console.log('Note: missing captured external CMS/font resources, if any, are served by local fallback and do not trigger a BloxFlip request.');
process.exitCode=(external.length||homeMedia.length)?1:0;

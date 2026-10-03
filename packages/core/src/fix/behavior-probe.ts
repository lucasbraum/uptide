/** Plain JS executed in a bounded child; no application entry point or test script is loaded. */
export const BEHAVIOR_PROBE = String.raw`
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {isDeepStrictEqual} from 'node:util';
import net from 'node:net';
import dgram from 'node:dgram';
const deny=()=>{throw new Error('network disabled during behavior check')};
net.Socket.prototype.connect=deny;net.connect=deny;net.createConnection=deny;dgram.createSocket=deny;
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const req=createRequire(input.resolveFrom);
const v3=req('zod/v3'), v4=req('zod');
function load(graph,zod){
 const cache=new Map();
 function module(file){
  if(cache.has(file))return cache.get(file);
  const entry=graph.modules[file];if(!entry)throw new Error('schema module not prepared: '+file);
  const exports={};cache.set(file,exports);
  const context=vm.createContext({exports,module:{exports},require:(name)=>{
    if(name==='zod'||name==='zod/v3')return zod;
    if(entry.imports[name])return module(entry.imports[name]);
    throw new Error('unstubbed runtime import: '+name);
  }});
  vm.runInContext(entry.code,context,{timeout:2000});return context.module.exports;
 }
 return module(graph.entry);
}
let seed=1729; const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
const clone=x=>structuredClone(x);
function regexSample(regex){
 const source=regex.source;let result='',i=0;
 while(i<source.length){
  let atom=source[i++];
  if(atom==='^'||atom==='$')continue;
  if(atom==='('||atom===')'||atom==='|')return undefined;
  if(atom==='['){let cls='[';while(i<source.length){const c=source[i++];cls+=c;if(c==='\\'&&i<source.length)cls+=source[i++];else if(c===']')break;}
   const test=new RegExp(cls);atom=[...'a019AZ _-@'].find(c=>test.test(c));if(atom===undefined)return undefined;
  }else if(atom==='\\'){
   const c=source[i++];atom={d:'0',w:'a',s:' ',D:'a',W:'-',S:'a'}[c]??c;
  }else if(atom==='.')atom='a';
  let count=1;
  if(source[i]==='{'){const close=source.indexOf('}',i);if(close<0)return undefined;count=Number(source.slice(i+1,close).split(',')[0]);i=close+1;}
  else if(source[i]==='?'||source[i]==='*'){count=0;i++;}else if(source[i]==='+')i++;
  if(!Number.isFinite(count)||count>2048)return undefined;result+=atom.repeat(count);
 }
 return new RegExp(regex.source,regex.flags.replace(/[gy]/g,'')).test(result)?result:undefined;
}
function sample(s,depth=0){
 if(depth>8) return undefined;
 const d=s._def??{}, kind=d.typeName;
 if(kind==='ZodObject')return Object.fromEntries(Object.entries(d.shape()).map(([k,v])=>[k,sample(v,depth+1)]));
 if(kind==='ZodArray')return Array.from({length:Math.max(1,d.minLength?.value??0)},()=>sample(d.type,depth+1));
 if(kind==='ZodTuple')return d.items.map(x=>sample(x,depth+1));
 if(kind==='ZodEnum')return d.values[0];
 if(kind==='ZodNativeEnum')return Object.values(d.values).find(x=>typeof x==='string')??Object.values(d.values)[0];
 if(kind==='ZodLiteral')return d.value;
 if(kind==='ZodBoolean')return true;
 if(kind==='ZodDate')return new Date('2020-01-01T00:00:00Z');
 if(kind==='ZodNull')return null;
 if(kind==='ZodNumber'||kind==='ZodBigInt'){
  let n=1;for(const c of d.checks??[])if(c.kind==='min')n=Math.max(n,c.value+(c.inclusive===false?1:0));
  for(const c of d.checks??[])if(c.kind==='max')n=Math.min(n,c.value-(c.inclusive===false?1:0));
  return kind==='ZodBigInt'?BigInt(n):n;
 }
 if(kind==='ZodString'){
  const checks=d.checks??[];
  const formats={email:'test@example.com',uuid:'123e4567-e89b-42d3-a456-426614174000',url:'https://example.com',datetime:'2020-01-01T00:00:00Z',ip:'127.0.0.1',base64:'dGVzdA==',cuid:'cjld2cjxh0000qzrmn831i7rn',cuid2:'tz4a98xxat96iws9zmbrgj3a',ulid:'01ARZ3NDEKTSV4RRFFQ69G5FAV'};
  let text=checks.map(c=>c.kind==='regex'?regexSample(c.regex):formats[c.kind]).find(v=>v!==undefined)??'valid';
  for(const c of checks){if(c.kind==='min'||c.kind==='length')text=text.padEnd(Math.min(2048,c.value),'a');if(c.kind==='max'||c.kind==='length')text=text.slice(0,c.value);}
  return text;
 }
 if(kind==='ZodUnion')return sample(d.options[0],depth+1);
 if(kind==='ZodDiscriminatedUnion')return sample([...d.options.values()][0],depth+1);
 if(kind==='ZodRecord')return {key:sample(d.valueType,depth+1)};
 if(kind==='ZodIntersection')return {...sample(d.left,depth+1),...sample(d.right,depth+1)};
 if(d.innerType)return sample(d.innerType,depth+1);
 if(d.schema)return sample(d.schema,depth+1);
 if(d.type&&typeof d.type==='object')return sample(d.type,depth+1);
 return 'sample';
}
function schemaKind(s){
 for(let depth=0;depth<10;depth++){
  const d=s._def??{};
  if(d.typeName==='ZodObject')return Object.keys(d.shape()).length>1?'object':'single-field';
  if(d.typeName==='ZodEnum'||d.typeName==='ZodNativeEnum')return 'enum';
  if(d.typeName==='ZodLiteral')return 'literal';
  const inner=d.innerType??d.schema??(d.typeName==='ZodBranded'?d.type:undefined);
  if(inner){s=inner;continue;}
  return ['ZodString','ZodNumber','ZodBigInt','ZodBoolean','ZodDate','ZodSymbol','ZodNull','ZodUndefined'].includes(d.typeName)?'single-field':'other';
 }
 return 'other';
}
function walk(s,path=[],out=[],depth=0){
 if(depth>8)return out;
 out.push({s,path});const d=s._def??{};
 if(d.typeName==='ZodObject')for(const [k,v]of Object.entries(d.shape()))walk(v,[...path,k],out,depth+1);
 else if(d.typeName==='ZodArray')walk(d.type,[...path,0],out,depth+1);
 else if(d.innerType)walk(d.innerType,path,out,depth+1);
 else if(d.schema)walk(d.schema,path,out,depth+1);
 return out;
}
function set(base,path,value,remove=false){
 if(!path.length)return value;const out=clone(base);let p=out;
 for(const key of path.slice(0,-1)){if(p==null||typeof p!=='object')return out;p=p[key];}
 if(p==null||typeof p!=='object')return out;
 if(remove)delete p[path.at(-1)];else p[path.at(-1)]=value;return out;
}
function validVariants(schema){
 const base=sample(schema), found=[];const seen=new Set();
 const add=v=>{const key=JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x);if(!seen.has(key)&&parse(schema,v).success){seen.add(key);found.push(v);}};
 add(base);
 for(let n=0;n<300&&found.length<24;n++){
  let value=clone(base);
  for(const {s,path} of walk(schema)){
   const d=s._def??{};let v;
   if(d.typeName==='ZodString'){
    const checks=d.checks??[], kinds=checks.map(c=>c.kind);
    if(kinds.includes('email'))v='sample'+n+'@example.com';
    else if(kinds.includes('uuid'))v='123e4567-e89b-42d3-a456-'+String(n).padStart(12,'0');
    else if(kinds.includes('url'))v='https://example.com/'+n;
    else if(kinds.includes('datetime'))v=new Date(Date.UTC(2020,0,1+n)).toISOString();
    else if(kinds.includes('regex')){v=sample(s);const candidates=[v+String(n),v.replace(/[0-9a-f]/gi,c=>/[0-9]/.test(c)?String(n%10):c),v.replace(/^a+/, 'sample'+n)];v=candidates.find(x=>parse(s,x).success)??v;}
    else {const min=checks.find(c=>c.kind==='min')?.value??0,max=checks.find(c=>c.kind==='max')?.value??256,len=checks.find(c=>c.kind==='length')?.value;v=('sample'+n).padEnd(len??min,'x').slice(0,len??max);}
   }else if(d.typeName==='ZodNumber')v=(d.checks??[]).find(c=>c.kind==='min')?.value??0,v+=n;
   else if(d.typeName==='ZodEnum')v=d.values[n%d.values.length];
   else if(d.typeName==='ZodBoolean')v=n%2===0;
   else if(d.typeName==='ZodArray'){const item=sample(d.type),len=Math.min(4,(d.minLength?.value??0)+n%3);v=Array.from({length:len},()=>clone(item));}
   if(v!==undefined&&parse(s,v).success)value=set(value,path,v);
  }
  add(value);
 }
 return found;
}
function corpus(schema){
 const valid=validVariants(schema), base=valid[0]??sample(schema), values=[...valid,null,undefined,{},[],true,0,''];
 for(const {s,path} of walk(schema)){
  values.push(set(base,path,undefined,true));
  for(const v of [undefined,null,0,1,-1,true,false,{},[],'', 'x', 'x'.repeat(256)])values.push(set(base,path,v));
  for(const c of s._def?.checks??[])if(['min','max','length'].includes(c.kind))for(const delta of [-1,0,1]){
   const n=c.value+delta;
   values.push(set(base,path,s._def.typeName==='ZodString'?'x'.repeat(Math.max(0,Math.min(4096,n))):n));
  }
 }
 if(base&&typeof base==='object'&&!Array.isArray(base))values.push({...base,__extra:'extra'});
 const fields=walk(schema);
 while(values.length<200){const f=fields[Math.floor(random()*fields.length)];values.push(set(base,f.path,random()<.5?Math.floor(random()*100):'x'.repeat(Math.floor(random()*50))));}
 // Spread large schemas across the fixed budget; always retain root/valid/null samples.
 return values.length<=200?values:values.slice(0,32).concat(Array.from({length:168},(_,i)=>values[32+Math.floor(i*(values.length-32)/168)]));
}
const at=(value,path)=>path.reduce((x,k)=>x?.[k],value);
function custom(issue,root,value){
 const candidates=walk(root).filter(x=>JSON.stringify(x.path)===JSON.stringify(issue.path));
 if(issue.code==='custom')return true;
 for(const {s} of candidates){
  const d=s._def??{};
  if((d.checks??[]).some(c=>c.message===issue.message))return true;
  if(d.errorMap){try{const ctx={data:at(value,issue.path),defaultError:'__uptide_default__'};if(d.errorMap(issue,ctx)?.message!==ctx.defaultError)return true;}catch{}}
 }
 return false;
}
function parse(s,value){try{return s.safeParse(clone(value));}catch(e){return {thrown:String(e.message)}}}
function compare(a,b,value,paths){
 const x=parse(a,value),y=parse(b,value);
 if(x.thrown||y.thrown)return x.thrown===y.thrown?null:{kind:'exception',before:x.thrown,after:y.thrown};
 if(x.success!==y.success)return {kind:'success',before:x.success,after:y.success};
 if(x.success)return isDeepStrictEqual(clone(x.data),clone(y.data))?null:{kind:'output',before:x.data,after:y.data};
 for(const issue of x.error.issues){
  if(!paths.some(p=>p.every((key,i)=>key==='*'||key===issue.path[i]))||!custom(issue,a,value))continue;
  const matches=y.error.issues.filter(i=>JSON.stringify(i.path)===JSON.stringify(issue.path));
  if(!matches.some(i=>i.message===issue.message))return {kind:'custom-message',path:issue.path,before:issue.message,after:matches.map(i=>i.message)};
 }
 return null;
}
function messageAssertions(a,b,sites){
 const base=validVariants(a)[0]??sample(a), results=[];
 for(const site of sites)for(const sourcePath of site.paths)for(const kind of ['missing','wrong-type']){
  const match=walk(a).find(x=>JSON.stringify(x.path)===JSON.stringify(sourcePath))??walk(a).find(x=>JSON.stringify(x.path.filter(k=>typeof k!=='number'))===JSON.stringify(sourcePath));
  const path=match?.path??sourcePath,schema=match?.s;
  if(!schema){results.push({site:site.site,path,input:kind,status:'skipped',reason:'schema path not resolved'});continue;}
  const wrong=[null,123,'wrong',false,[],{}].find(v=>!parse(schema,v).success);
  const value=set(base,path,kind==='missing'?undefined:wrong,kind==='missing');
  const x=parse(a,value),y=parse(b,value);
  const issue=x.error?.issues.find(i=>JSON.stringify(i.path)===JSON.stringify(path)&&custom(i,a,value));
  if(!issue){results.push({site:site.site,path,input:kind,status:'default',reason:'no repository-defined message for this input'});continue;}
  const after=y.error?.issues.find(i=>JSON.stringify(i.path)===JSON.stringify(path))?.message;
  results.push({site:site.site,path,input:kind,status:after===issue.message?'identical':'different',before:issue.message,after});
 }
 return results;
}
function shrink(value,still){
 let out=clone(value);
 for(let round=0;round<128;round++){
  const options=[];
  if(out&&typeof out==='object'&&!Array.isArray(out)&&!(out instanceof Date))for(const k of Object.keys(out)){const next=clone(out);delete next[k];options.push(next);}
  if(Array.isArray(out)&&out.length)options.push([],out.slice(0,1));
  if(typeof out==='string'&&out.length)options.push('',out.slice(0,1));
  if(typeof out==='number'&&out!==0)options.push(0);
  let changed=false;for(const next of options)if(still(next)){out=next;changed=true;break;}
  if(!changed)break;
 }
 return out;
}
try{
 const a=load(input.before,v3)[input.name],b=load(input.after,v4)[input.name];
 if(!a?.safeParse||!b?.safeParse)throw new Error('binding is not a loadable schema on both versions');
 const values=corpus(a);if(values.some(v=>parse(a,v).thrown||parse(b,v).thrown))throw new Error('schema parsing threw; asynchronous or unsupported effect requires manual behavior testing');let identical=0,validInputs=0;const diffs=new Map();
 for(const value of values){if(parse(a,value).success)validInputs++;const diff=compare(a,b,value,input.paths);if(!diff){identical++;continue;}
  const key=diff.kind+JSON.stringify(diff.path??[]);
  if(!diffs.has(key)){const minimal=shrink(value,v=>{const d=compare(a,b,v,input.paths);return d&&d.kind===diff.kind&&JSON.stringify(d.path??[])===JSON.stringify(diff.path??[])});diffs.set(key,{...compare(a,b,minimal,input.paths),input:minimal});}
 }
 console.log(JSON.stringify({inputs:values.length,identical,validInputs,schemaKind:schemaKind(a),differences:[...diffs.values()],messageChecks:messageAssertions(a,b,input.sites??[]),loadedModules:Object.keys(input.before.modules)},(_,v)=>typeof v==='bigint'?{bigint:String(v)}:v===undefined?{undefined:true}:v));
}catch(e){console.log(JSON.stringify({inputs:0,identical:0,validInputs:0,differences:[],skipped:String(e.message)}))}
`;

import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
export const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
export const source = name => readFileSync(new URL(`../../src/lib/shopify/${name}.ts`, import.meta.url),'utf8');
export const coreUrl=moduleUrl(source('typed-spec-core'));
export const core=await import(coreUrl);
export const adapterUrl=moduleUrl(source('typed-spec-adapter').replace('"./typed-spec-core"',JSON.stringify(coreUrl)));
export const adapter=await import(adapterUrl);
export const stateUrl=moduleUrl(source('typed-spec-state-adapter').replace('"./typed-spec-core"',JSON.stringify(coreUrl)));
export async function workerFor(context) {
 const name=`specFixture_${Math.random().toString(36).slice(2)}`;globalThis[name]=context;
 const stub=moduleUrl(`export const fetchTypedSpecSnapshot=(...args)=>globalThis[${JSON.stringify(name)}].fetch(...args);export const writeTypedSpecFields=(...args)=>globalThis[${JSON.stringify(name)}].write(...args);`);
 const raw=source('typed-spec-worker').replace('import "server-only";','').replace('"./admin-api"',JSON.stringify(stub)).replace('"./typed-spec-core"',JSON.stringify(coreUrl)).replace('"./typed-spec-adapter"',JSON.stringify(adapterUrl)).replace('"./typed-spec-state-adapter"',JSON.stringify(stateUrl));
 return import(moduleUrl(raw));
}

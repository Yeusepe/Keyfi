import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import nock from 'nock';
import { Database } from '../src/db.js';
import { Service } from '../src/service.js';
import { Providers } from '../src/providers.js';
import { Secrets, Failure, createSecrets, productNameKey } from '../src/security.js';
import { storeDefinitions, storeDefinition } from '../src/stores/registry.js';
import type { StoreDefinition } from '../src/stores/contract.js';
import { Limits, createRequester } from '../src/http.js';
import { createServer } from '../src/server.js';
import { closeDocument, closeScript, closeScriptHash, createAuthentication } from '../src/auth.js';
import { Jobs } from '../src/jobs.js';
import { migratePurchaseData } from '../src/purchase-storage.js';
import { DiscordApi, panelMessage, type DiscordPort } from '../src/discord.js';
import type { Entitlement, Panel, Store } from '../src/model.js';
import { Interactions, interactionSchema, type Interaction } from '../src/interactions.js';
import { ButtonStyle, MessageFlags } from 'discord.js';

let mongo:MongoMemoryReplSet,client:MongoClient,db:Database,service:Service;
let secrets:Secrets;
const roles=new Map<string,Set<string>>();let removed=0,added=0,failRemoval=false;
const discord:DiscordPort={administrator:async()=>{},validateRole:async()=>{},memberRoles:async(_g,u)=>[...(roles.get(u)??[])],
  addRole:async(_g,u,r)=>{const set=roles.get(u)??new Set();set.add(r);roles.set(u,set);added++;},
  removeRole:async(_g,u,r)=>{if(failRemoval)throw new Failure('discord_unavailable');roles.get(u)?.delete(r);removed++;}};
const store:Store={_id:'store',provider:'gumroad',ownerId:'creator',credential:'',administrator:'123',status:'active',createdAt:new Date()};
const panel:Panel={_id:'panel',guildId:'456',administrator:'123',stores:{gumroad:'store'},mappings:[{provider:'gumroad',productId:'product',roleId:'789',label:'Product'}],messages:[],active:true,createdAt:new Date()};
// Buyer codes are scoped: one per store for purchases, one per server for roles.
const subjectOf=(discordId:string,storeId='store')=>secrets.subject(discordId,`store:${storeId}`);
const guildOf=(discordId:string,guildId='456')=>secrets.subject(discordId,`guild:${guildId}`);
const memberOf=async(discordId:string,guildId='456')=>`${guildId}:${await guildOf(discordId,guildId)}`;
const finishAll=async()=>{for(const d of await service.pendingDeletions(100))await service.finishDeletion(d._id);};
const entitlement=():Entitlement=>({provider:'gumroad',storeId:'store',ownerId:'creator',entitlementId:'license:one',referenceId:'sale-1',productId:'product',membership:false,eligibility:'eligible',checkedAt:new Date()});
before(async()=>{
  mongo=await MongoMemoryReplSet.create({binary:{version:'8.0.16'},replSet:{count:1,storageEngine:'wiredTiger'}});
  client=await new MongoClient(mongo.getUri()).connect(); db=new Database(client,'keyfi_test');await db.initialize();
  secrets=await createSecrets(client,'keyfi_test','07'.repeat(32));store.credential=await secrets.seal('secret','store');
},{timeout:300_000});
after(async()=>{await client?.close();await mongo?.stop();});
beforeEach(async()=>{
  for(const c of await db.db.collections())await c.deleteMany({});
  roles.clear();removed=0;added=0;failRemoval=false;
  await db.stores.insertOne(store);await db.panels.insertOne(panel);
  service=new Service(db,new Providers(async()=>{throw new Error('Unexpected API call');},secrets),discord,secrets);
});
const componentsOf=(components:any[]):any[]=>components.flatMap(c=>[c,...componentsOf(c.components??[]),...(c.accessory?[c.accessory]:[])]);
function ui(member={user:{id:'123'},permissions:'32'}) {
  const calls:{method:string;route:string;body:unknown;files?:{name:string;data:Buffer}[]}[]=[];
  const api={...discord,applicationId:'123',call:async(method:string,route:string,body:unknown,files?:{name:string;data:Buffer}[])=>{calls.push({method,route,body,files});return {id:'999'};},
    updatePanel:DiscordApi.prototype.updatePanel};
  const interactions=new Interactions(db,service,api as any,{begin:async()=> 'https://example.com/authorize'} as any,new Limits(db),'Test Operator, privacy@example.com');
  const input=(overrides:Partial<Interaction>={}):Interaction=>({id:'100',application_id:'123',type:2,token:'PRIVATE-INTERACTION-TOKEN',guild_id:'456',channel_id:'444',member,data:{name:'keyfi',options:[{name:'setup'}]},...overrides});
  const action=async(name:string,overrides:Partial<Interaction>={},data?:Record<string,string>)=>{
    const i=input({type:3,message:{id:'555',flags:MessageFlags.Ephemeral},...overrides});
    const key='action-'+name;
    await db.actions.insertOne({_id:key,panelId:panel._id,guildId:i.guild_id,discordId:i.member.user.id,action:name,data,expiresAt:new Date(Date.now()+600000)});
    i.data={...overrides.data,custom_id:`action:${key}`};return i;
  };
  const view=()=>{
    const body=calls.at(-1)!.body as any,parts=componentsOf(body.components);
    const copy=parts.filter((c:any)=>c.type===10).map((c:any)=>c.content).join('\n');
    const controls=parts.filter((c:any)=>[2,3,6].includes(c.type));
    for(const part of parts) {
      if(part.type===1) assert.ok(part.components.length<=5,'Discord action-row limit');
      if(part.type===9) {assert.ok(part.components.length<=3);assert.equal(part.accessory.type,2);}
    }
    assert.ok(copy.length<=4000,'Discord text limit');assert.ok(parts.length<=40,'Discord component limit');
    const ids=controls.filter((c:any)=>c.custom_id).map((c:any)=>c.custom_id);
    assert.equal(new Set(ids).size,ids.length,'each control has a distinct binding');
    assert.deepEqual(body.allowed_mentions,{parse:[]});
    return {copy,controls,select:controls.find((c:any)=>c.type===3)};
  };
  const use=async(control:any,values?:string[])=>{
    assert.ok(control);assert.ok(!control.disabled);
    const step=await interactions.prepare(input({type:3,message:{id:'555',flags:MessageFlags.Ephemeral},data:{custom_id:control.custom_id,values}}));
    if((step.response as any).type===7) {
      assert.equal(step.work,undefined);
      calls.push({method:'patch',route:'interaction-response',body:(step.response as any).data});
    } else { assert.deepEqual(step.response,{type:6});await step.work!(); }
  };
  const click=(label:string)=>use(view().controls.find((c:any)=>c.type===2&&c.label===label));
  const choose=(value:string)=>use(view().select,[value]);
  return {api,calls,interactions,input,action,view,click,choose};
}
test('startup restores a missing interaction endpoint and verifies the application identity',async()=>{
  const api=new DiscordApi('test-token','123'),endpoint='https://keyfi.example/interactions';
  let application={id:'123',verify_key:'public-key',interactions_endpoint_url:null as string|null},writes=0;
  api.call=async <T>(method:string,_route:string,body?:unknown):Promise<T>=>{
    if(method==='patch'){writes++;application={...application,...body as {interactions_endpoint_url:string}};}
    return application as T;
  };
  await api.ensureInteractions('https://keyfi.example','public-key');
  assert.equal(application.interactions_endpoint_url,endpoint);assert.equal(writes,1);
  await api.ensureInteractions('https://keyfi.example','public-key');assert.equal(writes,1);
  application.interactions_endpoint_url='https://old.example/interactions';
  await api.ensureInteractions('https://keyfi.example','public-key');assert.equal(writes,2);
  await assert.rejects(api.ensureInteractions('https://keyfi.example','wrong-key'),{message:'discord_configuration'});assert.equal(writes,2);
  application.id='456';await assert.rejects(api.ensureInteractions('https://keyfi.example','public-key'),{message:'discord_configuration'});
});

test('regular members cannot use setup commands, admin buttons, or admin modal submissions',async()=>{
  const h=ui(),member={user:{id:'123'},permissions:'0'};
  await assert.rejects(h.interactions.prepare(h.input({member})),{message:'admin_required'});
  for(const name of ['connect-store','search','credential-submit','role-selected','publish','settings','connect-store','sync','catalog','stores','store','disconnect-confirm','roles','delete-panel-confirm','delete-panel']) {
    const i=await h.action(name,{member,type:name.endsWith('submit')?5:3});
    await assert.rejects(h.interactions.prepare(i),{message:'admin_required'});
  }
  assert.equal(h.calls.length,0);assert.equal(await db.panels.countDocuments(),1);
});
test('admin modals check current permissions and panel ownership before opening',async()=>{
  const h=ui();
  await assert.rejects(h.interactions.prepare(await h.action('connect-store',{member:{user:{id:'222'},permissions:'32'}},{provider:'jinxxy'})),{message:'admin_required'});
  h.api.administrator=async()=>{throw new Failure('admin_required');};
  await assert.rejects(h.interactions.prepare(await h.action('search')),{message:'admin_required'});
  assert.equal(h.calls.length,0);
});
test('without Gumroad sign-in no buyer index is built or kept',async()=>{
  const off=new Service(db,service.providers,discord,secrets,false);
  await new Jobs({} as any,db,service,discord as any).upsertLookups([{_id:'old',storeId:'store',productId:'product',referenceId:'sale-1',membership:false,buyerHash:'hash'}]);
  await db.sync.insertOne({_id:'store:old',panelId:'panel',storeId:'store',productId:'old',membership:false,initialComplete:true,startedAt:new Date(),nextAt:new Date()});
  await off.addMapping(panel,{...panel.mappings[0]!,productId:'new'});
  assert.equal(await db.sync.countDocuments({productId:'new'}),0);
  await off.reconcileIndex();
  assert.equal(await db.lookups.countDocuments(),0);assert.equal(await db.sync.countDocuments(),0);
  await service.reconcileIndex();
  assert.equal(await db.sync.countDocuments(),2);
});
test('buyers see when their saved Gumroad link is used and can unlink it without admin rights',async()=>{
  const h=ui(),member={user:{id:'111'},permissions:'0'};
  await db.subjects.insertOne({_id:await subjectOf('111'),deleting:false,revision:0,epoch:'e',gumroadHash:'hash'});
  await db.panels.updateOne({_id:panel._id},{$set:{messages:[{messageId:'555',channelId:'444'}]}});
  await db.sync.insertOne({_id:'sync',panelId:'panel',storeId:'store',productId:'product',membership:false,initialComplete:true,startedAt:new Date(),nextAt:new Date(Date.now()+60_000)});
  await (await h.interactions.prepare(h.input({type:3,member,message:{id:'555'},data:{custom_id:`verify:oauth:${panel._id}`}}))).work!();
  const notice=JSON.stringify(h.calls.at(-1)!.body);
  assert.ok(notice.includes('linked Gumroad account'));assert.ok(notice.includes('Change Account…'));
  await (await h.interactions.prepare(h.input({member,data:{name:'verification'}}))).work!();
  assert.ok(JSON.stringify(h.calls.at(-1)!.body).includes('Privacy & Data'));
  await (await h.interactions.prepare(await h.action('privacy-settings',{member}))).work!();
  assert.ok(JSON.stringify(h.calls.at(-1)!.body).includes('Disconnect Gumroad'));
  await (await h.interactions.prepare(await h.action('unlink',{member}))).work!();
  assert.equal((await db.subjects.findOne({_id:await subjectOf('111')}))?.gumroadHash,undefined);
});
test('buyers get a private, complete copy of their data and anyone can read the notices',async()=>{
  const h=ui(),member={user:{id:'111'},permissions:'0'};
  await db.subjects.insertOne({_id:await subjectOf('111'),deleting:false,revision:0,epoch:'e',gumroadHash:'gum-hash'});
  const s111=await subjectOf('111');
  await db.claims.insertOne(await service.storedClaim('claim-1',{...entitlement(),keyHash:'key-hash'},s111,new Date()));
  const g111=await guildOf('111');
  await db.bindings.insertOne({_id:'claim-1:panel',claimId:'claim-1',panelId:'panel',guildId:'456',subject:g111});
  await db.members.insertOne({_id:await memberOf('111'),guildId:'456',subject:g111,discord:await secrets.seal('111',g111),revision:1,dirty:false,managedRoles:['789']});
  await db.catalog.insertOne({_id:'store:product',storeId:'store',productId:'product',name:'Brush Kit',membership:false,licensed:true,variants:[],fetchedAt:new Date()});
  await db.claims.insertOne(await service.storedClaim('other-claim',{...entitlement(),entitlementId:'license:two'},await subjectOf('222'),new Date()));
  await (await h.interactions.prepare(await h.action('show-data',{member}))).work!();
  const sent=h.calls.at(-1)!;
  assert.equal(sent.files?.[0]?.name,'keyfi-data.json');assert.ok(JSON.stringify(sent.body).includes('attachment://keyfi-data.json'));
  const data=JSON.parse(sent.files![0]!.data.toString());
  assert.equal(data.discordId,'111');assert.equal(data.purchases.length,1);assert.equal(data.purchases[0].product,'Brush Kit');
  assert.deepEqual(data.roles,[{server:'456',managedRoles:['789'],updatePending:false}]);
  assert.deepEqual(data.pseudonymousIdentifiers.stores,[{store:'store',code:s111,gumroadAccount:'gum-hash'}]);
  assert.deepEqual(data.pseudonymousIdentifiers.servers,[{server:'456',code:g111}]);
  assert.notEqual(s111,g111,'store and server codes differ');assert.equal(data.pseudonymousIdentifiers.purchases[0].licenseKey,'key-hash');
  assert.ok(!JSON.stringify(data).includes('other-claim'));
  const buyer=await h.interactions.prepare(h.input({type:3,member,data:{custom_id:'keyfi:privacy'}}));
  const creator=await h.interactions.prepare(h.input({data:{name:'keyfi',options:[{name:'privacy'}]}}));
  for(const [prepared,title] of [[buyer,'## Privacy'],[creator,'## Privacy for creators']] as const) {
    const json=JSON.stringify(prepared.response);
    assert.equal((prepared.response as any).type,4);assert.equal(prepared.work,undefined);
    assert.ok(json.includes(title));assert.ok(json.includes('Test Operator, privacy@example.com'));
  }
  assert.ok(JSON.stringify(buyer.response).includes('never keeps'));assert.ok(JSON.stringify(creator.response).includes('Data terms (v1)'));
  await assert.rejects(h.interactions.prepare(h.input({member,data:{name:'keyfi',options:[{name:'privacy'}]}})),{message:'admin_required'});
});
test('private navigation edits the current message and public license forms stay private',async()=>{
  const h=ui();
  const privateStep=await h.interactions.prepare(await h.action('settings'));
  assert.deepEqual(privateStep.response,{type:6});await privateStep.work!();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0]!.method,'patch');
  const modal=await h.action('search-submit',{type:5,data:{components:[{component:{custom_id:'value',value:'test'}}]}});
  assert.deepEqual((await h.interactions.prepare(modal)).response,{type:6});
  const license=await h.action('license',{type:5,message:{id:'public',flags:MessageFlags.IsComponentsV2}});
  assert.deepEqual((await h.interactions.prepare(license)).response,{type:5,data:{flags:MessageFlags.Ephemeral}});
});

test('public verification emphasizes an available action and separates private utilities',()=>{
  for(const ready of [false,true]) {
    const body=panelMessage(panel,ready);
    assert.equal(body.flags,MessageFlags.IsComponentsV2);
    const content=body.components[0]!.components as any[],methods=content.filter(c=>c.type===9);
    assert.equal(methods.length,2);
    const key=methods.at(-1)!.accessory;
    assert.equal(key.disabled,false);assert.match(methods.at(-1)!.components[0].content,/receipt/);
    assert.equal(methods[0].accessory.style,ready?ButtonStyle.Primary:ButtonStyle.Secondary);
    assert.equal(methods[0].accessory.disabled,!ready);assert.match(methods[0].components[0].content,/Gumroad account/);
    if(!ready)assert.match(methods[0].components[0].content,/not ready yet/);
    assert.equal(key.style,ready?ButtonStyle.Secondary:ButtonStyle.Primary);
    assert.equal(content[methods.length+1].type,14,'utilities follow a native separator');
    const utilities=content.at(-1).components;
    assert.deepEqual(utilities.map((c:any)=>c.custom_id),['keyfi:verification','keyfi:privacy']);
    assert.ok(utilities.every((c:any)=>c.style===ButtonStyle.Secondary));
    assert.ok(!JSON.stringify(body).includes('Delete Data'));
  }
});

test('regular buyers navigate privacy, export, and deletion in one private message',async()=>{
  const h=ui({user:{id:'111'},permissions:'0'});
  await service.claim(panel,'111',entitlement());
  const start=await h.interactions.prepare(h.input({type:3,message:{id:'public'},data:{custom_id:'keyfi:verification'}}));
  assert.deepEqual(start.response,{type:5,data:{flags:MessageFlags.Ephemeral}});await start.work!();
  assert.deepEqual(h.view().controls.map((c:any)=>c.label),['Check Purchases','Privacy & Data']);
  assert.ok(!h.view().copy.includes('up to date'));
  await h.click('Privacy & Data');
  await h.click('Download Data');
  assert.equal(h.calls.at(-1)?.files?.[0]?.name,'keyfi-data.json');
  assert.equal((h.calls.at(-1)!.body as any).attachments.length,1);
  await h.click('Back to Privacy & Data');
  assert.deepEqual((h.calls.at(-1)!.body as any).attachments,[],'navigation removes the sensitive attachment');
  await h.click('View Privacy');
  assert.match(h.view().copy,/Discord processes the license form/);
  assert.match(h.view().copy,/one-way opt-out code/);
  await h.click('Back to Privacy & Data');
  const openDelete=h.view().controls.find((c:any)=>c.label==='Delete Data…');
  assert.equal(openDelete.style,ButtonStyle.Secondary);
  await h.click('Delete Data…');
  assert.match(h.view().copy,/every server/);
  assert.equal(h.view().controls.find((c:any)=>c.label==='Delete Data').style,ButtonStyle.Danger);
  assert.equal((await db.subjects.findOne({_id:await subjectOf('111')}))?.deleting,false);
  await h.click('Cancel');
  assert.match(h.view().copy,/Privacy & data/);
  assert.equal(await db.claims.countDocuments({subject:await subjectOf('111')}),1);
  await h.click('Delete Data…');await h.click('Delete Data');await h.click('Manage Access');
  assert.equal((await db.subjects.findOne({_id:await subjectOf('111')}))?.deleting,true);
  assert.match(h.view().copy,/Removing your roles/);
  assert.equal(h.view().controls.find((c:any)=>c.label==='Check Purchases').disabled,true);
  assert.ok(h.calls.every(c=>c.method==='patch'));
  assert.ok(h.calls.every(c=>((c.body as any).flags&MessageFlags.Ephemeral)!==0));
});

for(const unavailable of [false,true])test(`Check Purchases finishes in the same private message when the store ${unavailable?'is unavailable':'confirms purchases'}`,async()=>{
  await db.catalog.insertOne({_id:'catalog',storeId:'store',productId:'product',name:'Purchased Avatar',membership:false,licensed:true,variants:[],fetchedAt:new Date()});
  await service.claim(panel,'111',entitlement());await service.reconcile(await memberOf('111'));
  await db.claims.updateMany({},{$set:{checkedAt:new Date(Date.now()-60_000)}});
  // Another buyer's scheduled check and private purchase must not be included.
  await service.claim(panel,'222',{...entitlement(),entitlementId:'license:other',referenceId:'PRIVATE-OTHER-PURCHASE'});
  const h=ui({user:{id:'111'},permissions:'0'});
  await (await h.interactions.prepare(h.input({type:3,message:{id:'public'},data:{custom_id:'keyfi:verification'}}))).work!();
  assert.match(h.view().copy,/Purchased Avatar/);assert.match(h.view().copy,/<@&789>/);
  let started!:()=>void;
  const queued=new Promise<void>(resolve=>{started=resolve;}),call=h.api.call;
  h.api.call=async(method,route,body,files)=>{const result=await call(method,route,body,files);if(JSON.stringify(body).includes('## Checking 1 purchase'))started();return result;};
  const control=h.view().controls.find((c:any)=>c.label==='Check Purchases');
  const step=await h.interactions.prepare(h.input({type:3,message:{id:'private',flags:MessageFlags.Ephemeral},data:{custom_id:control.custom_id}}));
  assert.deepEqual(step.response,{type:6});
  const work=step.work!();await queued;
  assert.match(h.view().copy,/The result will appear here/);
  let checks=0;
  service.providers.recheck=async(_store,e)=>{checks++;if(unavailable)throw new Failure('provider_unavailable');return {...e,eligibility:'ineligible',checkedAt:new Date()};};
  const jobs=new Jobs({} as any,db,service,h.api as any);
  await jobs.providers();await jobs.roles();await work;
  assert.equal(checks,1);
  assert.match(h.view().copy,new RegExp(`Checked ${unavailable?0:1} of 1 purchases`));
  assert.match(h.view().copy,unavailable?/Could not confirm/:/No longer eligible/);
  assert.equal(roles.get('111')?.has('789'),unavailable);
  assert.ok(!h.view().copy.includes('Checking purchases'));assert.ok(!JSON.stringify(h.calls).includes('PRIVATE-OTHER-PURCHASE'));
  assert.ok(h.view().controls.some((c:any)=>c.label==='Check Purchases'));
  assert.ok(h.calls.every(c=>c.route.startsWith('/webhooks/123/PRIVATE-INTERACTION-TOKEN/')));
  assert.ok(h.calls.every(c=>((c.body as any).flags&MessageFlags.Ephemeral)!==0));
});

test('Manage Access shows an empty state and a stale Check Purchases button does not start an endless check',async()=>{
  const h=ui({user:{id:'111'},permissions:'0'});
  const step=await h.interactions.prepare(await h.action('recheck'));await step.work!();
  assert.match(h.view().copy,/No purchases verified yet/);
  assert.equal(h.view().controls.find((c:any)=>c.label==='Check Purchases').disabled,true);
  assert.equal(h.calls.length,1);
});

test('failed license checks offer a private retry bound to the same buyer and server',async()=>{
  const h=ui({user:{id:'111'},permissions:'0'}),key='RAW KEY CANARY';
  const failed=await h.interactions.prepare(await h.action('license',{type:5,data:{components:[{component:{custom_id:'value',value:key}}]}}));
  assert.deepEqual(failed.response,{type:6});await failed.work!();
  assert.match(h.view().copy,/complete license key/);
  assert.ok(!JSON.stringify(h.calls).includes(key));
  assert.ok(!JSON.stringify(await db.actions.find().toArray()).includes(key));
  const retry=h.view().controls.find((c:any)=>c.label==='Enter License Key…');
  assert.equal(retry.style,ButtonStyle.Primary);
  const input=h.input({type:3,message:{id:'555',flags:MessageFlags.Ephemeral},data:{custom_id:retry.custom_id}});
  await assert.rejects(h.interactions.prepare({...input,member:{user:{id:'222'},permissions:'0'}}),{message:'expired'});
  await assert.rejects(h.interactions.prepare({...input,guild_id:'999'}),{message:'expired'});
  const opened=await h.interactions.prepare(input);
  assert.equal((opened.response as any).type,9);assert.equal(opened.work,undefined);
  const action=await db.actions.findOne({_id:(opened.response as any).data.custom_id.slice(7)});
  assert.equal(action?.action,'license');assert.equal(action?.panelId,panel._id);assert.equal(action?.discordId,'111');
});
test('connecting shared stores automatically queues one catalog sync and preserves its progress',async()=>{
  await db.panels.updateOne({_id:panel._id},{$set:{stores:{}}});
  await db.panels.insertOne({...panel,_id:'other',stores:{}});
  const storeId=await service.connect(panel._id,'123','gumroad','new-creator','SECRET-CANARY');
  assert.equal(await db.catalogJobs.countDocuments(),1);
  const connected=await db.stores.findOne({_id:storeId});assert.equal(connected?.termsVersion,'1');assert.ok(connected?.termsAcceptedAt);
  await db.catalogJobs.updateOne({_id:storeId},{$set:{page:2}});
  assert.equal(await service.connect('other','123','gumroad','new-creator','SECRET-CANARY'),storeId);
  assert.equal((await db.catalogJobs.findOne({_id:storeId}))?.page,2);
  assert.ok(!JSON.stringify(await db.catalogJobs.find().toArray()).includes('SECRET-CANARY'));
  let requests=0;service.providers.catalogPage=async()=>{requests++;return {products:[],more:false};};
  const jobs=new Jobs({} as any,db,service,discord as any,{} as any);
  await jobs.providers();await jobs.providers();
  assert.equal(requests,1);
  const scheduled=await db.catalogJobs.findOne({_id:storeId});
  assert.equal(scheduled?.syncing,false);assert.ok(scheduled!.nextAt.getTime()>Date.now()+5*3600000);
});
test('setup progress updates the same private message only when changed and stops after navigation',async()=>{
  const h=ui();await h.interactions.settings(h.input(),panel);
  const view=await db.setupViews.findOne({_id:panel._id});assert.ok(view);
  assert.ok(!JSON.stringify(view).includes('PRIVATE-INTERACTION-TOKEN'));
  await db.catalog.insertOne({_id:'catalog',storeId:'store',productId:'product',name:'Product',membership:false,licensed:true,variants:[],fetchedAt:new Date()});
  assert.equal(await h.interactions.refreshSetup(panel._id),true);
  assert.equal(await h.interactions.refreshSetup(panel._id),false);
  assert.equal(h.calls.length,2);assert.ok(h.calls.every(c=>c.method==='patch'));
  assert.equal((await db.setupViews.findOne({_id:panel._id}))?.expiresAt.getTime(),view.expiresAt.getTime());
  const next=await h.interactions.prepare(await h.action('products'));await next.work!();
  assert.equal(await h.interactions.refreshSetup(panel._id),false);
  const lost=ui();await lost.interactions.settings(lost.input(),panel);
  await db.catalog.deleteMany({});lost.api.administrator=async()=>{throw new Failure('admin_required');};
  await assert.rejects(lost.interactions.refreshSetup(panel._id),{message:'admin_required'});
  assert.equal(await db.setupViews.countDocuments(),0);
});

test('manual store sync coalesces across instances, preserves cursors, and uses the background queue',async()=>{
  const future=new Date(Date.now()+3600_000), after='2026-09-01';
  await db.catalogJobs.insertOne({_id:store._id,page:1,nextAt:future,syncing:false});
  await db.sync.insertOne({_id:'sync',panelId:panel._id,storeId:store._id,productId:'product',membership:false,initialComplete:true,after,startedAt:new Date(),nextAt:future});
  const second=new Service(db,service.providers,discord,secrets);
  const results=await Promise.all([service.syncStores(panel._id,'123'),second.syncStores(panel._id,'123')]);
  assert.equal(results.filter(Boolean).length,1);
  let queued=await db.catalogJobs.findOne({_id:store._id});assert.equal(queued?.syncing,true);
  assert.ok(queued!.nextAt<future);assert.equal(await db.catalogJobs.countDocuments(),1);
  const sync=await db.sync.findOne({_id:'sync'});assert.equal(sync?.after,after);assert.ok(sync!.nextAt<future);
  await db.catalogJobs.updateOne({_id:store._id},{$set:{page:3,nextAt:future,error:'rate_limited'}});
  assert.equal(await service.syncStores(panel._id,'123'),false);
  queued=await db.catalogJobs.findOne({_id:store._id});assert.equal(queued?.page,3);assert.equal(queued?.nextAt.getTime(),future.getTime());assert.equal(queued?.error,'rate_limited');
  await db.catalogJobs.updateOne({_id:store._id},{$set:{syncing:false}});
  assert.equal(await service.syncStores(panel._id,'123'),false);
  await assert.rejects(service.syncStores(panel._id,'222'),{message:'admin_required'});
});

test('store controls group sync and connections separately from product roles',async()=>{
  const h=ui();
  const stores=await h.interactions.prepare(await h.action('stores'));await stores.work!();
  const storeBody=JSON.stringify(h.calls.at(-1)?.body);
  assert.ok(storeBody.includes('Sync Now'));assert.ok(storeBody.includes('Manage Gumroad'));assert.ok(!storeBody.includes('Disconnect'));
  await h.click('Manage Gumroad');assert.ok(h.view().controls.some((c:any)=>c.label==='Reconnect Gumroad'));
  await h.click('Disconnect…');assert.match(h.view().copy,/Disconnect Gumroad/);await h.click('Cancel');
  assert.ok(h.view().controls.some((c:any)=>c.label==='Back to Stores'));
  assert.equal((await service.panel(panel._id)).stores.gumroad,'store');
  const roleStep=await h.interactions.prepare(await h.action('roles'));await roleStep.work!();
  const roleBody=JSON.stringify(h.calls.at(-1)?.body);
  assert.ok(roleBody.includes('Add Product'));assert.ok(roleBody.includes('Remove…'));assert.ok(!roleBody.includes('Reconnect Gumroad'));
  const manual=await h.interactions.prepare(await h.action('sync'));assert.deepEqual(manual.response,{type:6});await manual.work!();
  assert.ok(JSON.stringify(h.calls.at(-1)?.body).includes('Sync queued'));
  assert.ok(h.calls.every(c=>c.method==='patch'));assert.equal(await db.catalogJobs.countDocuments(),1);
});

test('Jinxxy panel opens a private license form and grants the mapped role with two lookups',async()=>{
  const h=ui();await h.interactions.settings(h.input(),{...panel,stores:{jinxxy:'jinx'},mappings:[{...panel.mappings[0]!,provider:'jinxxy'}]});
  const jinxPanel={...panel,stores:{gumroad:'store',jinxxy:'jinx'},mappings:[{...panel.mappings[0]!,provider:'jinxxy' as const}],messages:[{messageId:'public',channelId:'444'}]};
  const publicBody=panelMessage(jinxPanel,false), json=JSON.stringify(publicBody);
  const buttons=componentsOf(publicBody.components).filter(c=>c.type===2);
  assert.equal(buttons.length,3);assert.equal(buttons[0].disabled,false);assert.equal(buttons[2].custom_id,'keyfi:privacy');assert.ok(!json.includes('Sign In with Gumroad'));
  await db.panels.replaceOne({_id:panel._id},jinxPanel);
  await db.stores.insertOne({...store,_id:'jinx',provider:'jinxxy'});
  const key='550e8400-e29b-41d4-a716-446655440000',calls:string[]=[];
  service.providers.request=async(s,path)=>{
    calls.push(path);assert.equal(s._id,'jinx');
    return path==='/licenses'?{page_count:1,results:[{id:'license'}]}:{id:'license',key,short_key:'ABCD-446655440000',inventory_item:{target_id:'product',target_version_id:null,target_type:'PRODUCT',grant_type:'ORDER_ITEM',item:{object:'PurchasedProduct',id:'product',version:null},order:{id:'order',payment_status:'PAID'}}};
  };
  const member={user:{id:'111'},permissions:'0'};
  const opened=await h.interactions.prepare(h.input({type:3,member,data:{custom_id:`verify:key:${panel._id}`},message:{id:'public'}}));
  assert.equal((opened.response as any).type,9);
  const submitted=await h.interactions.prepare(h.input({type:5,member,message:{id:'public'},data:{custom_id:(opened.response as any).data.custom_id,components:[{component:{custom_id:'value',value:key}}]}}));
  assert.deepEqual(submitted.response,{type:5,data:{flags:MessageFlags.Ephemeral}});await submitted.work!();
  assert.deepEqual(calls,['/licenses','/licenses/license']);
  assert.equal(await db.claims.countDocuments({subject:await subjectOf('111','jinx'),provider:'jinxxy'}),1);
  await service.reconcile(await memberOf('111'));assert.equal(roles.get('111')?.has('789'),true);
  assert.ok(!JSON.stringify(await db.claims.find().toArray()).includes(key));
});
test('publishing an existing buyer panel edits it without deleting or posting another message',async()=>{
  await db.panels.updateOne({_id:panel._id},{$set:{messages:[{channelId:'444',messageId:'333'}]}});
  const h=ui();await h.interactions.settings(h.input(),await service.panel(panel._id));await h.click('Publish Verification');
  assert.ok(h.calls.some(c=>c.route==='/channels/444/messages/333'&&c.method==='patch'));
  assert.ok(h.calls.every(c=>c.method==='patch'));
});

test('Publish remains available and replaces a deleted message in one click while preserving other channels',async()=>{
  const other={channelId:'888',messageId:'777'};
  await db.panels.updateOne({_id:panel._id},{$set:{messages:[{channelId:'444',messageId:'333'},other]}});
  const h=ui();h.api.updatePanel=async()=>{throw new Failure('message_missing');};
  await h.interactions.settings(h.input(),await service.panel(panel._id));await h.click('Publish Verification');
  assert.deepEqual((await service.panel(panel._id)).messages,[other,{channelId:'444',messageId:'999'}]);
  assert.equal(h.calls.filter(c=>c.method==='post'&&c.route==='/channels/444/messages').length,1);
  assert.match(h.view().copy,/Verification is ready in <#444>/);
  const member={user:{id:'111'},permissions:'0'};
  for(const location of (await service.panel(panel._id)).messages) {
    const opened=await h.interactions.prepare(h.input({type:3,member,channel_id:location.channelId,message:{id:location.messageId},data:{custom_id:`verify:key:${panel._id}`}}));
    assert.equal((opened.response as any).type,9);
  }
  await assert.rejects(h.interactions.prepare(h.input({type:3,member,message:{id:'333'},data:{custom_id:`verify:key:${panel._id}`}})),{message:'expired'});
  await assert.rejects(h.interactions.prepare(h.input({type:3,member,channel_id:'888',message:{id:'999'},data:{custom_id:`verify:key:${panel._id}`}})),{message:'expired'});
});

test('publishing in another channel keeps both copies and refreshing there does not duplicate messages',async()=>{
  const first={channelId:'444',messageId:'333'};
  await db.panels.updateOne({_id:panel._id},{$set:{messages:[first]}});
  const h=ui();
  for(let n=0;n<2;n++) {
    const step=await h.interactions.prepare(await h.action('publish',{channel_id:'888'}));await step.work!();
  }
  assert.deepEqual((await service.panel(panel._id)).messages,[first,{channelId:'888',messageId:'999'}]);
  assert.equal(h.calls.filter(c=>c.method==='post').length,1);
  assert.ok(h.calls.some(c=>c.method==='patch'&&c.route==='/channels/888/messages/999'));
  assert.ok(h.calls.every(c=>!c.route.startsWith('/channels/444/')));
});

test('a Discord failure keeps the saved verification message and never posts a duplicate',async()=>{
  const location={channelId:'444',messageId:'333'};
  await db.panels.updateOne({_id:panel._id},{$set:{messages:[location]}});
  const h=ui();h.api.updatePanel=async()=>{throw new Failure('discord_permissions');};
  const step=await h.interactions.prepare(await h.action('publish'));await step.work!();
  assert.deepEqual((await service.panel(panel._id)).messages,[location]);
  assert.ok(h.calls.every(c=>c.method!=='post'));
});

test('empty panels can be deleted from setup, with cancellation and a return to the remaining panels',async()=>{
  await db.panels.insertMany(['empty-one','empty-two'].map(_id=>({...panel,_id,stores:{},mappings:[]})));
  const h=ui();await (await h.interactions.prepare(h.input())).work!();
  assert.equal(h.view().select.options.length,3);
  await h.choose('empty-one');await h.click('Delete Panel…');
  assert.match(h.view().copy,/0 product roles and 0 published verification messages/);
  assert.equal(await db.panels.countDocuments(),3);
  await h.click('Cancel');assert.match(h.view().copy,/Verification setup/);
  await h.click('Delete Panel…');
  const confirm=h.view().controls.find((c:any)=>c.label==='Delete Panel');assert.equal(confirm.style,ButtonStyle.Danger);
  await assert.rejects(h.interactions.prepare(h.input({type:3,member:{user:{id:'222'},permissions:'32'},data:{custom_id:confirm.custom_id}})),{message:'expired'});
  await h.click('Delete Panel');
  assert.equal(await db.panels.findOne({_id:'empty-one'}),null);assert.equal(h.view().select.options.length,2);
  await h.choose('empty-two');await h.click('Delete Panel…');await h.click('Delete Panel');
  assert.equal(await db.panels.countDocuments(),1);assert.equal(h.view().select.options[0].value,panel._id);
  assert.deepEqual((await service.panel(panel._id)).mappings,panel.mappings);
  assert.ok(h.calls.every(c=>c.method==='patch'));
});

test('deleting a configured panel removes its messages and exclusive roles while preserving a shared store and role',async()=>{
  const shared={...panel,_id:'shared'};
  await db.panels.insertOne(shared);
  await db.panels.updateOne({_id:panel._id},{$set:{mappings:[...panel.mappings,{...panel.mappings[0]!,productId:'exclusive',roleId:'790'}],messages:[{channelId:'444',messageId:'333'},{channelId:'888',messageId:'777'}]}});
  const current=await service.panel(panel._id);
  await service.claim(current,'111',entitlement());await service.claim(shared,'111',entitlement());
  await service.claim(current,'111',{...entitlement(),productId:'exclusive',entitlementId:'license:exclusive'});
  await service.reconcile(await memberOf('111'));assert.deepEqual(roles.get('111'),new Set(['789','790']));
  await db.sync.insertMany(['product','exclusive'].map(productId=>({_id:productId,panelId:panel._id,storeId:'store',productId,membership:false,initialComplete:true,startedAt:new Date(),nextAt:new Date()})));
  await db.flows.insertOne({_id:'pending',panelId:panel._id,guildId:'456',discordId:'123',kind:'creator',epoch:'e',expiresAt:new Date(Date.now()+600_000)});
  await db.db.collection('account_checks').insertOne({_id:'pending' as never,panelId:panel._id});
  const h=ui(),call=h.api.call;
  h.api.call=async(method,route,body,files)=>{const result=await call(method,route,body,files);if(method==='delete'&&route==='/channels/444/messages/333')throw new Failure('message_missing');return result;};
  await h.interactions.settings(h.input(),current);await h.click('Delete Panel…');await h.click('Delete Panel');
  assert.deepEqual(h.calls.filter(c=>c.method==='delete').map(c=>c.route),['/channels/444/messages/333','/channels/888/messages/777']);
  assert.equal(await db.panels.findOne({_id:panel._id}),null);assert.ok(await db.panels.findOne({_id:shared._id}));
  assert.equal((await db.stores.findOne({_id:'store'}))?.status,'active');
  assert.equal(await db.bindings.countDocuments({panelId:panel._id}),0);assert.equal(await db.bindings.countDocuments({panelId:shared._id}),1);
  assert.equal(await db.sync.countDocuments({productId:'exclusive'}),0);assert.equal(await db.sync.countDocuments({productId:'product'}),1);
  for(const name of ['flows','actions','account_checks'])assert.equal(await db.db.collection(name).countDocuments({panelId:panel._id}),0);
  assert.equal(await db.setupViews.countDocuments({_id:panel._id}),0);
  await service.reconcile(await memberOf('111'));assert.deepEqual(roles.get('111'),new Set(['789']));
  await assert.rejects(service.claim(current,'111',entitlement()),{message:'expired'});
});

test('deleting the last panel disconnects its store and keeps role cleanup retryable',async()=>{
  await service.claim(panel,'111',entitlement());await service.reconcile(await memberOf('111'));
  await assert.rejects(service.deletePanel(panel._id,'222'),{message:'admin_required'});
  assert.equal(await db.panels.countDocuments(),1);
  const h=ui();await h.interactions.settings(h.input(),panel);await h.click('Delete Panel…');await h.click('Delete Panel');
  assert.equal(await db.panels.countDocuments(),0);assert.match(h.view().copy,/Panel deleted/);assert.match(h.view().copy,/No panels available/);
  assert.equal((await db.stores.findOne({_id:'store'}))?.status,'disconnecting');
  failRemoval=true;await assert.rejects(service.reconcile(await memberOf('111')),{message:'discord_unavailable'});
  assert.equal((await db.members.findOne({_id:await memberOf('111')}))?.dirty,true);
  failRemoval=false;await service.reconcile(await memberOf('111'));assert.deepEqual(roles.get('111'),new Set());
});

test('panel deletion can retry a message permission failure without losing its configuration',async()=>{
  const messages=[{channelId:'444',messageId:'333'},{channelId:'888',messageId:'777'}];
  await db.panels.updateOne({_id:panel._id},{$set:{messages}});
  const h=ui(),call=h.api.call;
  let failing=true;
  h.api.call=async(method,route,body,files)=>{if(failing&&method==='delete'&&route==='/channels/888/messages/777')throw new Failure('discord_permissions');return call(method,route,body,files);};
  await h.interactions.settings(h.input(),await service.panel(panel._id));await h.click('Delete Panel…');await h.click('Delete Panel');
  const remaining=await service.panel(panel._id);assert.deepEqual(remaining.messages,[messages[1]]);assert.deepEqual(remaining.mappings,panel.mappings);
  failing=false;await h.interactions.settings(h.input(),remaining);await h.click('Delete Panel…');await h.click('Delete Panel');
  assert.equal(await db.panels.countDocuments(),0);
  assert.deepEqual(h.calls.filter(c=>c.method==='delete').map(c=>c.route),['/channels/444/messages/333','/channels/888/messages/777']);
});

test('concurrent publish clicks create only one message per channel',async()=>{
  const h=ui();
  const first=await h.interactions.prepare(await h.action('publish'));
  const second=await h.interactions.prepare(await h.action('publish'));
  await Promise.all([first.work!(),second.work!()]);
  assert.equal(h.calls.filter(c=>c.method==='post').length,1);
  assert.deepEqual((await service.panel(panel._id)).messages,[{channelId:'444',messageId:'999'}]);
});

test('Gumroad account buttons work from every published copy and reject unregistered locations',async()=>{
  const messages=[{channelId:'444',messageId:'333'},{channelId:'888',messageId:'777'}];
  await db.panels.updateOne({_id:panel._id},{$set:{messages}});
  await db.sync.insertOne({_id:'sync',panelId:panel._id,storeId:'store',productId:'product',membership:false,initialComplete:true,startedAt:new Date(),nextAt:new Date()});
  const h=ui({user:{id:'111'},permissions:'0'});
  for(const location of [...messages,{channelId:'888',messageId:'333'}]) {
    const step=await h.interactions.prepare(h.input({type:3,channel_id:location.channelId,message:{id:location.messageId},data:{custom_id:`verify:oauth:${panel._id}`}}));
    await step.work!();
    assert.equal(h.view().controls.some((c:any)=>c.label==='Continue in Browser'),messages.includes(location));
  }
});
test('automatic progress waits for OAuth consent and reconnection resumes the existing setup message',async()=>{
  const h=ui(),step=await h.interactions.prepare(await h.action('connect-store',{}, {provider:'gumroad'}));await step.work!();
  assert.ok(JSON.stringify(h.calls[0]?.body).includes('Continue in Browser'));
  assert.equal(await h.interactions.refreshSetup(panel._id),false);
  assert.equal(h.calls.length,1);
  assert.equal(await h.interactions.refreshSetup(panel._id,true),true);
  assert.equal(h.calls.length,2);
  assert.equal((await db.setupViews.findOne({_id:panel._id}))?.waitingForOAuth,undefined);
});
test('removing a product role requires confirmation and offers cancellation',async()=>{
  const h=ui(),step=await h.interactions.prepare(await h.action('remove-selected',{data:{values:['0']}},{snapshot:JSON.stringify(panel.mappings)}));await step.work!();
  assert.equal((await db.panels.findOne({_id:panel._id}))?.mappings.length,1);
  const body=JSON.stringify(h.calls[0]?.body);assert.ok(body.includes('Cancel'));assert.ok(body.includes('Remove Role'));
  assert.equal(await db.actions.countDocuments({action:'remove-confirm'}),1);
});
test('products without versions go directly to choosing a role',async()=>{
  await db.catalog.insertOne({_id:'catalog',storeId:'store',productId:'product',name:'Product',membership:false,licensed:true,variants:[],fetchedAt:new Date()});
  const h=ui(),step=await h.interactions.prepare(await h.action('product-selected',{data:{values:['catalog']}}));await step.work!();
  assert.ok(JSON.stringify(h.calls[0]?.body).includes('Choose buyer role'));
  assert.equal(await db.actions.countDocuments({action:'variant-selected'}),0);
});

test('product pages retain filters and position through selection and handle empty or stale pages',async()=>{
  await db.catalog.insertMany(Array.from({length:23},(_,n)=>({_id:`c${n}`,storeId:'store',productId:`p${n}`,name:`Kit ${String(n).padStart(2,'0')}`,membership:false,licensed:true,variants:[],fetchedAt:new Date()})));
  await db.catalog.insertOne({_id:'outside',storeId:'other',productId:'outside',name:'Kit secret',membership:false,licensed:true,variants:[],fetchedAt:new Date()});
  const h=ui();await h.interactions.products(h.input(),panel,0,'Kit');
  assert.match(h.view().copy,/Page 1 of 3 · 1–10 of 23 products/);
  assert.equal(h.view().select.options.length,10);
  assert.ok(h.view().controls.find((c:any)=>c.label==='Previous').disabled);
  await h.click('Next');assert.match(h.view().copy,/Page 2 of 3/);
  assert.equal(h.view().select.options[0].value,'c10');
  await h.choose('c10');assert.match(h.view().copy,/Choose a role/);
  await h.click('Back to Products');assert.match(h.view().copy,/Page 2 of 3/);assert.match(h.view().copy,/Filter: \*\*Kit\*\*/);
  await h.click('Last');assert.equal(h.view().select.options.length,3);
  assert.ok(h.view().controls.find((c:any)=>c.label==='Next').disabled);
  await h.click('First');assert.match(h.view().copy,/Page 1 of 3/);
  await h.interactions.products(h.input(),panel,999,'Kit');assert.match(h.view().copy,/Page 3 of 3/);
  await h.interactions.products(h.input(),panel,-7,'Kit');assert.match(h.view().copy,/Page 1 of 3/);
  await h.interactions.products(h.input(),panel,NaN,'[.*]');assert.match(h.view().copy,/No products match/);assert.equal(h.view().select,undefined);
  await h.click('Clear Filter');assert.match(h.view().copy,/Page 1 of 3/);assert.ok(!h.view().copy.includes('Filter:'));
  await db.catalog.deleteMany({storeId:'store'});await h.click('Last');
  assert.match(h.view().copy,/No products available yet/);assert.equal(h.view().select,undefined);
  assert.ok(!h.view().controls.some((c:any)=>c.label==='Next'));
  assert.ok(h.calls.every(c=>c.method==='patch'));
});

test('a 10,000-product catalog uses only local paging and readable native options',async()=>{
  let providerCalls=0;service.providers.request=async()=>{providerCalls++;throw new Error('Paging must stay local');};
  const longName='Very long product '.repeat(15);
  await db.catalog.insertMany(Array.from({length:10000},(_,n)=>({_id:`c${n}`,storeId:'store',productId:`p${n}`,name:`${longName}${String(n).padStart(5,'0')}`,membership:false,licensed:true,variants:[],fetchedAt:new Date()})));
  const h=ui();await h.interactions.products(h.input(),panel,0);
  assert.match(h.view().copy,/Page 1 of 1000 · 1–10 of 10000/);
  assert.equal(h.view().select.options.length,10);
  assert.ok(h.view().select.options.every((o:any)=>o.label.length<=100&&o.label.includes('…')));
  assert.ok(h.view().select.options[0].label.endsWith('00000'));
  await h.click('Last');assert.match(h.view().copy,/Page 1000 of 1000 · 9991–10000 of 10000/);
  assert.equal(h.view().select.options.at(-1).value,'c9999');assert.equal(providerCalls,0);
});

test('configured products sort after unconfigured products across pages, filters, and autocomplete',async()=>{
  await db.panels.updateOne({_id:panel._id},{$set:{stores:{gumroad:'store',jinxxy:'jinx'},mappings:[
    {...panel.mappings[0]!,productId:'p0'}, {...panel.mappings[0]!,productId:'p1',variant:'version'},
  ]}});
  await db.catalog.insertMany(Array.from({length:28},(_,n)=>({_id:`c${n}`,storeId:'store',productId:`p${n}`,name:`Kit ${String(n).padStart(2,'0')}`,membership:false,licensed:true,variants:[],fetchedAt:new Date()})));
  await db.catalog.insertOne({_id:'jinx-product',storeId:'jinx',productId:'p0',name:'Kit 00',membership:false,licensed:true,variants:[],fetchedAt:new Date()});
  const h=ui(),current=await service.panel(panel._id);
  await h.interactions.products(h.input(),current,0);
  assert.deepEqual(h.view().select.options.map((o:any)=>o.value),['jinx-product',...Array.from({length:9},(_,n)=>`c${n+2}`)]);
  await h.click('Last');assert.deepEqual(h.view().select.options.slice(-2).map((o:any)=>o.value),['c0','c1']);
  assert.ok(h.view().select.options.slice(-2).every((o:any)=>o.description==='Gumroad · Added'));
  await h.interactions.products(h.input(),current,0,'Kit 0');
  assert.equal(h.view().select.options[0].value,'jinx-product');assert.equal(h.view().select.options.at(-1).value,'c0');
  await h.click('Last');assert.equal(h.view().select.options[0].value,'c1');
  const result=await h.interactions.prepare(h.input({type:4,data:{name:'keyfi',options:[{name:'map',options:[{name:'product',value:'Kit',focused:true}]}]}}));
  const choices=(result.response as any).data.choices;
  assert.equal(choices.length,25);assert.equal(choices[0].value,'jinx-product');assert.ok(choices.every((c:any)=>!['c0','c1'].includes(c.value)));
});

test('version paging preserves the selected version and returns to the original product filter',async()=>{
  await db.panels.updateOne({_id:panel._id},{$set:{stores:{jinxxy:'store'}}});
  const p=await service.panel(panel._id),variants=Array.from({length:23},(_,n)=>({id:`v${n}`,name:`Version ${n}`}));
  await db.catalog.insertMany(Array.from({length:12},(_,n)=>({_id:`c${n}`,storeId:'store',productId:`p${n}`,name:`Kit ${String(n).padStart(2,'0')}`,membership:false,licensed:true,variants:[],fetchedAt:new Date()})));
  let requests=0;service.providers.versions=async()=>{requests++;return variants;};
  const h=ui();await h.interactions.products(h.input(),p,1,'Kit');await h.choose('c10');
  assert.match(h.view().copy,/Page 1 of 3 · 1–10 of 23 versions/);assert.equal(h.view().select.options.length,11);
  await h.click('Last');assert.match(h.view().copy,/Page 3 of 3/);assert.equal(h.view().select.options.length,4);
  assert.equal(h.view().select.options[0].value,'all');await h.choose('2');
  const roleControl=h.view().controls.find((c:any)=>c.type===6);
  assert.equal((await db.actions.findOne({_id:roleControl.custom_id.slice(7)}))?.data?.variant,'v22');
  await h.click('Back to Buyers');assert.match(h.view().copy,/Page 3 of 3/);
  await h.click('Back to Products');assert.match(h.view().copy,/Page 2 of 2/);assert.match(h.view().copy,/Filter: \*\*Kit\*\*/);
  assert.equal(requests,1,'navigating cached versions does not refetch the provider');
});

test('all product roles are readable and removal preserves position, cancellation, and snapshot identity',async()=>{
  const mappings=Array.from({length:11},(_,n)=>({...panel.mappings[0]!,productId:`p${n}`,label:`Product ${n}`,variant:`v${n}`}));
  await db.panels.updateOne({_id:panel._id},{$set:{mappings}});
  await db.catalog.insertMany(mappings.map(m=>({_id:m.productId,storeId:'store',productId:m.productId,name:m.label,variants:[{id:m.variant,name:'Premium'}],membership:false,licensed:true,fetchedAt:new Date()})));
  const h=ui();await (await h.interactions.prepare(await h.action('roles'))).work!();
  assert.match(h.view().copy,/Page 1 of 3 · 1–5 of 11 product roles/);assert.match(h.view().copy,/Gumroad · Premium\n<@&789>/);
  assert.ok(!h.view().copy.includes('Product 5'));
  await h.click('Next');assert.match(h.view().copy,/Product 5/);assert.match(h.view().copy,/Product 9/);
  await h.click('Last');assert.match(h.view().copy,/11–11 of 11/);
  const entry=(h.calls.at(-1)!.body as any).components[0].components.find((c:any)=>c.type===9&&c.accessory.label==='Remove…');
  assert.match(entry.components[0].content,/Product 10/);assert.equal(entry.accessory.label,'Remove…');
  await h.click('Remove…');assert.match(h.view().copy,/Premium/);await h.click('Cancel');assert.match(h.view().copy,/Page 3 of 3/);
  await h.click('Remove…');
  await db.panels.updateOne({_id:panel._id},{$set:{mappings:[mappings[10]!,...mappings.slice(0,10)]}});
  await h.click('Remove Role');
  assert.match(h.view().copy,/Page 2 of 2 · 6–10 of 10/);assert.match(h.view().copy,/Product role removed/);
  assert.deepEqual((await service.panel(panel._id)).mappings.map(m=>m.productId),mappings.slice(0,10).map(m=>m.productId));
  await db.panels.updateOne({_id:panel._id},{$set:{mappings:[]}});await h.click('First');
  assert.match(h.view().copy,/No product roles yet/);
  assert.ok(!h.view().controls.some((c:any)=>c.label==='Remove…'));
});

test('creator panel pagination is private, ordered and bound to the initiating administrator',async()=>{
  await db.panels.insertMany(Array.from({length:22},(_,n)=>({...panel,_id:`panel-${n}`,createdAt:new Date(panel.createdAt.getTime()+n+1)})));
  await db.panels.insertOne({...panel,_id:'private-other',administrator:'222'});
  const h=ui();await (await h.interactions.prepare(h.input())).work!();
  assert.match(h.view().copy,/Page 1 of 3 · 1–10 of 23 panels/);
  const next=h.view().controls.find((c:any)=>c.label==='Next');
  await assert.rejects(h.interactions.prepare(h.input({type:3,member:{user:{id:'222'},permissions:'32'},data:{custom_id:next.custom_id}})),{message:'expired'});
  await h.click('Last');assert.equal(h.view().select.options.length,3);assert.equal(h.view().select.options.at(-1).label,'Panel 23');
  const target=h.view().select.options[0].value;await h.choose(target);assert.match(h.view().copy,/Publish verification/);
  assert.ok(h.calls.every(c=>c.method==='patch'));
});

test('multiple products can share a role through native selectors without duplicating all-version mappings',async()=>{
  await db.panels.updateOne({_id:panel._id},{$set:{'mappings.0.variant':null}});
  const h=ui();
  for(const productId of ['product','second']) await db.catalog.insertOne({_id:`catalog-${productId}`,storeId:'store',productId,name:productId,membership:false,licensed:true,variants:[],fetchedAt:new Date()});
  for(const productId of ['product','second','second']) {
    const choose=await h.interactions.prepare(await h.action('product-selected',{data:{values:[`catalog-${productId}`]}}));await choose.work!();
    const container=(h.calls.at(-1)!.body as any).components[0];
    assert.equal(container.components[1].components[0].type,6,'role selector belongs beside its instructions, before navigation');
    const save=await h.interactions.prepare(h.input({type:3,message:{id:'private',flags:MessageFlags.Ephemeral},data:{custom_id:container.components[1].components[0].custom_id,values:['789']}}));
    assert.deepEqual(save.response,{type:6});await save.work!();
    assert.ok(JSON.stringify(h.calls.at(-1)!.body).includes('Product role saved'));
  }
  const current=await service.panel(panel._id);assert.equal(current.mappings.length,2);
  assert.deepEqual(current.mappings.map(m=>m.roleId),['789','789']);
  await service.claim(current,'111',entitlement());
  await service.claim(current,'111',{...entitlement(),entitlementId:'license:two',referenceId:'sale-2',productId:'second'});
  await service.reconcile(await memberOf('111'));assert.equal(added,1);
  await db.claims.updateOne({_id:await secrets.hash('claim','store','license:one')},{$set:{eligibility:'ineligible'}});await db.dirty('456',await guildOf('111'));await service.reconcile(await memberOf('111'));
  assert.equal(removed,0);assert.equal(roles.get('111')?.has('789'),true);
});

test('native product autocomplete is creator-scoped and the role option can reuse a mapped role',async()=>{
  const h=ui();
  await db.catalog.insertMany([
    {_id:'own',storeId:'store',productId:'second',name:'Brush set',membership:false,licensed:true,variants:[],fetchedAt:new Date()},
    {_id:'outside',storeId:'other-store',productId:'private',name:'Brush private',membership:false,licensed:true,variants:[],fetchedAt:new Date()},
  ]);
  const data={name:'keyfi',options:[{name:'map',options:[{name:'product',value:'Brush',focused:true}]}]};
  const input=interactionSchema.parse(h.input({type:4,data}));
  assert.deepEqual((await h.interactions.prepare(input)).response,{type:8,data:{choices:[{name:'Gumroad · Brush set',value:'own'}]}});
  assert.deepEqual((await h.interactions.prepare({...input,member:{user:{id:'111'},permissions:'0'}})).response,{type:8,data:{choices:[]}});
  assert.equal(h.calls.length,0,'autocomplete makes no Discord or store requests');
  const command=(product:string)=>interactionSchema.parse(h.input({data:{name:'keyfi',options:[{name:'map',options:[{name:'product',value:product},{name:'role',value:'789'}]}]}}));
  await (await h.interactions.prepare(command('own'))).work!();
  assert.equal((await service.panel(panel._id)).mappings.length,2);
  await (await h.interactions.prepare(command('outside'))).work!();
  assert.equal((await service.panel(panel._id)).mappings.length,2);
});

async function matchingCatalog() {
  await db.stores.insertOne({...store,_id:'jinx-store',provider:'jinxxy',ownerId:'jinx-creator'});
  await db.panels.updateOne({_id:panel._id},{$set:{stores:{gumroad:'store',jinxxy:'jinx-store'},mappings:[]}});
  const products=[{_id:'gum-product',storeId:'store',productId:'gum-id',name:'  Brush   Kit '},{_id:'jinx-product',storeId:'jinx-store',productId:'jinx-id',name:'brush kit'}];
  await db.catalog.insertMany(products.map(p=>({...p,nameKey:productNameKey(p.name),membership:false,licensed:true,variants:[],fetchedAt:new Date()})));
  return service.panel(panel._id);
}

test('same-name listings share one role picker while claims and refunds stay store-specific',async()=>{
  const current=await matchingCatalog(),h=ui();
  await h.interactions.products(h.input(),current,0);
  await h.choose('gum-product');assert.match(h.view().copy,/Share a role across stores/);
  assert.ok(h.view().copy.includes('Gumroad'));assert.ok(h.view().copy.includes('Jinxxy'));
  assert.equal((await service.panel(panel._id)).mappings.length,0,'names alone never change access');
  await h.click('Share Role…');assert.ok(h.view().copy.includes('Gumroad')&&h.view().copy.includes('Jinxxy'));assert.match(h.view().copy,/All versions/);
  const role=h.view().controls.find((c:any)=>c.type===6);
  await (await h.interactions.prepare(h.input({type:3,message:{id:'555',flags:MessageFlags.Ephemeral},data:{custom_id:role.custom_id,values:['789']}}))).work!();
  const saved=await service.panel(panel._id);assert.equal(saved.mappings.length,2);assert.deepEqual(saved.mappings.map(m=>m.roleId),['789','789']);
  assert.match(h.view().copy,/saved across 2 stores/);assert.equal(await db.sync.countDocuments(),1,'only the account-sign-in store indexes buyers');
  const gum={...entitlement(),productId:'gum-id'},jinx={...entitlement(),provider:'jinxxy',storeId:'jinx-store',ownerId:'jinx-creator',productId:'jinx-id'};
  await service.claim(saved,'111',gum);await service.claim(saved,'111',jinx);assert.equal(await db.claims.countDocuments(),2);
  await service.reconcile(await memberOf('111'));assert.equal(added,1);
  await db.claims.updateOne({storeId:'store'},{$set:{eligibility:'ineligible'}});await db.dirty('456',await guildOf('111'));await service.reconcile(await memberOf('111'));assert.equal(removed,0);
  assert.ok(h.calls.every(c=>c.method==='patch'));
});

test('same-name suggestions support separate setup, reject ambiguity and stay within the creator panel',async()=>{
  const current=await matchingCatalog(),h=ui();
  await db.catalog.insertOne({_id:'unrelated',storeId:'other-creator',productId:'foreign',name:'BRUSH KIT',nameKey:'brush kit',membership:false,licensed:true,variants:[],fetchedAt:new Date()});
  assert.equal((await service.matchingProducts(current,'gum-product')).length,2);
  await h.interactions.products(h.input(),current,0);await h.choose('gum-product');await h.click('Use Gumroad');
  const control=h.view().controls.find((c:any)=>c.type===6),action=await db.actions.findOne({_id:control.custom_id.slice(7)});
  assert.equal(action?.data?.provider,'gumroad');assert.equal(action?.data?.catalogIds,undefined);
  await db.catalog.insertOne({_id:'ambiguous',storeId:'jinx-store',productId:'duplicate',name:'Brush kit',nameKey:'brush kit',membership:false,licensed:true,variants:[],fetchedAt:new Date()});
  assert.deepEqual((await service.matchingProducts(current,'gum-product')).map(p=>p._id),['gum-product']);
  assert.equal(productNameKey(' ＢＲＵＳＨ \n KIT '),'brush kit');assert.notEqual(productNameKey('Brush Kit Pro'),productNameKey('Brush Kit'));assert.notEqual(productNameKey('Brush-Kit'),productNameKey('Brush Kit'));
});

test('combined mapping is atomic when a membership is unlicensed, a name changes, or a store disconnects',async()=>{
  const current=await matchingCatalog(),ids=['gum-product','jinx-product'];
  await db.catalog.updateOne({_id:'gum-product'},{$set:{membership:true,licensed:false}});
  await assert.rejects(service.mapProducts(current,ids,'789','brush kit'),{message:'membership_license_required'});
  assert.equal((await service.panel(panel._id)).mappings.length,0);assert.equal(await db.sync.countDocuments(),0);
  await db.catalog.updateOne({_id:'gum-product'},{$set:{membership:false,licensed:true,name:'Different product'}});
  await assert.rejects(service.mapProducts(current,ids,'789','brush kit'),{message:'expired'});
  await db.catalog.updateOne({_id:'gum-product'},{$set:{name:'Brush Kit'}});
  await service.disconnect(current,'jinxxy');
  await assert.rejects(service.mapProducts(current,ids,'789','brush kit'),{message:'expired'});
  assert.equal((await service.panel(panel._id)).mappings.length,0);assert.equal(await db.sync.countDocuments(),0);
});

test('native map command offers same-name stores before changing existing mappings',async()=>{
  await matchingCatalog();const h=ui();
  const input=h.input({data:{name:'keyfi',options:[{name:'map',options:[{name:'product',value:'gum-product'},{name:'role',value:'789'}]}]}});
  await (await h.interactions.prepare(input)).work!();assert.match(h.view().copy,/Share a role/);assert.equal((await service.panel(panel._id)).mappings.length,0);
  await h.click('Share Role');assert.equal((await service.panel(panel._id)).mappings.length,2);assert.match(h.view().copy,/saved across 2 stores/);
});

test('a third store uses the shared connection, transport, catalog, mapping and verification paths',async()=>{
  const registry=storeDefinitions as Map<string,StoreDefinition>,requests:string[]=[];
  const definition:StoreDefinition={...storeDefinition('jinxxy'),id:'test-store',name:'Test Store',apiBase:'https://store.test/v1',matchesKey:key=>key.startsWith('TEST-'),
    create:context=>({
      identify:async store=>{await context.request(store,'/me');return 'test-creator';},
      key:async(store,key)=>{await context.request(store,'/licenses',{key});return {...entitlement(),provider:'test-store',storeId:store._id,ownerId:store.ownerId,productId:'test-product'};},
      readReference:async store=>({...entitlement(),provider:'test-store',storeId:store._id,ownerId:store.ownerId,productId:'test-product'}),
      recheck:async(_store,e)=>({...e,checkedAt:new Date()}),
      versions:async(_store,p)=>p.variants,
      catalogPage:async store=>({products:[{_id:'test-catalog',storeId:store._id,productId:'test-product',name:'Third product',membership:false,licensed:true,variants:[],fetchedAt:new Date()}],more:false}),
    }),
  };
  registry.set(definition.id,definition);
  try {
    service.providers.request=createRequester(db,secrets,new Limits(db),(async(url,init)=>{
      const parsed=new URL(String(url));assert.equal(parsed.origin,'https://store.test');assert.equal((init!.headers as any)['x-api-key'],'fixture-credential');requests.push(parsed.pathname);return Response.json({});
    }) as typeof fetch);
    const h=ui();await (await h.interactions.prepare(await h.action('stores'))).work!();assert.ok(h.view().controls.some((c:any)=>c.label==='Connect Test Store'));
    const modal=await h.interactions.prepare(await h.action('connect-store',{}, {provider:'test-store'}));assert.equal((modal.response as any).type,9);
    await (await h.interactions.prepare(await h.action('credential-submit',{type:5,data:{components:[{component:{custom_id:'value',value:'fixture-credential'}}]}},{provider:'test-store'}))).work!();
    const connected=await service.panel(panel._id),store=(await db.stores.findOne({_id:connected.stores['test-store']}))!;
    assert.ok(store);assert.ok(!JSON.stringify(store).includes('fixture-credential'));
    const page=await service.providers.catalogPage(store);await db.catalog.insertMany(page.products);assert.equal(page.products[0]?.nameKey,'third product');
    await h.interactions.products(h.input(),connected,0);assert.equal(h.view().select.options[0].description,'Test Store');await h.choose('test-catalog');
    const control=h.view().controls.find((c:any)=>c.type===6);
    await (await h.interactions.prepare(h.input({type:3,message:{id:'555',flags:MessageFlags.Ephemeral},data:{custom_id:control.custom_id,values:['789']}}))).work!();
    const saved=await service.panel(panel._id);assert.equal(saved.mappings.at(-1)?.provider,'test-store');
    assert.deepEqual(await service.verifyKey(saved,'111','TEST-123'),['789']);assert.deepEqual(requests,['/v1/me','/v1/licenses']);
    service.providers.get('test-store').recheck=async(_s,e)=>({...e,storeId:'another-store'});
    await assert.rejects(service.providers.recheck(store,{...entitlement(),provider:'test-store',storeId:store._id,ownerId:store.ownerId}),{message:'store_mismatch'});
    const publicPanel=panelMessage({...saved,mappings:saved.mappings.filter(m=>m.provider==='test-store')},false);
    assert.ok(!JSON.stringify(publicPanel).includes('"disabled":true'));
    await assert.rejects(service.connect(panel._id,'123','unknown.store','owner','credential'),{message:'unsupported_store'});
  } finally { registry.delete(definition.id); }
});

test('purchase scan processes successive pages promptly and enables every published copy only on completion',async()=>{
  const messages=[{channelId:'444',messageId:'a'},{channelId:'555',messageId:'b'}];
  await db.panels.updateOne({_id:panel._id},{$set:{messages}});
  await db.panels.insertOne({...panel,_id:'shared',messages:[{channelId:'666',messageId:'c'}]});
  await db.optouts.insertOne({_id:'erased-buyer',createdAt:new Date()});
  const h=ui(),posted:boolean[]=[];
  h.api.updatePanel=async(p:Panel,ready:boolean)=>{posted.push(ready);assert.equal(componentsOf((panelMessage(p,ready).toJSON() as any).components).find(c=>c.label==='Sign In with Gumroad').disabled,!ready);};
  const cursors:(string|undefined)[]=[];
  service.providers.indexPage=async(_store,product,_membership,cursor)=>{
    cursors.push(cursor);
    const n=cursors.length;
    if(n<3) assert.equal(await service.ready(panel),false);
    return {records:Array.from({length:10},(_,i)=>({_id:`${n}-${i}`,storeId:store._id,productId:product,referenceId:`${n}-${i}`,membership:false,buyerHash:i===0?'erased-buyer':`buyer-${n}-${i}`})),cursor:n<3?`page-${n+1}`:undefined};
  };
  const jobs=new Jobs({} as any,db,service,h.api as any);
  jobs.maintenance=async()=>{};
  const refresh=jobs.roles.bind(jobs);jobs.roles=async()=>{};
  const started=Date.now();
  try {
    await jobs.start();
    while(!await service.ready(panel) && Date.now()-started<10_000) await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(await service.ready(panel),true,'initial scan must finish without waiting for 15-second provider ticks');
  } finally {await jobs.stop();}
  assert.deepEqual(cursors,[undefined,'page-2','page-3']);
  assert.equal(await db.lookups.countDocuments(),27,'each page excludes buyers who opted out');
  assert.equal((await db.db.collection('privacy_fence').findOne({_id:'index' as never}))?.revision,3,'one import transaction per page');
  const sync=await db.sync.findOne({storeId:store._id});
  assert.equal(sync?.cursor,undefined);assert.ok(sync!.nextAt.getTime()>Date.now()+290_000);
  assert.equal(await db.panels.countDocuments({refreshAt:{$exists:true}}),2);
  await refresh();assert.deepEqual(posted,[true,true,true]);
  await h.interactions.settings(h.input(),await service.panel(panel._id));assert.match(h.view().copy,/Account sign-in is ready/);
});

test('purchase scan preserves its cursor on failure, shows progress, and resumes without duplicate records',async()=>{
  await service.reconcileIndex();
  await db.sync.updateMany({},{$set:{cursor:'page-2'}});
  const h=ui(),jobs=new Jobs({} as any,db,service,h.api as any);
  await jobs.upsertLookups([{_id:'first',storeId:store._id,productId:'product',referenceId:'first',membership:false}]);
  service.providers.indexPage=async()=>{throw new Failure('rate_limited',120);};
  await jobs.index();
  let scan=(await db.sync.findOne({storeId:store._id}))!;
  assert.equal(scan.cursor,'page-2');assert.equal(scan.initialComplete,false);assert.ok(scan.nextAt.getTime()>Date.now()+119_000);
  await h.interactions.settings(h.input(),panel);
  assert.match(h.view().copy,/1 purchases indexed/);assert.match(h.view().copy,/0 of 1 products ready/);assert.match(h.view().copy,/Sync delayed\. Retrying/);
  for(const failure of ['provider_schema','store_reconnect']) {
    await db.sync.updateOne({_id:scan._id},{$set:{nextAt:new Date()}});
    service.providers.indexPage=async()=>{if(failure==='store_reconnect')throw new Failure(failure);return {records:[],cursor:'page-2'};};
    await jobs.index();scan=(await db.sync.findOne({_id:scan._id}))!;
    assert.equal(scan.error,failure);assert.equal(scan.cursor,'page-2');assert.equal(scan.initialComplete,false);
  }
  await h.interactions.settings(h.input(),panel);assert.match(h.view().copy,/Reconnect Gumroad to resume/);
  await db.sync.updateOne({_id:scan._id},{$set:{nextAt:new Date()}});
  service.providers.indexPage=async(_s,_p,_m,cursor)=>{assert.equal(cursor,'page-2');return {records:[{_id:'first',storeId:store._id,productId:'product',referenceId:'first',membership:false}]};};
  await jobs.index();scan=(await db.sync.findOne({_id:scan._id}))!;
  assert.equal(scan.initialComplete,true);assert.equal(scan.error,undefined);assert.equal(scan.cursor,undefined);
  assert.equal(await db.lookups.countDocuments(),1);
});

test('published buttons refresh automatically, retry failure, and follow store disconnection',async()=>{
  await db.panels.updateOne({_id:panel._id},{$set:{messages:[{messageId:'public',channelId:'444'}],revision:1,refreshAt:new Date()}});
  await db.sync.insertOne({_id:'sync',panelId:panel._id,storeId:'store',productId:'product',membership:false,initialComplete:true,startedAt:new Date(),nextAt:new Date(Date.now()+60_000)});
  const h=ui(),bodies:unknown[]=[];
  let failing=true;
  h.api.updatePanel=async(p:Panel,ready=false)=>{if(failing)throw new Failure('discord_unavailable');bodies.push(panelMessage(p,ready));};
  const jobs=new Jobs({}as any,db,service,h.api as any,{}as any);
  await jobs.roles();assert.ok((await service.panel(panel._id)).refreshAt!>new Date());
  failing=false;await db.panels.updateOne({_id:panel._id},{$set:{refreshAt:new Date()}});
  await jobs.roles();assert.equal(bodies.length,1);assert.ok(JSON.stringify(bodies[0]).includes('Sign In with Gumroad'));
  assert.equal((await service.panel(panel._id)).refreshAt,undefined);
  await jobs.roles();assert.equal(bodies.length,1,'unchanged panels are not edited');
  await service.disconnect(await service.panel(panel._id),'gumroad');await jobs.roles();
  assert.equal(bodies.length,2);assert.ok(!JSON.stringify(bodies[1]).includes('Sign In with Gumroad'));
});

test('background refresh removes only deleted copies and still updates other channels after a failure',async()=>{
  const messages=[{channelId:'444',messageId:'deleted'},{channelId:'555',messageId:'retry'},{channelId:'666',messageId:'healthy'}];
  await db.panels.updateOne({_id:panel._id},{$set:{messages,refreshAt:new Date(),revision:1}});
  const h=ui(),updated:string[]=[];
  let failing=true;
  h.api.updatePanel=async(_panel:Panel,_ready:boolean,location:Panel['messages'][number])=>{
    if(location.messageId==='deleted')throw new Failure('message_missing');
    if(location.messageId==='retry'&&failing)throw new Failure('discord_unavailable');
    updated.push(location.messageId);
  };
  const jobs=new Jobs({} as any,db,service,h.api as any);
  await jobs.roles();
  assert.deepEqual(updated,['healthy']);
  assert.deepEqual((await service.panel(panel._id)).messages,messages.slice(1));
  assert.ok((await service.panel(panel._id)).refreshAt!>new Date());
  failing=false;await db.panels.updateOne({_id:panel._id},{$set:{refreshAt:new Date()}});
  await jobs.roles();assert.deepEqual(updated,['healthy','retry','healthy']);
  assert.equal((await service.panel(panel._id)).refreshAt,undefined);
});
test('two instances cannot claim the same license for different accounts',async()=>{
  const other=new Service(db,service.providers,discord,secrets);
  const results=await Promise.allSettled([service.claim(panel,'111',entitlement()),other.claim(panel,'222',entitlement())]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(await db.claims.countDocuments(),1);assert.equal(await db.bindings.countDocuments(),1);
  assert.equal(await db.members.countDocuments({dirty:true}),1);
});
test('role reconciliation retries after crash and retains a shared role until all claims end',async()=>{
  await service.claim(panel,'111',entitlement());
  await service.claim(panel,'111',{...entitlement(),entitlementId:'license:two',referenceId:'sale-2'});
  await service.reconcile(await memberOf('111'));assert.equal(added,1);
  await service.reconcile(await memberOf('111'));assert.equal(added,1);
  await db.claims.updateOne({_id:await secrets.hash('claim','store','license:one')},{$set:{eligibility:'ineligible'}});
  await db.dirty('456',await guildOf('111'));await service.reconcile(await memberOf('111'));assert.equal(removed,0);
  await db.claims.updateMany({},{$set:{eligibility:'ineligible'}});
  await db.dirty('456',await guildOf('111'));await service.reconcile(await memberOf('111'));assert.equal(removed,1);
});
test('deletion keeps the claim reserved while Discord cleanup fails, then releases it',async()=>{
  await service.claim(panel,'111',entitlement());await service.reconcile(await memberOf('111'));
  await service.requestDeletion('111');failRemoval=true;
  await assert.rejects(finishAll());
  assert.equal(await db.claims.countDocuments(),1);
  await assert.rejects(service.claim(panel,'222',entitlement()),{message:'claim_taken'});
  failRemoval=false;await finishAll();assert.equal(await db.claims.countDocuments(),0);assert.equal(await db.subjects.countDocuments({_id:await subjectOf('111')}),0);
  await service.claim(panel,'222',entitlement());assert.equal(await db.claims.countDocuments(),1);
});
test('an in-flight verification cannot resurrect a deleted account',async()=>{
  const epoch=await service.subjectEpoch('111','store');
  await service.requestDeletion('111');await finishAll();
  await assert.rejects(service.claim(panel,'111',entitlement(),epoch),{message:'expired'});
  assert.equal(await db.claims.countDocuments(),0);
});
test('failed provider requests do not change entitlement or grant access',async()=>{
  await assert.rejects(service.verifyKey(panel,'111','01234567-89ABCDEF-01234567-89ABCDEF'));
  assert.equal(await db.claims.countDocuments(),0);assert.equal(added,0);
});
test('shared request budgets survive a second application instance',async()=>{
  const a=new Limits(db),b=new Limits(db);
  await a.take('test_shared','store',2);await b.take('test_shared','store',2);
  await assert.rejects(a.take('test_shared','store',2),{message:'rate_limited'});
});
test('buyer-driven requests cannot starve background rechecks',async()=>{
  let requests=0;
  const request=createRequester(db,secrets,new Limits(db),async()=>{requests++;return Response.json({ok:true});});
  for(let n=0;n<20;n++)await request(store,'/sales');
  await assert.rejects(request(store,'/sales'),{message:'rate_limited'});
  await request(store,'/sales',{}, {background:true});
  assert.equal(requests,21);
});
test('background budget cannot consume all interactive capacity',async()=>{
  let requests=0;
  const request=createRequester(db,secrets,new Limits(db),async()=>{requests++;return Response.json({ok:true});});
  const budget=storeDefinition(store.provider).budget;
  for(let n=0;n<budget.background;n++)await request(store,'/sales',{}, {background:true});
  await assert.rejects(request(store,'/sales',{}, {background:true}),{message:'rate_limited'});
  for(let n=0;n<budget.interactive;n++)await request(store,'/sales');
  assert.equal(requests,budget.background+budget.interactive);
});

test('Retry-After cooldown is shared and not shortened across instances',async()=>{
  let calls=0;
  const fetcher=async()=>{calls++;return new Response(null,{status:429,headers:{'retry-after':'7200'}});};
  const one=createRequester(db,secrets,new Limits(db),fetcher),two=createRequester(db,secrets,new Limits(db),fetcher);
  await assert.rejects(one(store,'/sales'),{message:'rate_limited'});
  await assert.rejects(two(store,'/sales'),{message:'rate_limited'});
  assert.equal(calls,1);assert.ok((await db.cooldowns.findOne({_id:store._id}))!.until.getTime()>Date.now()+7190_000);
});
test('provider errors never retain keys, request URLs, or response details',async()=>{
  const request=createRequester(db,secrets,new Limits(db),async()=>{throw new Error('CANARY-RAW-KEY https://provider/sales?license_key=CANARY-RAW-KEY');});
  try{await request(store,'/sales',{license_key:'CANARY-RAW-KEY'});assert.fail();}catch(e){assert.equal((e as Error).message,'provider_unavailable');assert.ok(!String(e).includes('CANARY'));}
  for(const collection of await db.db.collections())assert.ok(!JSON.stringify(await collection.find().toArray()).includes('CANARY'));
});
test('Discord signature, freshness, and replay are verified before work',async()=>{
  const keys=generateKeyPairSync('ed25519');const publicKey=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
  const config={BASE_URL:'http://localhost',DISCORD_PUBLIC_KEY:publicKey,DISCORD_APPLICATION_ID:'123'} as any;
  let count=0;const interactions={prepare:async()=>{count++;return {response:{type:5,data:{flags:64}}};}} as any;
  const app=createServer(config,db,interactions,{register:async()=>{}} as any,secrets,new Limits(db));
  try {
    const body=JSON.stringify({id:'10000001',application_id:'123',type:2,token:'secret',guild_id:'456',member:{user:{id:'111'},permissions:'0'},data:{name:'verification'}});
    const signed=(timestamp:string)=>sign(null,Buffer.from(timestamp+body),keys.privateKey).toString('hex');
    const timestamp=String(Math.floor(Date.now()/1000));
    const inject=(sig:string,time=timestamp)=>app.inject({method:'POST',url:'/interactions',headers:{'content-type':'application/json','x-signature-ed25519':sig,'x-signature-timestamp':time},payload:body});
    assert.equal((await inject('0'.repeat(128))).statusCode,401);
    const old=String(Number(timestamp)-301);assert.equal((await inject(signed(old),old)).statusCode,401);
    assert.equal((await inject(signed(timestamp))).statusCode,200);assert.equal((await inject(signed(timestamp))).statusCode,204);assert.equal(count,1);
  }finally{await app.close();}
});
test('webhooks only enqueue bounded hints and cannot grant roles',async()=>{
  const token='x'.repeat(32);await db.stores.updateOne({_id:'store'},{$set:{webhookHash:await secrets.hash('webhook',token)}});
  const app=createServer({BASE_URL:'http://localhost'} as any,db,{} as any,{register:async()=>{}} as any,secrets,new Limits(db));
  try{
    const response=await app.inject({method:'POST',url:'/webhooks/gumroad/'+token,payload:{sale_id:'sale-1',seller_id:'creator',product_id:'product',email:'CANARY-EMAIL',license_key:'CANARY-KEY',refunded:false}});
    assert.equal(response.statusCode,202);assert.equal(await db.hints.countDocuments(),1);assert.equal(await db.claims.countDocuments(),0);
    const saved=(await db.hints.findOne())!;
    assert.ok(!JSON.stringify(saved).includes('sale-1'));
    assert.ok(!JSON.stringify(saved).includes('CANARY'));
    assert.equal(await secrets.open(saved.reference,saved._id),'sale-1');
    await app.inject({method:'POST',url:'/webhooks/gumroad/'+token,payload:{sale_id:'sale-1',seller_id:'creator',product_id:'product',resource_name:'refund'}});
    assert.equal(await db.hints.countDocuments(),1);assert.equal((await db.hints.findOne())?.pings,2);
    await db.hints.insertMany(await Promise.all(Array.from({length:99},async(_,n)=>({_id:`h${n}`,storeId:'store',reference:await secrets.seal(`r${n}`,`h${n}`),membership:false,pings:1,nextAt:new Date(),expiresAt:new Date(Date.now()+60_000)}))));
    assert.equal((await app.inject({method:'POST',url:'/webhooks/gumroad/'+token,payload:{sale_id:'sale-2',product_id:'product'}})).statusCode,503);
  }finally{await app.close();}
});
test('a ping during processing keeps its hint for another read, and hooks register with PUT',async()=>{
  const methods:string[]=[];let pingDuringRead=true;
  service.providers.request=async(_s,path,_q,options)=>{
    methods.push(`${options?.method??'GET'} ${path}`);
    if(path==='/resource_subscriptions')return options?.method==='PUT'?{success:true,resource_subscription:{id:'rs'}}:{success:true,resource_subscriptions:[]};
    if(pingDuringRead){pingDuringRead=false;await db.hints.updateOne({_id:'hint'},{$inc:{pings:1}});}
    return {success:true,sale:{id:'sale-1',seller_id:'creator',product_id:'product',chargedback:false,access_revoked:false}};
  };
  const jobs=new Jobs({BASE_URL:'https://keyfi.example'} as any,db,service,discord as any);
  await db.hints.insertOne({_id:'hint',storeId:'store',reference:await secrets.seal('sale-1','hint'),membership:false,pings:1,nextAt:new Date(),expiresAt:new Date(Date.now()+60_000)});
  await jobs.providers();assert.equal(await db.hints.countDocuments(),1);
  await jobs.providers();assert.equal(await db.hints.countDocuments(),0);
  await jobs.registerHooks((await db.stores.findOne({_id:'store'}))!);
  assert.ok(methods.includes('PUT /resource_subscriptions'));assert.ok(!methods.includes('POST /resource_subscriptions'));
  const subscribed:string[]=[];
  const off=new Service(db,service.providers,discord,secrets,false);
  off.providers.request=async(_s,_p,query,options)=>{if(options?.method==='PUT')subscribed.push(options.body!.resource_name!);return options?.method==='PUT'?{success:true,resource_subscription:{id:'rs'}}:{success:true,resource_subscriptions:[]};};
  await new Jobs({BASE_URL:'https://keyfi.example'} as any,db,off,discord as any).registerHooks({...(await db.stores.findOne({_id:'store'}))!,webhookResources:[]});
  assert.ok(!subscribed.includes('sale'));assert.ok(subscribed.includes('refund'));
});

test('simultaneous duplicate keys are coalesced across application instances',async()=>{
  let calls=0;let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const providers=new Providers(async()=>{throw new Error('Unexpected API call');},secrets);
  providers.resolve=async()=>{calls++;await pending;return entitlement();};
  const one=new Service(db,providers,discord,secrets),two=new Service(db,providers,discord,secrets);
  const first=one.verifyKey(panel,'111','01234567-89ABCDEF-01234567-89ABCDEF');
  while(!calls)await new Promise(resolve=>setTimeout(resolve,5));
  await assert.rejects(two.verifyKey(panel,'111','01234567-89ABCDEF-01234567-89ABCDEF'),{message:'busy'});
  release();await first;assert.equal(calls,1);
});

test('privacy import fence prevents deleted lookup data from returning',async()=>{
  const jobs=new Jobs({} as any,db,service,discord as any,{} as any);
  const hash=await secrets.hash('gumroad-buyer','store','person');
  await service.linkBuyer('111',hash,await service.subjectEpoch('111','store'),'store');
  await service.requestDeletion('111');
  await Promise.all([finishAll(),jobs.upsertLookups([{_id:'lookup',storeId:'store',productId:'product',referenceId:'sale-1',membership:false,buyerHash:hash}])]);
  assert.equal(await db.lookups.countDocuments(),0);assert.equal(await db.optouts.countDocuments({_id:hash}),1);
  await jobs.upsertLookups([{_id:'lookup',storeId:'store',productId:'product',referenceId:'sale-1',membership:false,buyerHash:hash}]);
  assert.equal(await db.lookups.countDocuments(),0);
});

test('a new role cannot be granted from stale ownership or an unknown recheck',async()=>{
  await service.claim(panel,'111',entitlement());
  await db.claims.updateMany({},{$set:{checkedAt:new Date(Date.now()-60_000)}});
  await assert.rejects(service.reconcile(await memberOf('111')),{message:'unknown'});
  assert.equal(added,0);assert.equal((await db.members.findOne({_id:await memberOf('111')}))?.dirty,true);
});

test('account checks resume at the next entitlement instead of rescanning purchases',async()=>{
  const hash=await secrets.hash('gumroad-buyer','store','buyer');
  await db.sync.insertOne({_id:'sync',panelId:'panel',storeId:'store',productId:'product',membership:false,initialComplete:true,startedAt:new Date(),nextAt:new Date(Date.now()+60_000)});
  const jobs=new Jobs({} as any,db,service,discord as any);
  await jobs.upsertLookups([1,2].map(n=>({_id:`lookup${n}`,storeId:'store',productId:'product',referenceId:`sale${n}`,membership:false,buyerHash:hash})));
  const calls:string[]=[];
  service.providers.readReference=async(_s:Store,id:string)=>{calls.push(id);return {...entitlement(),buyerHash:hash,referenceId:id,entitlementId:id};};
  await service.queueAccount(panel,'111',hash,'token');
  const c=db.db.collection<any>('account_checks');
  const first=await service.accountStep((await c.findOne())!);assert.equal(first.done,false);
  await c.updateOne({},{$set:{cursor:first.cursor,roles:first.roles}});
  const second=await service.accountStep((await c.findOne())!);assert.deepEqual(calls.sort(),['sale1','sale2']);assert.equal(second.done,false);
  await c.updateOne({},{$set:{cursor:second.cursor,roles:second.roles}});
  assert.equal((await service.accountStep((await c.findOne())!)).done,true);
});

test('a copy of the database cannot join one buyer across creators and servers',async()=>{
  const other:Store={...store,_id:'other-store',ownerId:'other-creator'};
  const otherPanel:Panel={...panel,_id:'other-panel',guildId:'999',administrator:'555',stores:{gumroad:'other-store'}};
  await db.stores.insertOne(other);await db.panels.insertOne(otherPanel);
  await service.claim(panel,'111',entitlement());
  await service.claim(otherPanel,'111',{...entitlement(),storeId:'other-store',ownerId:'other-creator',entitlementId:'license:elsewhere'});
  await service.linkBuyer('111',await secrets.hash('gumroad-buyer','store','gum-user'),await service.subjectEpoch('111','store'),'store');
  await service.linkBuyer('111',await secrets.hash('gumroad-buyer','other-store','gum-user'),await service.subjectEpoch('111','other-store'),'other-store');
  // Every identifier stored for the first creator's server, and for the second's.
  const values=async(storeId:string,guildId:string)=>{
    const docs=[...await db.claims.find({storeId}).toArray(),...await db.bindings.find({guildId}).toArray(),...await db.members.find({guildId}).toArray(),
      ...await db.subjects.find({_id:await subjectOf('111',storeId)}).toArray()];
    return new Set(docs.flatMap(d=>Object.values(d)).filter((v):v is string=>typeof v==='string'&&v.length>=32));
  };
  const first=await values('store','456'),second=await values('other-store','999');
  assert.ok(first.size>=4&&second.size>=4);
  assert.deepEqual([...first].filter(v=>second.has(v)),[],'no stored code links the two');
  // The person is still recognized everywhere when present: export and deletion cover both.
  const data=await service.exportSubject('111');
  assert.deepEqual(data.servers.map(s=>s.server).sort(),['456','999']);assert.equal(data.purchases.length,2);
  await service.requestDeletion('111');await finishAll();
  assert.equal(await db.claims.countDocuments(),0);assert.equal(await db.members.countDocuments(),0);assert.equal(await db.subjects.countDocuments(),0);
});
test('stored buyer data never contains a readable Discord ID or purchase ID',async()=>{
  const discordId='987654321012345678';
  await service.claim(panel,discordId,{...entitlement(),entitlementId:'license:LICENSE-CANARY',referenceId:'REFERENCE-CANARY',saleId:'SALE-CANARY'});
  await service.reconcile(await memberOf(discordId));
  assert.equal(roles.get(discordId)?.has('789'),true,'roles still reach the right Discord user');
  const stored=JSON.stringify(await Promise.all(['subjects','claims','bindings','members'].map(n=>db.db.collection(n).find().toArray())));
  for(const canary of [discordId,'LICENSE-CANARY','REFERENCE-CANARY','SALE-CANARY']) assert.ok(!stored.includes(canary),canary);
  const claim=(await db.claims.findOne())!;
  assert.equal((await service.entitlementOf(claim)).referenceId,'REFERENCE-CANARY');
  assert.equal((await service.exportSubject(discordId)).purchases[0]!.saleId,'SALE-CANARY');
  assert.equal(await db.db.collection('__keyVault').countDocuments(),0);
  // An encrypted Discord ID copied onto another member cannot be opened there.
  const member=(await db.members.findOne({_id:await memberOf(discordId)}))!;
  await assert.rejects(secrets.open(member.discord!,await guildOf('111')));
});

test('lookup rows encrypt purchase and sale IDs, and migration converts old rows',async()=>{
  const jobs=new Jobs({} as any,db,service,discord as any);
  const record={_id:'store:license:LOOKUP-CANARY',storeId:'store',productId:'product',referenceId:'REFERENCE-CANARY',saleId:'SALE-CANARY',membership:false,buyerHash:'buyer-hash'};
  await jobs.upsertLookups([record]);
  const saved=(await db.lookups.findOne())!;
  for(const canary of ['LOOKUP-CANARY','REFERENCE-CANARY','SALE-CANARY']) assert.ok(!JSON.stringify(saved).includes(canary),canary);
  assert.deepEqual(JSON.parse(await secrets.open(saved.reference,saved._id)),{referenceId:record.referenceId,saleId:record.saleId});
  await db.db.collection('lookups').insertOne({...record,_id:'legacy:LOOKUP-CANARY'});
  await db.optouts.insertOne({_id:'erased-buyer',createdAt:new Date()});
  await db.db.collection('lookups').insertOne({...record,_id:'legacy:erased',buyerHash:'erased-buyer'});
  await db.db.collection('hints').insertOne({_id:'old-hint',storeId:'store',referenceId:'HINT-CANARY',membership:false,pings:1,nextAt:new Date(),expiresAt:new Date(Date.now()+60_000)});
  await migratePurchaseData(db,secrets);
  await migratePurchaseData(db,secrets);
  assert.equal(await db.lookups.countDocuments(),2);
  assert.equal(await db.db.collection('lookups').countDocuments({referenceId:{$exists:true}}),0);
  assert.equal(await db.db.collection('hints').countDocuments({referenceId:{$exists:true}}),0);
  assert.equal(await secrets.open((await db.hints.findOne({_id:'old-hint'}))!.reference,'old-hint'),'HINT-CANARY');
  for(const canary of ['LOOKUP-CANARY','REFERENCE-CANARY','SALE-CANARY','HINT-CANARY'])
    assert.ok(!JSON.stringify([await db.lookups.find().toArray(),await db.hints.find().toArray()]).includes(canary),canary);
});

test('startup rejects legacy encryption before it can mix incompatible records',async()=>{
  await db.db.collection('__keyVault').insertOne({keyAltNames:['keyfi-data']});
  await assert.rejects(createSecrets(client,'keyfi_test','07'.repeat(32)),{message:'legacy_encryption_requires_migration'});
  assert.equal(await db.db.collection('__keyVault').countDocuments(),1);
});
test('job loops run on one instance at a time, drain on stop, and release their leases',async()=>{
  const make=()=>new Jobs({} as any,db,service,{...discord,call:async()=>[{id:panel.guildId}]} as any);
  const a=make(),b=make();let active=0,peak=0,runs=0;
  for(const jobs of [a,b]) for(const name of ['roles','providers','index','maintenance'] as const)
    (jobs as any)[name]=async()=>{active++;peak=Math.max(peak,active);runs++;await new Promise(resolve=>setTimeout(resolve,150));active--;};
  try{await a.start();await b.start();await new Promise(resolve=>setTimeout(resolve,100));}
  finally{await a.stop(2000);await b.stop(2000);}
  assert.equal(runs,4);assert.equal(peak,4);assert.equal(active,0);
  assert.equal(await db.leases.countDocuments({owner:{$exists:true},expiresAt:{$gt:new Date()}}),0);
});

test('membership tier changes remove the former role and confirmed expiry removes the new role',async()=>{
  const p={...panel,mappings:[{provider:'gumroad' as const,productId:'product',variant:'basic',roleId:'789',label:'Basic'},{provider:'gumroad' as const,productId:'product',variant:'pro',roleId:'790',label:'Pro'}]};
  await db.panels.replaceOne({_id:panel._id},p);
  const base={...entitlement(),membership:true,entitlementId:'subscription:one',variant:'basic'};
  await service.claim(p,'111',base);await service.reconcile(await memberOf('111'));
  await service.claim(p,'111',{...base,variant:'pro',checkedAt:new Date()});await service.reconcile(await memberOf('111'));
  assert.deepEqual([...(roles.get('111')??[])],['790']);
  await db.claims.updateMany({},{$set:{eligibility:'ineligible'}});await db.dirty('456',await guildOf('111'));await service.reconcile(await memberOf('111'));
  assert.equal(roles.get('111')?.size,0);
});

test('OAuth deletion epochs reject a callback that was in flight before erasure',async()=>{
  const epoch=await service.subjectEpoch('111','store');await service.requestDeletion('111');await finishAll();
  await assert.rejects(service.linkBuyer('111',await secrets.hash('gumroad-buyer','store','person'),epoch,'store'),{message:'expired'});
  assert.equal(await db.subjects.countDocuments(),0);
});

test('two panels for the same store reuse one initial product synchronization',async()=>{
  const other={...panel,_id:'panel-two'};await db.panels.insertOne(other);
  await service.addMapping(panel,panel.mappings[0]!);await service.addMapping(other,panel.mappings[0]!);
  assert.equal(await db.sync.countDocuments(),1);
  assert.equal(await service.ready(other),false);
  await db.sync.updateMany({},{$set:{initialComplete:true}});assert.equal(await service.ready(other),true);
  await service.disconnect(panel,'gumroad');assert.equal(await db.sync.countDocuments(),1);
});

test('Discord setup works without OAuth credentials and disabled sign-in creates no flow',async()=>{
  const c={BASE_URL:'http://localhost',DISCORD_APPLICATION_ID:'123'} as any;
  const auth=createAuthentication(c,db,service,discord as any,secrets,new Limits(db));
  const app=createServer(c,db,{} as any,auth,secrets,new Limits(db));
  try {
    assert.equal((await app.inject({url:'/health/ready'})).statusCode,200);
    await assert.rejects(auth.begin(panel,'111','buyer','private-token'),{message:'oauth_not_configured'});
    await assert.rejects(auth.begin(panel,'111','creator','private-token'),{message:'oauth_not_configured'});
    assert.equal(await db.flows.countDocuments(),0);
    const noBuyer=new Service(db,service.providers,discord,secrets,false);
    assert.equal(await noBuyer.ready(panel),false);
  } finally { await app.close(); }
});

for(const startFailure of [false,true])test(startFailure?'OAuth start failures report in Discord before returning':'cancelled creator consent reports in Discord and clears the flow',async()=>{
  const c={BASE_URL:'https://keyfi.example:8443',DISCORD_APPLICATION_ID:'123',DISCORD_CLIENT_SECRET:'discord-secret',GUMROAD_CREATOR_CLIENT_ID:'creator-client',GUMROAD_CREATOR_CLIENT_SECRET:'creator-secret'} as any;
  const replies:string[]=[];
  const api={...discord,reply:async(token:string,copy:string)=>{assert.equal(token,'INTERACTION-CANARY');replies.push(copy);}} as any;
  const limits=new Limits(db),auth=createAuthentication(c,db,service,api,secrets,limits);
  const app=createServer(c,db,{} as any,auth,secrets,limits);
  try {
    const link=await auth.begin(panel,'111','creator','INTERACTION-CANARY','444');
    if(startFailure) limits.take=async()=>{throw new Failure('rate_limited');};
    const start=await app.inject({url:new URL(link).pathname});
    let finish=start;
    if(!startFailure) {
      assert.equal(start.statusCode,302);
      const url=new URL(start.headers.location!);
      assert.equal(url.searchParams.get('scope'),'identify');
      assert.equal(url.searchParams.get('prompt'),'consent');
      finish=await app.inject({url:`/oauth/discord/callback?error=access_denied&state=${url.searchParams.get('state')}`,headers:{cookie:start.cookies.map(c=>`${c.name}=${c.value}`).join('; ')}});
    }
    assert.equal(replies.length,1);
    assert.ok(replies[0]!.includes(startFailure?'Try again shortly':'Sign-in didn’t finish'));
    assert.equal(finish.body,closeDocument('456','444'));
    assert.equal(await db.flows.countDocuments(),0);
  } finally { await app.close(); }
});

for(const scenario of ['buyer','creator','forwarded'])test(scenario==='forwarded'?'forwarded OAuth link cannot link another Discord identity':`Fastify OAuth ${scenario} callbacks use minimal scopes and retain no temporary profile`,async()=>{
  const forwarded=scenario==='forwarded',creator=scenario==='creator';
  const config={BASE_URL:'https://keyfi.example:8443',DISCORD_APPLICATION_ID:'123',DISCORD_CLIENT_SECRET:'discord-secret',GUMROAD_BUYER_CLIENT_ID:'buyer-client',GUMROAD_BUYER_CLIENT_SECRET:'buyer-secret',GUMROAD_CREATOR_CLIENT_ID:'creator-client',GUMROAD_CREATOR_CLIENT_SECRET:'creator-secret'} as any;
  const replies:string[]=[];
  const api={...discord,reply:async(_token:string,copy:string)=>{replies.push(copy);}} as any;
  const limits=new Limits(db),auth=createAuthentication(config,db,service,api,secrets,limits);
  const app=createServer(config,db,{} as any,auth,secrets,limits);
  const discordToken=nock('https://discord.com').post('/api/oauth2/token').reply(200,{access_token:'DISCORD-CANARY-TOKEN',token_type:'Bearer',expires_in:600,scope:'identify'});
  const gumroadToken=forwarded?null:nock('https://api.gumroad.com').post('/oauth/token').reply(200,{access_token:'GUMROAD-CANARY-TOKEN',token_type:'Bearer',expires_in:600,scope:'view_profile'});
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const url=String(input instanceof Request?input.url:input);
    if(url==='https://discord.com/api/v10/users/@me')return Response.json({id:forwarded?'222':'111',username:'PERSONAL-CANARY',discriminator:'0',avatar:null,email:'PERSONAL-CANARY@example.com',verified:true});
    if(url==='https://api.gumroad.com/v2/user')return Response.json({success:true,user:{user_id:'gum-buyer',name:'PERSONAL-CANARY',email:'PERSONAL-CANARY@example.com'}});
    throw new Error('Unexpected OAuth endpoint');
  };
  const jar=new Map<string,string>();
  const request=async(url:string)=>{
    const res=await app.inject({method:'GET',url:new URL(url,config.BASE_URL).pathname+new URL(url,config.BASE_URL).search,headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')}});
    for(const cookie of res.cookies){if(cookie.value)jar.set(cookie.name,cookie.value);else jar.delete(cookie.name);}
    return res;
  };
  try{
    if(creator) {
      await db.panels.updateOne({_id:panel._id},{$set:{administrator:'111',stores:{}}});
      await db.setupViews.insertOne({_id:panel._id,discordId:'111',guildId:panel.guildId,token:await secrets.seal('INTERACTION-CANARY',`setup:${panel._id}`),version:'view',signature:'pending',waitingForOAuth:true,expiresAt:new Date(Date.now()+600_000)});
    }
    const link=await auth.begin(panel,'111',creator?'creator':'buyer','INTERACTION-CANARY','444');
    const start=await request(link);assert.equal(start.statusCode,302);
    const discordUrl=new URL(start.headers.location!);
    assert.equal(discordUrl.searchParams.get('scope'),'identify');
    assert.equal(discordUrl.searchParams.get('prompt'),'consent');
    assert.ok(start.cookies.some(cookie=>cookie.secure&&cookie.httpOnly));
    assert.ok(discordUrl.searchParams.get('state'));
    assert.equal((await app.inject({url:`/oauth/discord/callback?code=forged&state=${discordUrl.searchParams.get('state')}`})).statusCode,400);
    assert.equal(await db.flows.countDocuments(),1);
    const callback=await request(`${discordUrl.searchParams.get('redirect_uri')}?code=discord-code&state=${discordUrl.searchParams.get('state')}`);
    assert.equal(callback.statusCode,forwarded?200:302,callback.body);
    assert.ok(discordToken.isDone());
    if(forwarded){
      assert.equal(callback.body,closeDocument('456','444'));
      assert.equal(await db.db.collection('account_checks').countDocuments(),0);
      assert.equal(await db.flows.countDocuments(),0);assert.ok(replies.some(s=>s.includes('Discord account')));
      return;
    }
    const linked=await request(callback.headers.location!);
    assert.equal(linked.statusCode,302,linked.body);
    const gumUrl=new URL(linked.headers.location!);
    assert.equal(gumUrl.origin,'https://gumroad.com');assert.equal(gumUrl.searchParams.get('scope'),creator?'view_profile view_sales':'view_profile');
    assert.equal(gumUrl.searchParams.get('redirect_uri'),`${config.BASE_URL}/api/auth/callback/gumroad-${creator?'creator':'buyer'}`);
    assert.ok(gumUrl.searchParams.get('code_challenge'));
    const finish=await request(`${gumUrl.searchParams.get('redirect_uri')}?code=gum-code&state=${gumUrl.searchParams.get('state')}`);
    assert.equal(finish.statusCode,200,finish.body);assert.equal(finish.body,closeDocument('456','444'));
    assert.ok(gumroadToken?.isDone());
    assert.ok(String(finish.headers['content-security-policy']).includes(`'sha256-${closeScriptHash}'`));
    assert.ok(!String(finish.headers['content-security-policy']).includes('unsafe-inline'));
    assert.equal((await request('/close.js')).statusCode,404);
    assert.equal(replies.length,0,'successful completion never waits for a Discord notification');
    assert.equal(await db.flows.countDocuments(),0);assert.equal(await db.db.collection('account_checks').countDocuments(),creator?0:1);
    if(creator) {
      const connected=await db.stores.findOne({ownerId:'gum-buyer'});assert.ok(connected);assert.ok(!JSON.stringify(connected).includes('GUMROAD-CANARY-TOKEN'));
      assert.equal((await db.catalogJobs.findOne({_id:connected._id}))?.syncing,true);
      const view=await db.setupViews.findOne({_id:panel._id});assert.equal(view?.waitingForOAuth,undefined);assert.equal(view?.signature,'');
    } else assert.equal((await db.subjects.findOne({_id:await subjectOf('111')}))?.gumroadHash,await secrets.hash('gumroad-buyer','store','gum-buyer'));
    assert.equal((await request(link)).statusCode,400);
  }finally{globalThis.fetch=oldFetch;nock.cleanAll();await app.close();}
});

test('callback returns to the triggering channel in the app or web',()=>{
  assert.equal(closeScriptHash,createHash('sha256').update(closeScript).digest('base64'));
  assert.ok(closeDocument('456','444').includes('data-web="https://discord.com/channels/456/444" data-app="discord://-/channels/456/444"'));
  assert.ok(closeDocument().includes('data-web="https://discord.com/channels/@me" data-app="discord://"'));
  assert.ok(!closeDocument('456','444').includes('Continue in Discord'));
  assert.equal(closeDocument('456','<script>'),closeDocument());
  for(const visibilityState of ['visible','hidden']) {
    const events:string[]=[],timers:(()=>void)[]=[];
    const location={set href(url:string){events.push(url);},replace(url:string){events.push(url);}};
    const dataset={web:'https://discord.com/channels/456/444',app:'discord://-/channels/456/444'};
    runInNewContext(closeScript,{location,document:{visibilityState,body:{dataset}},setTimeout:(fn:()=>void,delay:number)=>{assert.equal(delay,1500);timers.push(fn);}});
    assert.deepEqual(events,['discord://-/channels/456/444']);
    timers.forEach(fn=>fn());
    assert.deepEqual(events,visibilityState==='visible'?['discord://-/channels/456/444','https://discord.com/channels/456/444']:['discord://-/channels/456/444']);
  }
  const events:string[]=[];
  runInNewContext(closeScript,{location:{set href(_url:string){throw new Error('blocked');},replace(url:string){events.push(url);}},document:{body:{dataset:{web:'https://discord.com/channels/456/444',app:'discord://-/channels/456/444'}}},setTimeout:()=>assert.fail('no timeout after a blocked URI')});
  assert.deepEqual(events,['https://discord.com/channels/456/444']);
});

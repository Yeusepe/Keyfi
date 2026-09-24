import test from 'node:test';
import assert from 'node:assert/strict';
import { Providers } from '../src/providers.js';
import { Secrets, Failure } from '../src/security.js';
import type { Panel, Store } from '../src/model.js';
import type { Requester } from '../src/http.js';

export const secrets=new Secrets('07'.repeat(32));
const gumKey='01234567-89ABCDEF-01234567-89ABCDEF';
const jinxKey='550e8400-e29b-41d4-a716-446655440000';
export const store:Store={_id:'gum',provider:'gumroad',ownerId:'creator',credential:'encrypted',administrator:'123',status:'active',createdAt:new Date()};
export const sale={id:'sale-1',seller_id:'creator',product_id:'product-1',purchaser_id:'buyer-1',license_key:gumKey,license_id:'license-1',license_disabled:false,refunded:false,partially_refunded:false,chargedback:false,access_revoked:false};
const license={id:'license-2',key:jinxKey,short_key:'ABCD-446655440000',inventory_item:{target_id:'product-2',target_version_id:'version-1',target_type:'PRODUCT',grant_type:'ORDER_ITEM',item:{object:'PurchasedProduct',id:'product-2',version:{id:'version-1',name:'Premium'}},order:{id:'order-1',payment_status:'PAID'}}};
export const panel:Panel={_id:'panel',guildId:'456',administrator:'123',stores:{gumroad:'gum',jinxxy:'jinx'},mappings:[],messages:[],active:true,createdAt:new Date()};
const jinxStore:Store={...store,_id:'jinx',provider:'jinxxy',ownerId:'jinx-creator'};

test('unseen Gumroad keys take one request for 10 and 10,000 products',async()=>{
  for(const productCount of [10,10_000]) {
    const calls:string[]=[];
    const request:Requester=async(s,path,query)=>{calls.push(path);assert.equal(s._id,'gum');assert.equal(query?.license_key,gumKey);return {success:true,sales:[sale]};};
    const providers=new Providers(request,secrets);
    const p={...panel,mappings:Array.from({length:productCount},(_,n)=>({provider:'gumroad' as const,productId:`product-${n}`,roleId:`role-${n}`,label:`Product ${n}`}))};
    const result=await providers.resolve(p,[store,jinxStore],productCount===10000?gumKey.toLowerCase():gumKey);
    assert.equal(result?.productId,'product-1');assert.equal(result?.eligibility,'eligible');assert.deepEqual(calls,['/sales']);
    assert.ok(!JSON.stringify(result).includes(gumKey));
  }
});
test('unseen Jinxxy keys take two requests with 10 or 10,000 catalog products',async()=>{
  for(const count of [10,10_000]) {
  const calls:string[]=[];
  const providers=new Providers(async(s,path,query)=>{
    calls.push(path);assert.equal(s._id,'jinx');
    if(path==='/licenses'){assert.equal(query?.key,jinxKey);return {page_count:1,results:[{id:'license-2'}]};}
    return license;
  },secrets);
  const p={...panel,mappings:Array.from({length:count},(_,n)=>({provider:'jinxxy' as const,productId:`product-${n}`,roleId:`role-${n}`,label:`Product ${n}`}))};
  const result=await providers.resolve(p,[store,jinxStore],jinxKey);
  assert.equal(result?.variant,'version-1');assert.equal(result?.eligibility,'eligible');assert.deepEqual(calls,['/licenses','/licenses/license-2']);
  }
});
test('invalid keys never scan products or unrelated stores',async()=>{
  const calls:string[]=[];
  const providers=new Providers(async(s,path)=>{calls.push(s._id+path);return {success:true,sales:[]};},secrets);
  assert.equal(await providers.resolve(panel,[store,{...store,_id:'unrelated'},jinxStore],gumKey),null);
  assert.deepEqual(calls,['gum/sales']);
});
test('unrecognized syntax is bounded to the panel’s two stores',async()=>{
  let count=0;
  const providers=new Providers(async(s)=>{count++;return s.provider==='gumroad'?{success:true,sales:[]}:{page_count:0,results:[]};},secrets);
  assert.equal(await providers.resolve(panel,[store,jinxStore,{...store,_id:'unrelated'}],'custom-key-value'),null);
  assert.equal(count,2);
});
test('Jinxxy rejects ambiguous or mismatched keys',async()=>{
  const ambiguous=new Providers(async()=>({page_count:1,results:[{id:'a'},{id:'b'}]}),secrets);
  await assert.rejects(ambiguous.get('jinxxy').key(jinxStore,'ABCD-446655440000'),{message:'ambiguous_key'});
  const mismatch=new Providers(async(_s,path)=>path==='/licenses'?{page_count:1,results:[{id:license.id}]}:license,secrets);
  await assert.rejects(mismatch.get('jinxxy').key(jinxStore,'WRONG'),{message:'key_mismatch'});
});

test('Jinxxy eligibility uses payment status and missing licenses remain ineligible',async()=>{
  for(const [status,expected] of [['PAID','eligible'],['REFUNDED','ineligible'],['PARTIALLY_REFUNDED','unknown'],['UNRECOGNIZED','unknown']]) {
    const providers=new Providers(async()=>({...license,inventory_item:{...license.inventory_item,order:{...license.inventory_item.order,payment_status:status}}}),secrets);
    assert.equal((await providers.readReference(jinxStore,license.id)).eligibility,expected);
  }
  const providers=new Providers(async()=>license,secrets),current=await providers.readReference(jinxStore,license.id);
  providers.request=async()=>{throw new Failure('provider_not_found');};
  assert.equal((await providers.recheck(jinxStore,current)).eligibility,'ineligible');
  providers.request=async()=>{throw new Failure('store_reconnect');};
  await assert.rejects(providers.recheck(jinxStore,current),{message:'store_reconnect'});
});
test('refund and disabled-key states are ineligible; partial refunds keep existing access',async()=>{
  for(const field of ['refunded','license_disabled','access_revoked','chargedback']){
    const p=new Providers(async()=>({success:true,sales:[{...sale,[field]:true}]}),secrets);
    assert.equal((await p.get('gumroad').key(store,gumKey))?.eligibility,'ineligible');
  }
  const p=new Providers(async()=>({success:true,sales:[{...sale,partially_refunded:true}]}),secrets);
  assert.equal((await p.get('gumroad').key(store,gumKey))?.eligibility,'eligible');
});
test('future membership cancellation keeps access and license verification never increments uses',async()=>{
  let calls=0;
  const providers=new Providers(async(_s,path,_query,options)=>{
    calls++;
    if(path.startsWith('/subscribers/'))return {success:true,subscriber:{id:'sub',product_id:'product-1',user_id:'buyer-1',purchase_ids:['sale-1'],status:'pending_cancellation',cancelled_at:new Date(Date.now()+86400_000).toISOString(),license_key:gumKey}};
    assert.equal(options?.body?.increment_uses_count,'false');return {success:true,purchase:{product_id:'product-1',seller_id:'creator',refunded:false,variants:{Tier:'Premium'}}};
  },secrets);
  const result=await providers.readReference(store,'sub',true);
  assert.equal(result.eligibility,'eligible');assert.equal(result.entitlementId,'subscription:sub');assert.equal(calls,2);
});
test('authenticated provider identity and required eligibility fields cannot be omitted',async()=>{
  const wrong=new Providers(async()=>({success:true,sales:[{...sale,seller_id:'another-creator'}]}),secrets);
  await assert.rejects(wrong.get('gumroad').key(store,gumKey),{message:'store_mismatch'});
  const broken=new Providers(async()=>({success:true,sales:[{id:'x',product_id:'y'}]}),secrets);
  await assert.rejects(broken.get('gumroad').key(store,gumKey),{message:'provider_schema'});
});
test('encryption binds credentials to their connection and detects tampering',async()=>{
  const value=await secrets.seal('canary-credential','store-a');
  assert.equal(await secrets.open(value,'store-a'),'canary-credential');
  await assert.rejects(secrets.open(value,'store-b'));
  const bytes=Buffer.from(value.slice(3),'base64url');
  for(const index of [0,12,28]) {
    const damaged=Buffer.from(bytes);damaged[index]^=1;
    await assert.rejects(secrets.open('v1.'+damaged.toString('base64url'),'store-a'));
  }
  assert.notEqual(await secrets.seal('canary-credential','store-a'),value);
  assert.equal(await new Secrets('07'.repeat(32)).open(value,'store-a'),'canary-credential');
  await assert.rejects(new Secrets('08'.repeat(32)).open(value,'store-a'));
  for(const malformed of ['', 'v1.AA', 'v2.'+value.slice(3)]) await assert.rejects(secrets.open(malformed,'store-a'));
  assert.equal(await secrets.open(await secrets.seal('🔐 café',''),''),'🔐 café');
  assert.equal(await secrets.open(await secrets.seal('','store-a'),'store-a'),'');
  assert.ok(!value.includes('canary-credential'));
});

test('local keys are validated and buyer codes stay stable, scoped, and unambiguous',async()=>{
  for(const key of ['', '07'.repeat(31), 'gg'.repeat(32), '07'.repeat(33)]) assert.throws(()=>new Secrets(key));
  const code=await secrets.subject('123','store:a');
  assert.equal(await new Secrets('07'.repeat(32)).subject('123','store:a'),code);
  assert.notEqual(await secrets.subject('123','store:b'),code);
  assert.notEqual(await new Secrets('08'.repeat(32)).subject('123','store:a'),code);
  assert.notEqual(await secrets.hash('a','b:c'),await secrets.hash('a:b','c'));
});
test('relocated membership keys resolve through the license endpoint without a stored key index',async()=>{
  for(const current of [gumKey,'FFFFFFFF-89ABCDEF-01234567-89ABCDEF']) {
    const calls:string[]=[];
    const providers=new Providers(async(_s,path,_q,options)=>{
      calls.push(`${path}${options?.body?.product_id?':'+options.body.product_id:''}`);
      if(path==='/licenses/verify'&&options?.body?.product_id==='m1')throw new Failure('provider_not_found');
      if(path==='/licenses/verify')return {success:true,purchase:{product_id:'m2',seller_id:'creator',subscription_id:'sub-1',variants:{Tier:'Gold'}}};
      if(path==='/subscribers/sub-1')return {success:true,subscriber:{id:'sub-1',product_id:'m2',user_id:'buyer-1',purchase_ids:['p1'],status:'alive',license_key:current}};
      throw new Error('unexpected '+path);
    },secrets);
    if(current===gumKey){
      const e=await providers.get('gumroad').membershipKey!(store,['m1','m2'],gumKey);
      assert.equal(e?.entitlementId,'subscription:sub-1');assert.equal(e?.eligibility,'eligible');
      assert.deepEqual(calls,['/licenses/verify:m1','/licenses/verify:m2','/subscribers/sub-1','/licenses/verify:m2']);
    } else await assert.rejects(providers.get('gumroad').membershipKey!(store,['m1','m2'],gumKey),{message:'key_not_found'});
  }
});

import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { z } from 'zod';
import type { Database } from '../db.js';
import { parse } from '../http.js';
import type { Entitlement, Store } from '../model.js';
import { Failure, productNameKey, same, type Secrets } from '../security.js';
import type { StoreDefinition } from './contract.js';

export function payhipProductId(input: string): string {
  let value=input.trim();
  if(value.startsWith('https://')) {
    let url: URL; try { url=new URL(value); } catch { throw new Failure('payhip_product'); }
    if(url.hostname!=='payhip.com' || url.port || url.username || url.password || !/^\/b\/[^/]+\/?$/.test(url.pathname)) throw new Failure('payhip_product');
    value=url.pathname.split('/')[2]!;
  }
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Failure('payhip_product');
  return value;
}
export const payhipLicenseHash = (secrets: Secrets, storeId: string, productId: string, key: string) => secrets.hash('payhip-license',storeId,productId,key);
const license = z.object({data:z.object({enabled:z.boolean(), product_link:z.string(), license_key:z.string().min(1).max(100), variant_id:z.union([z.string(),z.number()]).nullish()})});
export const payhip: StoreDefinition = {
  id:'payhip', name:'Payhip',
  connection:{type:'api-key',description:'Your Payhip account API key authenticates refund webhooks. Product secrets are added next.'},
  productSecrets:true, eventDriven:true,
  apiBase:'https://payhip.com/api/v2', headers:token=>({'product-secret-key':token}),
  budget:{total:90,interactive:75,background:15}, maxResponseBytes:()=>32_768,
  // Custom Payhip keys have no reliable format; always try mapped Payhip products.
  matchesKey:()=>false,
  create:({request,secrets,catalog})=>({
    async key(store,key,productIds=[]) {
      if(key.length>100) return null;
      const found: Entitlement[]=[];
      for(const productId of productIds) {
        const product=await catalog(store._id,productId);
        if(!product?.credential) throw new Failure('payhip_product_secret');
        let response: unknown;
        try { response=await request(store,'/license/verify',{license_key:key},{credential:{value:product.credential,context:product._id},allowEmpty:true}); }
        catch(e) { if(e instanceof Failure && e.code==='store_reconnect') throw new Failure('payhip_product_secret'); throw e; }
        if(response===null) continue;
        const {data}=parse(license,response);
        if(payhipProductId(data.product_link)!==productId || data.license_key!==key) throw new Failure('provider_schema');
        const keyHash=await payhipLicenseHash(secrets,store._id,productId,key);
        found.push({provider:'payhip',storeId:store._id,ownerId:store.ownerId,entitlementId:keyHash,referenceId:keyHash,keyHash,
          productId,variant:data.variant_id==null?undefined:String(data.variant_id),membership:false,
          eligibility:data.enabled?'eligible':'ineligible',checkedAt:new Date()});
      }
      if(found.length>1) throw new Failure('ambiguous_key');
      return found[0]??null;
    },
    async versions(_store,product) { return product.variants; },
  }),
};

// Both verification and revocation write the store in their transaction. This
// fences a successful v2 response against a refund arriving before claim storage.
export async function revokePayhipClaim(db: Database, storeId: string, claimId: string, reason: 'refund'|'manual', session: ClientSession) {
  if(!(await db.stores.updateOne({_id:storeId,provider:'payhip',status:'active'},{$inc:{revision:1}},{session})).matchedCount) throw new Failure('store_disconnected');
  await db.revocations.updateOne({_id:claimId},{$setOnInsert:{storeId,reason,createdAt:new Date()}},{upsert:true,session});
  await db.claims.updateOne({_id:claimId,storeId},{$set:{eligibility:'ineligible'},$unset:{nextCheckAt:''}},{session});
  for(const binding of await db.bindings.find({claimId},{session}).toArray()) await db.dirty(binding.guildId,binding.subject,session);
}

const webhook = z.object({
  id:z.string().min(1).max(200), type:z.enum(['paid','refunded']),
  price:z.number().nonnegative().optional(), amount_refunded:z.number().nonnegative().optional(),
  items:z.array(z.object({product_key:z.string().min(1).max(100),product_name:z.string().min(1).max(500),license_key:z.string().min(1).max(100).nullish()})).min(1).max(100),
});
export async function receivePayhip(db: Database, secrets: Secrets, store: Store, body: unknown) {
  const signature=z.object({signature:z.string().regex(/^[a-f\d]{64}$/i)}).safeParse(body);
  // Payhip signs with SHA256(account API key), not an HMAC of the body.
  const expected=createHash('sha256').update(await secrets.open(store.credential,store._id)).digest('hex');
  if(!signature.success || !same(signature.data.signature.toLowerCase(),expected)) throw new Failure('webhook_signature');
  const event=parse(webhook,body);
  const fullRefund=event.type==='refunded' && event.price!==undefined && event.amount_refunded===event.price;
  const review=event.type==='refunded' && (!fullRefund || event.items.some(item=>!item.license_key));
  await db.transaction(async session=>{
    // Comparing the credential also rejects an in-flight event after key rotation.
    if(!(await db.stores.updateOne({_id:store._id,status:'active',credential:store.credential},{$set:{webhookReceivedAt:new Date(),...(review?{webhookReview:true}:{})},$inc:{revision:1}},{session})).matchedCount) throw new Failure('store_disconnected');
    for(const item of event.items) {
      const productId=payhipProductId(item.product_key), productIdInDb=`${store._id}:${productId}`;
      await db.catalog.updateOne({_id:productIdInDb},{$set:{name:item.product_name,nameKey:productNameKey(item.product_name),fetchedAt:new Date()},
        $setOnInsert:{storeId:store._id,productId,membership:false,licensed:true,variants:[]}},{upsert:true,session});
      if(fullRefund && item.license_key) {
        const hash=await payhipLicenseHash(secrets,store._id,productId,item.license_key);
        await revokePayhipClaim(db,store._id,await secrets.hash('claim',store._id,hash),'refund',session);
      }
    }
  });
}

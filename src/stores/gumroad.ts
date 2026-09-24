import { z } from 'zod';
import { parse } from '../http.js';
import { Failure, normalizeKey, same } from '../security.js';
import type { CatalogProduct, Entitlement, Lookup, Store } from '../model.js';
import type { AdapterContext, StoreAdapter, StoreDefinition } from './contract.js';
const sid = z.string().min(1).max(256);
const variants = z.record(z.string(), z.string());
const saleSchema = z.object({
  id: sid, seller_id: sid, product_id: sid, purchaser_id: sid.nullish(),
  license_id: sid.optional(), license_key: z.string().optional(), license_disabled: z.boolean().optional(),
  refunded: z.boolean().optional(), partially_refunded: z.boolean().optional(), chargedback: z.boolean(),
  access_revoked: z.boolean(), disputed: z.boolean().optional(), dispute_won: z.boolean().optional(),
  subscription_id: sid.optional(), variants: variants.optional(), is_gift_sender_purchase: z.boolean().optional(),
});
type Sale = z.infer<typeof saleSchema>;
const subscriberSchema = z.object({
  id: sid, product_id: sid, user_id: sid.nullish(), purchase_ids: z.array(sid),
  status: z.string(), license_key: z.string().optional(),
  cancelled_at: z.string().nullish(), failed_at: z.string().nullish(), ended_at: z.string().nullish(),
});
const variantKey = (value: Record<string,string> = {}) => JSON.stringify(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)));
const normalize = (value: string) => { const key=normalizeKey(value); return /^[a-f\d]{8}(?:-[a-f\d]{8}){3}$/i.test(key)?key.toUpperCase():key; };
export class Gumroad implements StoreAdapter {
  hooks = {
    list: async (store:Store,resource:string,url:string) => {
      const result=parse(z.object({success:z.literal(true),resource_subscriptions:z.array(z.object({id:z.string(),post_url:z.string()}))}),await this.request(store,'/resource_subscriptions',{resource_name:resource,current_oauth_application_only:'true'},{background:true}));
      return result.resource_subscriptions.filter(s=>s.post_url===url).map(s=>s.id);
    },
    create: async (store:Store,resource:string,url:string) => parse(z.object({success:z.literal(true),resource_subscription:z.object({id:z.string()})}),await this.request(store,'/resource_subscriptions',{}, {method:'PUT',background:true,body:{resource_name:resource,post_url:url}})).resource_subscription.id,
    remove: async (store:Store,id:string) => { await this.request(store,`/resource_subscriptions/${encodeURIComponent(id)}`,{}, {method:'DELETE',background:true}); },
  };
  constructor(private context: AdapterContext) {}
  private get request() { return this.context.request; }
  private get secrets() { return this.context.secrets; }
  private catalog(storeId:string,productId:string) { return this.context.catalog(storeId,productId); }
  private async fromSale(store: Store, sale: Sale): Promise<Entitlement> {
    if (sale.seller_id !== store.ownerId) throw new Failure('store_mismatch');
    const revoked = sale.refunded || sale.chargedback || sale.access_revoked || sale.license_disabled === true;
    const uncertain = (sale.disputed && !sale.dispute_won) || (sale.license_key && sale.license_disabled === undefined);
    return {
      provider: 'gumroad', storeId: store._id, ownerId: store.ownerId,
      entitlementId: sale.subscription_id ? `subscription:${sale.subscription_id}` : sale.license_id ? `license:${sale.license_id}` : `sale:${sale.id}`,
      referenceId: sale.subscription_id ?? sale.id, saleId: sale.id,
      productId: sale.product_id, variant: variantKey(sale.variants), membership: !!sale.subscription_id,
      eligibility: revoked ? 'ineligible' : uncertain ? 'unknown' : 'eligible', checkedAt: new Date(),
      buyerHash: sale.purchaser_id && !sale.is_gift_sender_purchase ? await this.secrets.hash('gumroad-buyer', store._id, sale.purchaser_id) : undefined,
      keyHash: sale.license_key ? await this.secrets.hash('license-key', store._id, normalize(sale.license_key)) : undefined,
    };
  }
  async key(store: Store, key: string): Promise<Entitlement | null> {
    const result = parse(z.object({success: z.literal(true), sales: z.array(saleSchema), next_page_key: z.string().optional()}), await this.request(store, '/sales', {license_key: key}));
    if (!result.sales.length) return null;
    const matches = result.sales.filter(s => s.license_key && same(normalize(s.license_key), normalize(key)));
    if (matches.length>1 && matches[0]?.subscription_id && matches.every(s=>s.subscription_id===matches[0]!.subscription_id && s.seller_id===store.ownerId))
      return this.membership(store,matches[0]!.subscription_id,await this.fromSale(store,matches[0]!),false);
    if (result.next_page_key || matches.length !== 1) throw new Failure('ambiguous_key');
    const entitlement = await this.fromSale(store, matches[0]!);
    if (entitlement.membership) return this.membership(store, entitlement.referenceId, entitlement, false);
    return entitlement;
  }
  // ponytail: one request per mapped membership product; batch if panels map many.
  async membershipKey(store: Store, productIds: string[], key: string): Promise<Entitlement | null> {
    for (const productId of productIds) {
      let raw: unknown;
      try { raw = await this.request(store, '/licenses/verify', {}, {method: 'POST', body: {product_id: productId, license_key: key, increment_uses_count: 'false'}}); }
      catch(error) { if (error instanceof Failure && error.code === 'provider_not_found') continue; throw error; }
      const verified = parse(z.object({success: z.boolean(), purchase: z.object({product_id: sid, seller_id: sid, subscription_id: sid.nullish()}).optional()}), raw);
      if (!verified.success || !verified.purchase?.subscription_id) continue;
      if (verified.purchase.product_id !== productId || verified.purchase.seller_id !== store.ownerId) throw new Failure('store_mismatch');
      const e = await this.membership(store, verified.purchase.subscription_id);
      // The subscription's current key must be this key; a replaced key grants nothing.
      if (e.eligibility === 'eligible' && e.keyHash !== await this.secrets.hash('license-key', store._id, key)) throw new Failure('key_not_found');
      return e;
    }
    return null;
  }
  async sale(store: Store, referenceId: string, background = false): Promise<Entitlement> {
    const result = parse(z.object({success: z.literal(true), sale: saleSchema}), await this.request(store, `/sales/${encodeURIComponent(referenceId)}`, {}, {background}));
    if (result.sale.id !== referenceId) throw new Failure('provider_schema');
    const e = await this.fromSale(store, result.sale);
    return e.membership ? this.membership(store, e.referenceId, e, background) : e;
  }
  async membership(store: Store, referenceId: string, previous?: Entitlement, background = false): Promise<Entitlement> {
    const raw = parse(z.object({success: z.literal(true), subscriber: subscriberSchema.optional(), subscribers: subscriberSchema.optional()}), await this.request(store, `/subscribers/${encodeURIComponent(referenceId)}`, {}, {background}));
    const sub = raw.subscriber ?? raw.subscribers;
    if (!sub || sub.id !== referenceId || (previous && previous.productId !== sub.product_id)) throw new Failure('provider_schema');
    const dates = [sub.cancelled_at, sub.failed_at, sub.ended_at].filter((d): d is string => !!d).map(d => Date.parse(d));
    if (dates.some(Number.isNaN)) throw new Failure('provider_schema');
    const terminal = dates.some(d => d <= Date.now()) || ['failed_payment', 'fixed_subscription_period_ended'].includes(sub.status);
    const alive = ['alive', 'payment_method_update_required', 'pending_cancellation', 'pending_failure'].includes(sub.status);
    const e: Entitlement = {...previous, provider: 'gumroad', storeId: store._id, ownerId: store.ownerId,
      entitlementId: `subscription:${sub.id}`, referenceId: sub.id, productId: sub.product_id, membership: true,
      buyerHash: sub.user_id ? await this.secrets.hash('gumroad-buyer', store._id, sub.user_id) : undefined,
      checkedAt: new Date(), eligibility: terminal ? 'ineligible' : alive ? 'eligible' : 'unknown',
      validUntil: dates.length ? new Date(Math.min(...dates)) : undefined};
    if (e.eligibility !== 'eligible') return e;
    if (!sub.license_key) return {...e, eligibility: 'unknown'};
    let verification: unknown;
    try { verification = await this.request(store, '/licenses/verify', {}, {method: 'POST', background, body: {product_id: sub.product_id, license_key: sub.license_key, increment_uses_count: 'false'}}); }
    catch(error) { if(error instanceof Failure && error.code==='provider_not_found') return {...e,eligibility:'ineligible'}; throw error; }
    const verified = parse(z.object({success: z.boolean(), purchase: z.object({product_id: sid, seller_id: sid,
      refunded: z.boolean().optional(), chargebacked: z.boolean().optional(), chargedback: z.boolean().optional(),
      variants: z.union([variants, z.string(), z.array(z.string())]).optional()}).optional()}),
      verification);
    if (!verified.success || !verified.purchase) return {...e, eligibility: 'ineligible'};
    const p = verified.purchase;
    if (p.product_id !== sub.product_id || p.seller_id !== store.ownerId) throw new Failure('store_mismatch');
    e.keyHash = await this.secrets.hash('license-key', store._id, normalize(sub.license_key));
    e.variant = p.variants && typeof p.variants === 'object' && !Array.isArray(p.variants) ? variantKey(p.variants) : undefined;
    if (!e.variant && p.variants) {
      const names = typeof p.variants === 'string' ? [p.variants] : Array.isArray(p.variants) ? p.variants : [];
      const cached = await this.catalog(store._id,sub.product_id);
      const matches = cached?.variants.filter(v=>{
        const entries=JSON.parse(v.id) as [string,string][];
        return names.length===1 && [v.name,entries.map(([title,name])=>`${title}: ${name}`).join(', ')].includes(names[0]!);
      }) ?? [];
      if(matches.length===1) e.variant=matches[0]!.id;
    }
    // An unresolved current tier cannot remove a previously known tier.
    if(!e.variant) e.eligibility='unknown';
    e.eligibility = p.refunded || p.chargebacked || p.chargedback ? 'ineligible' : e.eligibility;
    return e;
  }
  readReference(store:Store,referenceId:string,membership=false,background=false) { return membership?this.membership(store,referenceId,undefined,background):this.sale(store,referenceId,background); }
  recheck(store:Store,e:Entitlement,background=true) { return e.membership?this.membership(store,e.referenceId,e,background):this.sale(store,e.referenceId,background); }
  async catalogPage(store: Store): Promise<{products:Omit<CatalogProduct,'nameKey'>[];more:boolean}> {
      const raw = parse(z.object({success: z.literal(true), products: z.array(z.object({id: sid, name: z.string(), is_recurring_billing: z.boolean().optional(), is_licensed: z.boolean().optional(), variants: z.array(z.object({title: z.string(), options: z.array(z.object({name: z.string()}))})).optional()}))}), await this.request(store, '/products', {}, {background:true}));
      return {products: raw.products.map(p => ({_id: `${store._id}:${p.id}`, storeId: store._id, productId: p.id, name: p.name,
        membership: !!p.is_recurring_billing, licensed: !!p.is_licensed,
        variants: p.variants?.length === 1 ? p.variants[0]!.options.map(v => ({id: variantKey({[p.variants![0]!.title]: v.name}), name: v.name})) : [], fetchedAt: new Date()})), more: false};
  }
  async versions(_store:Store,product:CatalogProduct) { return product.variants; }
  async indexPage(store: Store, productId: string, membership: boolean, cursor?: string, after?: string): Promise<{records: Lookup[]; cursor?: string}> {
    const query: Record<string,string> = membership ? {paginated: 'true'} : {product_id: productId};
    if (cursor) query.page_key = cursor;
    if (after && !membership) query.after = after;
    if (membership) {
      const raw = parse(z.object({success: z.literal(true), subscribers: z.array(subscriberSchema), next_page_key: z.string().optional()}), await this.request(store, `/products/${encodeURIComponent(productId)}/subscribers`, query, {background: true}));
      return {cursor: raw.next_page_key, records: await Promise.all(raw.subscribers.filter(s => s.product_id === productId).map(async s => ({_id: `${store._id}:subscription:${s.id}`, storeId: store._id, productId,
        referenceId: s.id, membership: true, buyerHash: s.user_id ? await this.secrets.hash('gumroad-buyer', store._id, s.user_id) : undefined})))};
    }
    const raw = parse(z.object({success: z.literal(true), sales: z.array(saleSchema), next_page_key: z.string().optional()}), await this.request(store, '/sales', query, {background: true}));
    return {cursor: raw.next_page_key, records: await Promise.all(raw.sales.filter(s => s.product_id === productId).map(async s => {
      const e = await this.fromSale(store, s);
      return {_id: `${store._id}:${e.entitlementId}`, storeId: store._id, productId, referenceId: e.referenceId, saleId: e.saleId, membership: e.membership, buyerHash: e.buyerHash};
    }))};
  }
}

export const gumroad: StoreDefinition = {
  id:'gumroad', name:'Gumroad', connection:{type:'oauth'}, buyerSignIn:true,
  apiBase:'https://api.gumroad.com/v2', headers:token=>({Authorization:`Bearer ${token}`}),
  budget:{total:80,interactive:20,background:60}, maxResponseBytes:path=>path==='/products'?32_000_000:2_000_000,
  matchesKey:key=>/^[a-f\d]{8}(?:-[a-f\d]{8}){3}$/i.test(key), normalizeKey:normalize,
  create:context=>new Gumroad(context),
  hints:{
    resources:buyerIndex=>[...(buyerIndex?['sale']:[]),'refund','dispute','dispute_won','cancellation','subscription_updated','subscription_ended','subscription_restarted'],
    parse(body,ownerId) {
      const result=z.object({sale_id:z.string().min(1).max(128).optional(),subscription_id:z.string().min(1).max(128).optional(),seller_id:z.string().max(128).optional(),product_id:z.string().min(1).max(128)}).safeParse(body);
      if(!result.success || (result.data.seller_id && result.data.seller_id!==ownerId)) return null;
      const p=result.data;return {productId:p.product_id,referenceId:p.subscription_id??p.sale_id,membership:!!p.subscription_id};
    },
  },
};

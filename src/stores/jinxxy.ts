import { z } from 'zod';
import { parse } from '../http.js';
import { Failure, same } from '../security.js';
import type { CatalogProduct, Entitlement, Store } from '../model.js';
import type { AdapterContext, StoreAdapter, StoreDefinition } from './contract.js';
const sid=z.string().min(1).max(256);
const licenseSchema = z.object({
  id: sid, key: z.string(), short_key: z.string(),
  inventory_item: z.object({target_id: sid, target_version_id: sid.nullable(), target_type: z.string(),
    grant_type: z.string().nullable(),
    item: z.object({object:z.literal('PurchasedProduct'), id: sid, version: z.object({id: sid, name: z.string()}).nullable()}),
    order: z.object({id: sid, payment_status: z.string()}).nullable(),
  }),
});
export class Jinxxy implements StoreAdapter {
  constructor(private context: AdapterContext) {}
  private get request() { return this.context.request; }
  private get secrets() { return this.context.secrets; }
  async key(store: Store, key: string): Promise<Entitlement | null> {
    const field = /^[a-z\d]{4}-[a-f\d]{12}$/i.test(key) ? 'short_key' : 'key';
    const result = parse(z.object({results: z.array(z.object({id: sid})), page_count: z.number()}), await this.request(store, '/licenses', {[field]: key, limit: '2'}));
    if (!result.results.length) return null;
    if (result.page_count > 1 || result.results.length !== 1) throw new Failure('ambiguous_key');
    return this.detail(store, result.results[0]!.id, key);
  }
  async detail(store: Store, referenceId: string, key?: string, background = false): Promise<Entitlement> {
    const license = parse(licenseSchema, await this.request(store, `/licenses/${encodeURIComponent(referenceId)}`, {}, {background}));
    if (license.id !== referenceId || (key && !same(key, license.key) && !same(key, license.short_key))) throw new Failure('key_mismatch');
    const item = license.inventory_item;
    if (item.target_id !== item.item.id || item.target_version_id !== (item.item.version?.id ?? null)) throw new Failure('provider_schema');
    const status = item.order?.payment_status;
    // TODO: Contract-test suspension/revocation when Jinxxy documents its representation.
    // Paid/refunded verification remains functional; HTTP success alone never grants access.
    const eligibility = status === 'REFUNDED' ? 'ineligible'
      : item.grant_type === 'ORDER_ITEM' && status === 'PAID' ? 'eligible' : 'unknown';
    return {provider: 'jinxxy', storeId: store._id, ownerId: store.ownerId, entitlementId: `license:${license.id}`, referenceId: license.id,
      productId: item.target_id, variant: item.target_version_id ?? undefined, membership: false,
      eligibility, checkedAt: new Date(), keyHash: await this.secrets.hash('license-key', store._id, key ?? license.key)};
  }
  readReference(store:Store,referenceId:string,_membership=false,background=false) { return this.detail(store,referenceId,undefined,background); }
  async recheck(store:Store,e:Entitlement,background=true) {
    try { return await this.readReference(store,e.referenceId,false,background); } catch(error) {
      if(error instanceof Failure && error.code==='provider_not_found') return {...e,eligibility:'ineligible' as const,checkedAt:new Date()}; throw error;
    }
  }
  async catalogPage(store:Store,page=1):Promise<{products:Omit<CatalogProduct,'nameKey'>[];more:boolean}> {
    const raw = parse(z.object({page_count: z.number(), results: z.array(z.object({id: sid, name: z.string()}))}), await this.request(store, '/products', {page: String(page), limit: '50'}, {background:true}));
    return {products: raw.results.map(p => ({_id: `${store._id}:${p.id}`, storeId: store._id, productId: p.id, name: p.name, membership: false, licensed: true, variants: [], fetchedAt: new Date()})), more: page < raw.page_count};
  }
  async versions(store: Store, product: CatalogProduct) {
    const p = parse(z.object({id: sid, versions: z.array(z.object({id: sid, name: z.string()}))}), await this.request(store, `/products/${encodeURIComponent(product.productId)}`));
    if (p.id !== product.productId) throw new Failure('provider_schema');
    return p.versions;
  }
  async identify(store:Store) {
    const me=parse(z.object({id:sid,scopes:z.array(z.string())}),await this.request(store,'/me'));
    const required=['products_read','licenses_read'];
    if(!required.every(s=>me.scopes.includes(s)) || me.scopes.some(s=>!required.includes(s))) throw new Failure('read_only_key_required');
    return me.id;
  }
}

export const jinxxy: StoreDefinition = {
  id:'jinxxy', name:'Jinxxy', connection:{type:'api-key',description:'Discord processes this form. Use only products_read and licenses_read.'},
  apiBase:'https://api.creators.jinxxy.com/v1', headers:token=>({'x-api-key':token}),
  budget:{total:60,interactive:40,background:10}, maxResponseBytes:()=>2_000_000,
  matchesKey:key=>/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(key)||/^[a-z\d]{4}-[a-f\d]{12}$/i.test(key),
  create:context=>new Jinxxy(context),
};

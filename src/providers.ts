import type { Requester } from './http.js';
import { Failure, normalizeKey, productNameKey, type Secrets } from './security.js';
import type { CatalogProduct, Entitlement, Panel, Store } from './model.js';
import type { StoreAdapter } from './stores/contract.js';
import { storeDefinition, storeDefinitions } from './stores/registry.js';

export class Providers {
  private adapters = new Map<string,StoreAdapter>();
  constructor(public request: Requester, public secrets: Secrets,
    private catalog: (storeId:string,productId:string)=>Promise<CatalogProduct|null> = async()=>null) {}
  get(provider:string): StoreAdapter {
    let adapter=this.adapters.get(provider);
    if(!adapter) {
      adapter=storeDefinition(provider).create({request:(...args)=>this.request(...args),secrets:this.secrets,catalog:this.catalog});
      this.adapters.set(provider,adapter);
    }
    return adapter;
  }
  normalizeKey(input:string) {
    const key=normalizeKey(input), matches=[...storeDefinitions.values()].filter(d=>d.matchesKey(key));
    return matches.length===1?matches[0]!.normalizeKey?.(key)??key:key;
  }
  private checked(store:Store,e:Entitlement) {
    if(e.provider!==store.provider || e.storeId!==store._id || e.ownerId!==store.ownerId) throw new Failure('store_mismatch');
    return e;
  }
  async resolve(panel:Panel,stores:Store[],input:string):Promise<Entitlement|null> {
    const key=this.normalizeKey(input), hints=[...storeDefinitions.values()].filter(d=>d.matchesKey(key)).map(d=>d.id);
    const candidates=stores.filter(s=>panel.stores[s.provider]===s._id&&(!hints.length||hints.includes(s.provider)));
    const found:Entitlement[]=[];
    for(const store of candidates) {
      const result=await this.get(store.provider).key(store,key);
      if(result) found.push(this.checked(store,result));
    }
    if(found.length>1) throw new Failure('ambiguous_key');
    if(found.length) return found[0]!;
    for(const store of candidates) {
      const memberships=[...new Set(panel.mappings.filter(m=>m.provider===store.provider&&m.membership).map(m=>m.productId))];
      const adapter=this.get(store.provider);
      if(adapter.membershipKey && memberships.length) {
        const result=await adapter.membershipKey(store,memberships,key);
        if(result) found.push(this.checked(store,result));
      }
    }
    if(found.length>1) throw new Failure('ambiguous_key');
    return found[0]??null;
  }
  async readReference(store:Store,referenceId:string,membership=false,background=false) { return this.checked(store,await this.get(store.provider).readReference(store,referenceId,membership,background)); }
  async recheck(store:Store,e:Entitlement,background=true) { return this.checked(store,await this.get(store.provider).recheck(store,e,background)); }
  async catalogPage(store:Store,page=1) {
    const result=await this.get(store.provider).catalogPage(store,page);
    return {...result,products:result.products.map(p=>({...p,nameKey:productNameKey(p.name)}))};
  }
  versions(store:Store,product:CatalogProduct) { return this.get(store.provider).versions(store,product); }
  indexPage(store:Store,productId:string,membership:boolean,cursor?:string,after?:string) {
    const adapter=this.get(store.provider);
    if(!adapter.indexPage) throw new Failure('unsupported_store');
    return adapter.indexPage(store,productId,membership,cursor,after);
  }
}

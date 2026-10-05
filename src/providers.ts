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
  normalizeKey(input:string,allowSpaces=false) {
    return normalizeKey(input,allowSpaces);
  }
  private checked(store:Store,e:Entitlement) {
    if(e.provider!==store.provider || e.storeId!==store._id || e.ownerId!==store.ownerId) throw new Failure('store_mismatch');
    return e;
  }
  async resolve(panel:Panel,stores:Store[],input:string):Promise<Entitlement|null> {
    const key=this.normalizeKey(input,!!panel.stores.payhip), hints=[...storeDefinitions.values()].filter(d=>d.matchesKey(key)).map(d=>d.id);
    const candidates=stores.filter(s=>panel.stores[s.provider]===s._id && (!/\s/.test(key)||storeDefinition(s.provider).productSecrets)
      && (!hints.length||hints.includes(s.provider)||storeDefinition(s.provider).productSecrets));
    const found:Entitlement[]=[];
    for(const store of candidates) {
      const definition=storeDefinition(store.provider);
      const productIds=[...new Set(panel.mappings.filter(m=>m.provider===store.provider).map(m=>m.productId))];
      const result=await this.get(store.provider).key(store,definition.normalizeKey?.(key)??key,productIds);
      if(result) found.push(this.checked(store,result));
    }
    if(found.length>1) throw new Failure('ambiguous_key');
    for(const store of candidates) {
      if(found.some(e=>e.storeId===store._id)) continue;
      const memberships=[...new Set(panel.mappings.filter(m=>m.provider===store.provider&&m.membership).map(m=>m.productId))];
      const adapter=this.get(store.provider);
      if(adapter.membershipKey && memberships.length) {
        const result=await adapter.membershipKey(store,memberships,storeDefinition(store.provider).normalizeKey?.(key)??key);
        if(result) found.push(this.checked(store,result));
      }
    }
    if(found.length>1) throw new Failure('ambiguous_key');
    return found[0]??null;
  }
  async readReference(store:Store,referenceId:string,membership=false,background=false) {
    const adapter=this.get(store.provider); if(!adapter.readReference) throw new Failure('unsupported_store');
    return this.checked(store,await adapter.readReference(store,referenceId,membership,background));
  }
  async recheck(store:Store,e:Entitlement,background=true) {
    const adapter=this.get(store.provider); if(!adapter.recheck) throw new Failure('unsupported_store');
    return this.checked(store,await adapter.recheck(store,e,background));
  }
  async catalogPage(store:Store,page=1,cursor?:string) {
    const adapter=this.get(store.provider); if(!adapter.catalogPage) throw new Failure('unsupported_store');
    const result=await adapter.catalogPage(store,page,cursor);
    return {...result,products:result.products.map(p=>({...p,nameKey:productNameKey(p.name)}))};
  }
  versions(store:Store,product:CatalogProduct) { return this.get(store.provider).versions(store,product); }
  indexPage(store:Store,productId:string,membership:boolean,cursor?:string,after?:string) {
    const adapter=this.get(store.provider);
    if(!adapter.indexPage) throw new Failure('unsupported_store');
    return adapter.indexPage(store,productId,membership,cursor,after);
  }
}

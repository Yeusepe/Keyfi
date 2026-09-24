import type { CatalogProduct, Entitlement, Lookup, Store } from '../model.js';
import type { Requester } from '../http.js';
import type { Secrets } from '../security.js';

export interface AdapterContext {
  request: Requester;
  secrets: Secrets;
  catalog(storeId: string, productId: string): Promise<CatalogProduct | null>;
}
export interface StoreAdapter {
  key(store: Store, key: string): Promise<Entitlement | null>;
  membershipKey?(store: Store, productIds: string[], key: string): Promise<Entitlement | null>;
  readReference(store: Store, referenceId: string, membership?: boolean, background?: boolean): Promise<Entitlement>;
  recheck(store: Store, entitlement: Entitlement, background?: boolean): Promise<Entitlement>;
  // Adapters return raw listings; Providers adds the normalized name key.
  catalogPage(store: Store, page?: number): Promise<{products: Omit<CatalogProduct, 'nameKey'>[]; more: boolean}>;
  versions(store: Store, product: CatalogProduct): Promise<CatalogProduct['variants']>;
  identify?(store: Store): Promise<string>;
  indexPage?(store: Store, productId: string, membership: boolean, cursor?: string, after?: string): Promise<{records: Lookup[]; cursor?: string}>;
  hooks?: {
    list(store: Store, resource: string, url: string): Promise<string[]>;
    create(store: Store, resource: string, url: string): Promise<string>;
    remove(store: Store, id: string): Promise<void>;
  };
}
export interface StoreDefinition {
  id: string;
  name: string;
  connection: {type: 'oauth'} | {type: 'api-key'; description: string};
  buyerSignIn?: boolean;
  apiBase: string;
  headers(token: string): Record<string,string>;
  budget: {total: number; interactive: number; background: number};
  maxResponseBytes(path: string): number;
  matchesKey(key: string): boolean;
  normalizeKey?(key: string): string;
  create(context: AdapterContext): StoreAdapter;
  hints?: {
    resources(buyerIndex: boolean): string[];
    parse(body: unknown, ownerId: string): {productId: string; referenceId?: string; membership: boolean} | null;
  };
}

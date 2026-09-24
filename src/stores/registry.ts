import { Failure } from '../security.js';
import type { Panel } from '../model.js';
import type { StoreDefinition } from './contract.js';
import { gumroad } from './gumroad.js';
import { jinxxy } from './jinxxy.js';

export const storeDefinitions: ReadonlyMap<string,StoreDefinition> = new Map([gumroad,jinxxy].map(d=>[d.id,d]));
export function storeDefinition(provider: string) {
  const definition=storeDefinitions.get(provider);
  if(!definition || definition.id!==provider || !/^[a-z][a-z\d-]{0,39}$/.test(provider)) throw new Failure('unsupported_store');
  return definition;
}
export function providerFor(panel: Panel, storeId: string) {
  const provider=Object.keys(panel.stores).find(p=>panel.stores[p]===storeId);
  if(!provider) throw new Failure('expired');
  return storeDefinition(provider);
}

import { RateLimiterMongo } from 'rate-limiter-flexible';
import { z } from 'zod';
import { Failure, Secrets } from './security.js';
import type { Database } from './db.js';
import type { Store } from './model.js';
import { storeDefinition } from './stores/registry.js';

export type Requester = (store: Store, path: string, query?: Record<string,string>, options?: {background?: boolean; method?: string; body?: Record<string,string>}) => Promise<unknown>;
export class Limits {
  private limiters = new Map<string, RateLimiterMongo>();
  constructor(private db: Database) {}
  async take(name: string, key: string, points: number, duration = 60) {
    const config = `${name}_${points}_${duration}`;
    let limiter = this.limiters.get(config);
    if (!limiter) {
      limiter = new RateLimiterMongo({storeClient: this.db.client, dbName: this.db.db.databaseName, tableName: 'rate_limits', disableIndexesCreation: true, keyPrefix: config, points, duration});
      this.limiters.set(config, limiter);
    }
    try { await limiter.consume(key); }
    catch(e) {
      if (e && typeof e === 'object' && 'msBeforeNext' in e) throw new Failure('rate_limited', Math.max(1, Math.ceil(Number(e.msBeforeNext) / 1000)));
      throw new Failure('database_unavailable');
    }
  }
}
export function createRequester(db: Database, secrets: Secrets, limits: Limits, fetcher: typeof fetch = fetch): Requester {
  return async (store, path, query = {}, options = {}) => {
    if (store.status !== 'active' && options.method !== 'DELETE') throw new Failure('store_disconnected');
    if (!/^\/(?:[a-zA-Z\d_\/-]|%[a-f\d]{2})+$/i.test(path) || path.includes('..')) throw new Failure('invalid_provider_path');
    const cooldown = await db.cooldowns.findOne({_id: store._id});
    if (cooldown && cooldown.until.getTime() > Date.now()) throw new Failure('rate_limited', Math.ceil((cooldown.until.getTime() - Date.now()) / 1000));
    const definition = storeDefinition(store.provider);
    if (options.background) await limits.take('provider_background', store._id, definition.budget.background);
    else await limits.take('provider_interactive', store._id, definition.budget.interactive);
    await limits.take('provider_total', store._id, definition.budget.total);
    const url = new URL(`${definition.apiBase}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const token = await secrets.open(store.credential, store._id);
    const headers = definition.headers(token);
    if (options.body) headers['content-type'] = 'application/x-www-form-urlencoded';
    let response: Response;
    try {
      response = await fetcher(url, {method: options.method ?? 'GET', headers, body: options.body ? new URLSearchParams(options.body) : undefined, redirect: 'error', signal: AbortSignal.timeout(10_000)});
    } catch { throw new Failure('provider_unavailable'); }
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const until = new Date(Math.max(reset || Date.now()+60_000, Date.now()+1000));
      await db.cooldowns.updateOne({_id: store._id}, {$max: {until}}, {upsert: true});
    }
    if (response.status === 429) {
      const h = response.headers.get('retry-after');
      const seconds = h && /^\d+$/.test(h) ? Number(h) : h ? Math.ceil((Date.parse(h) - Date.now()) / 1000) : 60;
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const until = new Date(Math.max(Date.now() + Math.max(seconds || 60, 1) * 1000, reset || 0));
      await db.cooldowns.updateOne({_id: store._id}, {$max: {until}}, {upsert: true});
      throw new Failure('rate_limited', Math.ceil((until.getTime() - Date.now()) / 1000));
    }
    if (response.status === 401 || response.status === 403) throw new Failure('store_reconnect');
    if (response.status === 404) throw new Failure('provider_not_found');
    if (!response.ok) throw new Failure('provider_unavailable');
    // Never attach a URL, response body, or provider error to an exception.
    return readJson(response, definition.maxResponseBytes(path));
  };
}
export async function readJson(response: Response, maximum = 2_000_000): Promise<unknown> {
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Failure('provider_schema');
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximum) { await reader.cancel(); throw new Failure('provider_schema'); }
      chunks.push(result.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new Failure('provider_schema'); }
  } catch(e) { if(e instanceof Failure) throw e; throw new Failure('provider_unavailable'); }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Failure('provider_schema');
  return result.data;
}

import { MongoClient, type ClientSession, type Collection } from 'mongodb';
import { Failure, id } from './security.js';
import type { Action, Binding, CatalogJob, CatalogProduct, Claim, Flow, Member, Panel, SetupView, Store, StoredLookup, Subject, Sync } from './model.js';

export class Database {
  db;
  stores; panels; claims; bindings; members; subjects; lookups; catalog; flows; actions; sync;
  catalogJobs; setupViews;
  leases: Collection<{_id: string; owner: string; expiresAt: Date}>;
  events: Collection<{_id: string; expiresAt: Date}>;
  optouts: Collection<{_id: string; createdAt: Date}>;
  hints: Collection<{_id: string; storeId: string; reference: string; membership: boolean; pings: number; nextAt: Date; expiresAt: Date}>;
  cooldowns: Collection<{_id: string; until: Date}>;
  constructor(public client: MongoClient, name: string) {
    this.db = client.db(name);
    this.stores = this.db.collection<Store>('stores');
    this.panels = this.db.collection<Panel>('panels');
    this.claims = this.db.collection<Claim>('claims');
    this.bindings = this.db.collection<Binding>('bindings');
    this.members = this.db.collection<Member>('members');
    this.subjects = this.db.collection<Subject>('subjects');
    this.lookups = this.db.collection<StoredLookup>('lookups');
    this.catalog = this.db.collection<CatalogProduct>('catalog');
    this.flows = this.db.collection<Flow>('flows');
    this.actions = this.db.collection<Action>('actions');
    this.sync = this.db.collection<Sync>('sync');
    this.catalogJobs = this.db.collection<CatalogJob>('catalog_jobs');
    this.setupViews = this.db.collection<SetupView>('setup_views');
    this.leases = this.db.collection('leases');
    this.events = this.db.collection('events');
    this.optouts = this.db.collection('optouts');
    this.hints = this.db.collection('hints');
    this.cooldowns = this.db.collection('cooldowns');
  }
  async initialize() {
    const hello = await this.db.command({hello: 1});
    if (!hello.setName) throw new Error('MongoDB must be configured as a replica set (one member is sufficient)');
    await Promise.all([
      this.stores.createIndex({provider: 1, ownerId: 1}, {unique: true}),
      this.panels.createIndex({guildId: 1}),
      this.claims.createIndex({nextCheckAt: 1}), this.claims.createIndex({subject: 1}), this.claims.createIndex({storeId: 1}),
      this.bindings.createIndex({panelId: 1, claimId: 1}, {unique: true}),
      this.bindings.createIndex({guildId: 1, subject: 1}), this.bindings.createIndex({subject: 1}),
      this.members.createIndex({dirty: 1}), this.members.createIndex({subject: 1}),
      this.lookups.createIndex({storeId: 1, buyerHash: 1}),
      this.catalog.createIndex({storeId: 1, productId: 1}, {unique: true}),
      this.catalog.createIndex({storeId: 1, nameKey: 1}),
      ...[this.flows, this.actions, this.events, this.leases, this.hints, this.setupViews].map(c => c.createIndex({expiresAt: 1}, {expireAfterSeconds: 0})),
      this.sync.createIndex({nextAt: 1}), this.hints.createIndex({nextAt: 1}),
      this.db.collection('rate_limits').createIndex({key: 1}, {unique: true}),
      this.db.collection('rate_limits').createIndex({expire: -1}, {expireAfterSeconds: 0}),
    ]);
  }
  async transaction<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try { return await session.withTransaction(() => fn(session)); }
    finally { await session.endSession(); }
  }
  async once(key: string, seconds = 900) {
    try { await this.events.insertOne({_id: key, expiresAt: new Date(Date.now() + seconds * 1000)}); return true; }
    catch (e) { if ((e as {code?: number}).code === 11000) return false; throw e; }
  }
  async withLease<T>(key: string, fn: (guard: () => void) => Promise<T>): Promise<T> {
    const owner = id();
    try {
      await this.leases.updateOne({_id: key, expiresAt: {$lte: new Date()}}, {$set: {owner, expiresAt: new Date(Date.now() + 120_000)}}, {upsert: true});
    } catch(e) { if ((e as {code?: number}).code === 11000) throw new Failure('busy', 2); throw e; }
    let validUntil = Date.now() + 110_000;
    let renewing = false;
    const timer = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        const r = await this.leases.updateOne({_id: key, owner}, {$set: {expiresAt: new Date(Date.now() + 120_000)}});
        validUntil = r.matchedCount ? Date.now() + 110_000 : 0;
      } catch { validUntil = 0; } finally { renewing = false; }
    }, 10_000);
    timer.unref();
    try { return await fn(() => { if (Date.now() >= validUntil) throw new Failure('lease_lost'); }); }
    finally { clearInterval(timer); await this.leases.deleteOne({_id: key, owner}); }
  }
  async dirty(guildId: string, subject: string, session?: ClientSession, discord?: string) {
    await this.members.updateOne({_id: `${guildId}:${subject}`}, {
      $set: {dirty: true}, $inc: {revision: 1}, $unset: {nextAt: ''}, $setOnInsert: {guildId, subject, managedRoles: [], ...(discord ? {discord} : {})},
    }, {upsert: true, session});
  }
}

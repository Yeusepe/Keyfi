import type { Database } from './db.js';
import type { ClientSession } from 'mongodb';
import type { DiscordPort } from './discord.js';
import type { Providers } from './providers.js';
import { Failure, id, productNameKey, Secrets } from './security.js';
import { providerFor, storeDefinition } from './stores/registry.js';
import type { AccountCheck, Claim, Deletion, Entitlement, Mapping, Panel, Provider } from './model.js';
import { TERMS_VERSION } from './notices.js';

export class Service {
  constructor(public db: Database, public providers: Providers, public discord: DiscordPort, public secrets: Secrets, public buyerOAuthEnabled=true) {}
  async panel(panelId: string, guildId?: string): Promise<Panel> {
    const panel = await this.db.panels.findOne({_id: panelId, active: true, ...(guildId ? {guildId} : {})});
    if (!panel) throw new Failure('expired'); return panel;
  }
  async ready(panel: Panel) {
    if (!this.buyerOAuthEnabled || !panel.stores.gumroad || !panel.mappings.some(m => m.provider === 'gumroad')) return false;
    const products=[...new Set(panel.mappings.filter(m=>m.provider==='gumroad').map(m=>m.productId))];
    const sync = await this.db.sync.find({storeId:panel.stores.gumroad,productId:{$in:products}}).toArray();
    return products.length>0 && products.every(product=>sync.some(s=>s.productId===product && s.initialComplete));
  }
  async connect(panelId: string, discordId: string, provider: Provider, ownerId: string, token: string) {
    const definition=storeDefinition(provider);
    const panel = await this.panel(panelId);
    await this.discord.administrator(panel.guildId, discordId);
    const storeId = await this.secrets.hash('store', provider, ownerId);
    await this.db.transaction(async session => {
      const p = await this.db.panels.findOne({_id: panelId, active: true}, {session});
      if (!p || p.administrator !== discordId) throw new Failure('admin_required');
      if (p.stores[provider] && p.stores[provider] !== storeId) throw new Failure('disconnect_first');
      const previous = await this.db.stores.findOne({_id: storeId}, {session});
      if (previous && previous.administrator !== discordId) throw new Failure('store_already_connected');
      if (previous?.status === 'disconnecting') throw new Failure('busy');
      await this.db.stores.updateOne({_id: storeId}, {$set: {credential: await this.secrets.seal(token, storeId), status: 'active', termsVersion: TERMS_VERSION, termsAcceptedAt: new Date()},
        $setOnInsert: {provider, ownerId, administrator: discordId, createdAt: new Date(), webhookPending: !!definition.hints}}, {upsert: true, session});
      await this.db.panels.updateOne({_id: panelId}, {$set: {[`stores.${provider}`]: storeId, refreshAt: new Date()}, $inc: {revision: 1}}, {session});
      await this.db.catalogJobs.updateOne({_id: storeId}, {$setOnInsert: {page: 1, nextAt: new Date(), syncing: true}}, {upsert: true, session});
    });
    return storeId;
  }
  async syncStores(panelId: string, discordId: string) {
    const panel = await this.panel(panelId);
    await this.discord.administrator(panel.guildId, discordId);
    return this.db.transaction(async session => {
      const current = await this.db.panels.findOne({_id: panelId, active: true, administrator: discordId}, {session});
      if (!current) throw new Failure('admin_required');
      await this.db.panels.updateOne({_id: panelId}, {$inc: {revision: 1}}, {session});
      let queued = false;
      const now = new Date();
      for (const storeId of Object.values(current.stores)) {
        if (!(await this.db.stores.updateOne({_id: storeId, status: 'active', administrator: discordId}, {$inc: {revision: 1}}, {session})).matchedCount) throw new Failure('store_disconnected');
        const job = await this.db.catalogJobs.findOne({_id: storeId}, {session});
        if (job?.syncing || (job?.manualAfter && job.manualAfter > now)) continue;
        await this.db.catalogJobs.updateOne({_id: storeId}, {$set: {page: 1, nextAt: now, syncing: true, manualAfter: new Date(now.getTime()+60_000)}, $unset: {error: ''}}, {upsert: true, session});
        const products = current.mappings.filter(m => current.stores[m.provider]===storeId).map(m => m.productId);
        await this.db.sync.updateMany({storeId, productId: {$in: products}, initialComplete: true, cursor: {$exists: false}}, {$min: {nextAt: now}}, {session});
        queued = true;
      }
      return queued;
    });
  }
  storeSubject(discordId: string, storeId: string) { return this.secrets.subject(discordId, `store:${storeId}`); }
  guildSubject(discordId: string, guildId: string) { return this.secrets.subject(discordId, `guild:${guildId}`); }
  // Delete, export and the access view run with the person present, so their codes for
  // every store and server are derived on demand; nothing stored joins them.
  // ponytail: one HMAC per store and server; keep a scope index if Keyfi outgrows a few thousand.
  async codes(discordId: string) {
    const [storeIds, panelGuilds, memberGuilds] = await Promise.all([this.db.stores.distinct('_id'), this.db.panels.distinct('guildId'), this.db.members.distinct('guildId')]);
    const guildIds = [...new Set([...panelGuilds, ...memberGuilds])];
    const stores = await Promise.all(storeIds.map(async storeId => ({storeId, code: await this.storeSubject(discordId, storeId)})));
    const guilds = await Promise.all(guildIds.map(async guildId => ({guildId, code: await this.guildSubject(discordId, guildId)})));
    return {stores: stores.map(s => s.code), guilds: guilds.map(g => g.code), members: guilds.map(g => `${g.guildId}:${g.code}`), byStore: stores, byGuild: guilds};
  }
  async verifyKey(panel: Panel, discordId: string, input: string): Promise<string[]> {
    const epochs = Object.fromEntries(await Promise.all(Object.values(panel.stores).map(async storeId => [storeId, await this.subjectEpoch(discordId, storeId)] as const)));
    await this.discord.memberRoles(panel.guildId, discordId);
    const key = this.providers.normalizeKey(input);
    const requestId = await this.secrets.hash('inflight', panel._id, discordId, key);
    return this.db.withLease(`verify:${requestId}`, async guard => {
      const stores = await this.db.stores.find({_id: {$in: Object.values(panel.stores)}, status: 'active'}).toArray();
      const entitlement = await this.providers.resolve(panel, stores, key);
      if (!entitlement) throw new Failure('key_not_found');
      guard();
      return this.claim(panel, discordId, entitlement, epochs[entitlement.storeId]);
    });
  }
  roles(panel: Panel, e: Pick<Entitlement, 'provider' | 'productId' | 'variant'>): string[] {
    return [...new Set(panel.mappings.filter(m => m.provider === e.provider && m.productId === e.productId && (!m.variant || m.variant === e.variant)).map(m => m.roleId))];
  }
  async storedClaim(claimId: string, e: Entitlement, subject: string, nextCheckAt: Date): Promise<Claim> {
    const {entitlementId, referenceId, saleId, ...rest} = e;
    return {...rest, _id: claimId, subject, nextCheckAt, reference: await this.secrets.seal(JSON.stringify({entitlementId, referenceId, saleId}), claimId)};
  }
  async entitlementOf(claim: Claim): Promise<Entitlement> {
    const {_id, subject, reference, nextCheckAt, ...rest} = claim;
    return {...rest, ...JSON.parse(await this.secrets.open(reference, _id)) as Pick<Entitlement, 'entitlementId' | 'referenceId' | 'saleId'>};
  }
  async subjectEpoch(discordId: string, storeId: string) {
    const subject = await this.db.subjects.findOneAndUpdate({_id: await this.storeSubject(discordId, storeId)}, {$setOnInsert: {epoch: id(), revision: 0, deleting: false}}, {upsert: true, returnDocument: 'after'});
    if (!subject || subject.deleting) throw new Failure('deleting');
    return subject.epoch;
  }
  async claim(panel: Panel, discordId: string, e: Entitlement, expectedEpoch?: string): Promise<string[]> {
    expectedEpoch ??= await this.subjectEpoch(discordId, e.storeId);
    if (e.eligibility !== 'eligible') throw new Failure(e.eligibility);
    if (Date.now() - e.checkedAt.getTime() > 30_000) throw new Failure('unknown');
    const roles = this.roles(panel, e);
    if (!roles.length) throw new Failure('unmapped_product');
    const claimId = await this.secrets.hash('claim', e.storeId, e.entitlementId);
    // Purchases use the store-scoped code; server records use the server-scoped code.
    const s = await this.storeSubject(discordId, e.storeId), g = await this.guildSubject(discordId, panel.guildId), memberId = `${panel.guildId}:${g}`;
    // The Discord ID is stored encrypted, bound to this server record, for role changes only.
    const discord = await this.db.members.countDocuments({_id: memberId, discord: {$exists: true}}) ? undefined : await this.secrets.seal(discordId, g);
    const stored = await this.storedClaim(claimId, e, s, nextCheck(e));
    await this.db.transaction(async session => {
      const subject = await this.db.subjects.findOne({_id: s}, {session});
      if (subject?.deleting) throw new Failure('deleting');
      if (!subject || subject.epoch !== expectedEpoch) throw new Failure('expired');
      if (await this.db.members.countDocuments({_id: memberId, deleting: true}, {session})) throw new Failure('deleting');
      await this.db.subjects.updateOne({_id: s}, {$inc: {revision: 1}, $setOnInsert: {deleting: false}}, {upsert: true, session});
      const current = await this.db.panels.findOne({_id: panel._id, active: true}, {session});
      if (!current || current.stores[e.provider] !== e.storeId || !this.roles(current, e).length) throw new Failure('expired');
      // Writing the panel creates a conflict with concurrent disconnect/mapping changes.
      await this.db.panels.updateOne({_id: panel._id}, {$inc: {revision: 1}}, {session});
      if (!(await this.db.stores.updateOne({_id: e.storeId, status: 'active'}, {$inc: {revision: 1}}, {session})).matchedCount) throw new Failure('store_disconnected');
      const existing = await this.db.claims.findOne({_id: claimId}, {session});
      if (existing && existing.subject !== s) throw new Failure('claim_taken');
      await this.db.claims.replaceOne({_id: claimId}, stored, {upsert: true, session});
      await this.db.bindings.updateOne({_id: `${claimId}:${panel._id}`}, {$setOnInsert: {claimId, panelId: panel._id, guildId: panel.guildId, subject: g}}, {upsert: true, session});
      await this.db.dirty(panel.guildId, g, session, discord);
    });
    return roles;
  }
  async queueAccount(panel: Panel, discordId: string, buyerHash: string, token: string, epoch?: string, expiresAt=new Date(Date.now()+600_000)) {
    const storeId = panel.stores.gumroad; if (!storeId) throw new Failure('store_disconnected');
    epoch ??= await this.subjectEpoch(discordId, storeId);
    const checkId = await this.secrets.hash('account-check', panel._id, discordId);
    const s = await this.storeSubject(discordId, storeId);
    await this.db.transaction(async session => {
      if (!(await this.db.subjects.updateOne({_id: s, epoch, deleting: false}, {$inc: {revision: 1}}, {session})).matchedCount) throw new Failure('expired');
      await this.db.db.collection<AccountCheck>('account_checks').updateOne({_id:checkId}, {$setOnInsert: {
        panelId:panel._id,discordId,buyerHash,epoch,token:await this.secrets.seal(token,checkId),tokenContext:checkId,
        expiresAt,nextAt:new Date(),roles:[],attempts:0,
      }}, {upsert:true,session});
    });
  }
  async accountStep(check: AccountCheck): Promise<{done: boolean; roles: string[]; cursor?: string}> {
    const {discordId,buyerHash,epoch} = check;
    const panel = await this.panel(check.panelId);
    const subject = panel.stores.gumroad && await this.db.subjects.findOne({_id: await this.storeSubject(discordId, panel.stores.gumroad), epoch, deleting: false});
    if (!subject) throw new Failure('expired');
    if (!await this.ready(panel)) throw new Failure('index_pending');
    const store = await this.db.stores.findOne({_id: panel.stores.gumroad, status: 'active'});
    if (!store) throw new Failure('store_disconnected');
    const matches = await this.db.lookups.find({storeId: store._id, buyerHash, ...(check.cursor ? {_id: {$gt:check.cursor}} : {}), productId: {$in: panel.mappings.filter(m => m.provider === 'gumroad').map(m => m.productId)}}).sort({_id:1}).limit(1).toArray();
    const roles = new Set(check.roles);
    const match = matches[0];
    if (match) {
      const {referenceId} = JSON.parse(await this.secrets.open(match.reference,match._id)) as {referenceId:string};
      const e = await this.providers.readReference(store, referenceId, match.membership);
      if (e.eligibility === 'unknown') throw new Failure('unknown');
      if (e.buyerHash === buyerHash && e.eligibility === 'eligible' && this.roles(panel,e).length) {
        try { for (const role of await this.claim(panel, discordId, e, epoch)) roles.add(role); }
        catch(e) { if (!(e instanceof Failure && e.code==='claim_taken')) throw e; }
      }
    }
    return {done:!match,roles:[...roles],cursor:match?._id};
  }
  // The Gumroad link belongs to one creator's store; other creators never see it.
  async linkBuyer(discordId: string, hash: string, epoch: string, storeId: string) {
    const s = await this.storeSubject(discordId, storeId);
    await this.db.transaction(async session => {
      if (!(await this.db.subjects.updateOne({_id: s, epoch, deleting:false}, {$set: {gumroadHash: hash}, $inc: {revision: 1}}, {session})).matchedCount) throw new Failure('expired');
      await this.db.db.collection('privacy_fence').updateOne({_id:'index' as never},{$inc:{revision:1}},{upsert:true,session});
      await this.db.optouts.deleteOne({_id: hash}, {session});
    });
  }
  // The buyer index serves only Gumroad sign-in. Without it, keep none of it.
  async reconcileIndex() {
    if (!this.buyerOAuthEnabled) { await this.db.sync.deleteMany({}); await this.db.lookups.deleteMany({}); return; }
    for (const panel of await this.db.panels.find({active: true, 'stores.gumroad': {$exists: true}}).toArray())
      for (const m of panel.mappings.filter(m => m.provider === 'gumroad'))
        await this.db.sync.updateOne({_id: `${panel.stores.gumroad}:${m.productId}`}, {$setOnInsert: {panelId: panel._id, storeId: panel.stores.gumroad!, productId: m.productId,
          membership: !!m.membership, initialComplete: false, startedAt: new Date(), nextAt: new Date()}}, {upsert: true});
  }
  async exportSubject(discordId: string) {
    const codes = await this.codes(discordId);
    const [subjects, stored, bindings, members] = await Promise.all([this.db.subjects.find({_id: {$in: codes.stores}}).toArray(), this.db.claims.find({subject: {$in: codes.stores}}).toArray(),
      this.db.bindings.find({subject: {$in: codes.guilds}}).toArray(), this.db.members.find({_id: {$in: codes.members}}).toArray()]);
    const claims = await Promise.all(stored.map(async c => ({...await this.entitlementOf(c), _id: c._id, nextCheckAt: c.nextCheckAt})));
    const products = claims.length ? await this.db.catalog.find({$or: claims.map(c => ({storeId: c.storeId, productId: c.productId}))}).toArray() : [];
    return {generatedAt: new Date().toISOString(), discordId, gumroadAccountLinked: subjects.some(x => x.gumroadHash), deletionInProgress: subjects.some(x => x.deleting) || members.some(m => m.deleting),
      purchases: claims.map(c => ({id: c._id, store: c.provider, product: products.find(p => p.storeId === c.storeId && p.productId === c.productId)?.name ?? null,
        productId: c.productId, variant: c.variant ?? null, membership: c.membership, purchaseReference: c.referenceId, saleId: c.saleId ?? null,
        eligibility: c.eligibility, lastChecked: c.checkedAt, validUntil: c.validUntil ?? null, nextCheck: c.nextCheckAt})),
      servers: bindings.map(b => ({server: b.guildId, panel: b.panelId, purchase: b.claimId})),
      roles: members.map(m => ({server: m.guildId, managedRoles: m.managedRoles, updatePending: m.dirty})),
      // Each code is scoped to one store or one server; none is shared between them.
      pseudonymousIdentifiers: {
        stores: codes.byStore.filter(x => subjects.some(y => y._id === x.code)).map(x => ({store: x.storeId, code: x.code, gumroadAccount: subjects.find(y => y._id === x.code)?.gumroadHash ?? null})),
        servers: codes.byGuild.filter(x => members.some(m => m.subject === x.code)).map(x => ({server: x.guildId, code: x.code})),
        purchases: claims.map(c => ({purchase: c._id, buyer: c.buyerHash ?? null, licenseKey: c.keyHash ?? null}))}};
  }
  async unlinkBuyer(discordId: string) {
    await this.db.subjects.updateMany({_id: {$in: (await this.codes(discordId)).stores}, deleting: false}, {$unset: {gumroadHash: ''}, $inc: {revision: 1}});
  }
  async matchingProducts(panel: Panel, catalogId: string) {
    const product=await this.db.catalog.findOne({_id:catalogId,storeId:{$in:Object.values(panel.stores)}});
    if(!product) throw new Failure('expired');
    const matches=await this.db.catalog.find({storeId:{$in:Object.values(panel.stores)},nameKey:productNameKey(product.name)}).sort({storeId:1,_id:1}).toArray();
    // Identical names within one store are ambiguous. Never guess which listing or tier to map.
    return matches.length>1 && new Set(matches.map(p=>p.storeId)).size===matches.length && matches.some(p=>p._id===product._id) ? matches : [product];
  }
  async mapProducts(panel: Panel, catalogIds: string[], roleId: string, nameKey: string) {
    const products=await this.db.catalog.find({_id:{$in:catalogIds},storeId:{$in:Object.values(panel.stores)}}).toArray();
    if(!catalogIds.length || products.length!==catalogIds.length || products.some(p=>productNameKey(p.name)!==nameKey) || new Set(products.map(p=>p.storeId)).size!==products.length) throw new Failure('expired');
    return this.addMappings(panel,products.map(p=>({provider:providerFor(panel,p.storeId).id,productId:p.productId,label:p.name,membership:p.membership,roleId})),products.map(p=>({id:p._id,nameKey})));
  }
  addMapping(panel: Panel, mapping: Mapping) { return this.addMappings(panel,[mapping]); }
  private async addMappings(panel: Panel, additions: Mapping[], products: {id:string;nameKey:string}[] = []) {
    for(const roleId of new Set(additions.map(m=>m.roleId))) await this.discord.validateRole(panel.guildId,roleId);
    await this.db.transaction(async session => {
      const current = await this.db.panels.findOne({_id: panel._id, active: true}, {session});
      if (!current || additions.some(m=>!current.stores[m.provider] || current.stores[m.provider]!==panel.stores[m.provider])) throw new Failure('expired');
      for(const expected of products) {
        const p=await this.db.catalog.findOne({_id:expected.id,storeId:{$in:Object.values(current.stores)}},{session});
        if(!p || productNameKey(p.name)!==expected.nameKey) throw new Failure('expired');
      }
      for(const mapping of additions) {
        const definition=storeDefinition(mapping.provider);
        if(mapping.membership) {
          const product=await this.db.catalog.findOne({storeId:current.stores[mapping.provider],productId:mapping.productId},{session});
          if(!product?.licensed) throw new Failure('membership_license_required');
        }
        if(definition.buyerSignIn && this.buyerOAuthEnabled) {
          const storeId=current.stores[mapping.provider]!;
          await this.db.sync.updateOne({_id:`${storeId}:${mapping.productId}`},{$setOnInsert:{panelId:panel._id,storeId,productId:mapping.productId,
            membership:!!mapping.membership,initialComplete:false,startedAt:new Date(),nextAt:new Date()}},{upsert:true,session});
        }
      }
      const mappings=current.mappings.filter(m=>!additions.some(a=>m.provider===a.provider&&m.productId===a.productId&&(m.variant??undefined)===(a.variant??undefined)));
      await this.db.panels.updateOne({_id: panel._id}, {$set: {mappings: [...mappings, ...additions], refreshAt: new Date()}, $inc: {revision: 1}}, {session});
      for(const binding of await this.db.bindings.find({panelId:panel._id},{session}).toArray()) await this.db.dirty(binding.guildId,binding.subject,session);
    });
  }
  async desired(guildId: string, subject: string, deleting = false) {
    if (deleting) return [];
    const bindings = await this.db.bindings.find({guildId, subject}).toArray();
    const wanted = new Set<string>();
    for (const binding of bindings) {
      const [claim, panel] = await Promise.all([this.db.claims.findOne({_id: binding.claimId}), this.db.panels.findOne({_id: binding.panelId, active: true})]);
      if (claim && panel && claim.eligibility === 'eligible' && panel.stores[claim.provider] === claim.storeId)
        for (const role of this.roles(panel, claim)) wanted.add(role);
    }
    return [...wanted];
  }
  async reconcile(memberId: string) {
    await this.db.withLease(`member:${memberId}`, async guard => {
      const member = await this.db.members.findOne({_id: memberId}); if (!member) return;
      const desired = await this.desired(member.guildId, member.subject, member.deleting);
      // A member without an encrypted Discord ID never received a Keyfi role.
      if (!member.discord) { await this.db.members.updateOne({_id: memberId, revision: member.revision}, {$set: {dirty: false, managedRoles: []}, $unset: {error: ''}}); return; }
      const discordId = await this.secrets.open(member.discord, member.subject);
      let actual: string[];
      try { actual = await this.discord.memberRoles(member.guildId, discordId); }
      catch(e) {
        if (e instanceof Failure && e.code === 'member_missing') {
          await this.db.members.updateOne({_id: memberId, revision: member.revision}, {$set: {dirty: false, managedRoles: []}, $unset: {error: ''}}); return;
        } throw e;
      }
      for (const role of member.managedRoles.filter(r => !desired.includes(r))) {
        guard();
        if ((await this.db.members.findOne({_id:memberId}))?.revision !== member.revision) return;
        if (actual.includes(role)) await this.discord.removeRole(member.guildId, discordId, role);
        await this.db.members.updateOne({_id: memberId}, {$pull: {managedRoles: role}});
      }
      for (const role of desired) {
        guard();
        const fresh = await this.db.members.findOne({_id: memberId});
        if (!fresh || fresh.revision !== member.revision || fresh.deleting) return;
        if(!actual.includes(role)) {
          let checked=false;
          for(const binding of await this.db.bindings.find({guildId:member.guildId,subject:member.subject}).toArray()) {
            const claim=await this.db.claims.findOne({_id:binding.claimId,eligibility:'eligible'});
            const panel=await this.db.panels.findOne({_id:binding.panelId,active:true});
            if(claim && panel && panel.stores[claim.provider]===claim.storeId && this.roles(panel,claim).includes(role)) {
              if(Date.now()-claim.checkedAt.getTime()<30_000) checked=true;
              else await this.db.claims.updateOne({_id:claim._id},{$set:{nextCheckAt:new Date()}});
            }
          }
          if(!checked) throw new Failure('unknown',15);
        }
        await this.discord.validateRole(member.guildId, role);
        // Record responsibility BEFORE the external write so a crash cannot orphan a role.
        await this.db.members.updateOne({_id: memberId}, {$addToSet: {managedRoles: role}});
        guard();
        if (!actual.includes(role)) await this.discord.addRole(member.guildId, discordId, role);
      }
      await this.db.members.updateOne({_id: memberId, revision: member.revision}, {$set: {dirty: false}, $unset: {error: ''}});
    });
  }
  private get deletions() { return this.db.db.collection<Deletion>('deletions'); }
  // The person is present, so every store and server code is known now. The list that
  // joins them lives only until deletion finishes.
  async requestDeletion(discordId: string) {
    const codes = await this.codes(discordId);
    await this.db.transaction(async session => {
      await this.db.subjects.updateMany({_id: {$in: codes.stores}}, {$set: {deleting: true}, $inc: {revision: 1}}, {session});
      const subjects = (await this.db.subjects.find({_id: {$in: codes.stores}}, {session}).toArray()).map(x => x._id);
      const members = await this.db.members.find({_id: {$in: codes.members}}, {session}).toArray();
      for (const member of members) { await this.db.members.updateOne({_id: member._id}, {$set: {deleting: true}}, {session}); await this.db.dirty(member.guildId, member.subject, session); }
      const guildSubjects = [...new Set([...members.map(m => m.subject), ...(await this.db.bindings.distinct('subject', {subject: {$in: codes.guilds}}, {session}))])];
      if (subjects.length || guildSubjects.length) await this.deletions.insertOne({_id: id(), subjects, guildSubjects, createdAt: new Date()}, {session});
      await this.db.db.collection('account_checks').deleteMany({discordId},{session});
      await this.db.flows.deleteMany({discordId}, {session});
      await this.db.actions.deleteMany({discordId}, {session});
      await this.db.setupViews.deleteMany({discordId}, {session});
    });
  }
  pendingDeletions(limit: number) { return this.deletions.find().sort({createdAt: 1}).limit(limit).toArray(); }
  // Runs in the background from the deletion list alone; no Discord ID is needed until roles change.
  async finishDeletion(deletionId: string) {
    await this.db.withLease(`delete:${deletionId}`, async () => {
      const deletion = await this.deletions.findOne({_id: deletionId}); if (!deletion) return;
      const members = await this.db.members.find({subject: {$in: deletion.guildSubjects}}).toArray();
      for (const member of members) {
        await this.reconcile(member._id);
        const fresh = await this.db.members.findOne({_id: member._id});
        if (fresh?.dirty || fresh?.managedRoles.length) return;
      }
      await this.db.transaction(async session => {
        if (!await this.deletions.findOne({_id: deletionId}, {session})) return;
        await this.db.db.collection('privacy_fence').updateOne({_id:'index' as never},{$inc:{revision:1}},{upsert:true,session});
        for (const current of await this.db.subjects.find({_id: {$in: deletion.subjects}, gumroadHash: {$exists: true}}, {session}).toArray()) {
          await this.db.optouts.updateOne({_id: current.gumroadHash!}, {$setOnInsert: {createdAt: new Date()}}, {upsert: true, session});
          await this.db.lookups.deleteMany({buyerHash: current.gumroadHash}, {session});
        }
        await this.db.claims.deleteMany({subject: {$in: deletion.subjects}}, {session});
        await this.db.bindings.deleteMany({subject: {$in: deletion.guildSubjects}}, {session});
        await this.db.members.deleteMany({subject: {$in: deletion.guildSubjects}}, {session});
        await this.db.subjects.deleteMany({_id: {$in: deletion.subjects}}, {session});
        await this.deletions.deleteOne({_id: deletionId}, {session});
      });
    });
  }
  async deletePanel(panelId: string, discordId: string) {
    const panel=await this.panel(panelId);
    await this.discord.administrator(panel.guildId,discordId);
    await this.db.transaction(async session=>{
      const current=await this.db.panels.findOneAndDelete({_id:panelId,administrator:discordId,active:true},{session});
      if(!current) throw new Failure('admin_required');
      for(const binding of await this.db.bindings.find({panelId},{session}).toArray()) await this.db.dirty(binding.guildId,binding.subject,session);
      await this.db.bindings.deleteMany({panelId},{session});
      for(const provider of Object.keys(current.stores)) await this.disconnect(current,provider,session);
      await this.db.flows.deleteMany({panelId},{session});
      await this.db.actions.deleteMany({panelId},{session});
      await this.db.setupViews.deleteOne({_id:panelId},{session});
      await this.db.db.collection('account_checks').deleteMany({panelId},{session});
    });
  }
  async disconnect(panel: Panel, provider: Provider, session?: ClientSession): Promise<void> {
    const storeId = panel.stores[provider]; if (!storeId) return;
    if(!session) return this.db.transaction(session=>this.disconnect(panel,provider,session));
    await this.db.panels.updateOne({_id: panel._id}, {$unset: {[`stores.${provider}`]: ''}, $pull: {mappings: {provider}}, $set: {refreshAt: new Date()}, $inc: {revision: 1}}, {session});
    for(const m of panel.mappings.filter(m=>m.provider===provider)) {
      if(!await this.db.panels.findOne({[`stores.${provider}`]:storeId,mappings:{$elemMatch:{provider,productId:m.productId}}},{session}))
        await this.db.sync.deleteMany({storeId,productId:m.productId},{session});
    }
    const bindings = await this.db.bindings.find({panelId: panel._id}, {session}).toArray();
    for (const binding of bindings) {
      const claim = await this.db.claims.findOne({_id: binding.claimId, storeId}, {session});
      if (claim) { await this.db.bindings.deleteOne({_id: binding._id}, {session}); await this.db.dirty(binding.guildId, binding.subject, session); }
    }
    if (!await this.db.panels.findOne({[`stores.${provider}`]: storeId}, {session})) await this.db.stores.updateOne({_id: storeId}, {$set: {status: 'disconnecting',disconnectedAt:new Date()}}, {session});
  }
}
export function nextCheck(e: Entitlement) {
  const regular = Date.now() + (e.membership ? 6 * 3600_000 : 24 * 3600_000) + Math.floor(Math.random() * 60_000);
  return new Date(Math.max(Date.now() + 30_000, Math.min(regular, e.validUntil?.getTime() ?? regular)));
}

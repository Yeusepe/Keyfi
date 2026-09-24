import type { Config } from './config.js';
import type { Database } from './db.js';
import { accessRow, DiscordApi, errorCopy, roleSummary } from './discord.js';
import { storeDefinition } from './stores/registry.js';
import type { Service } from './service.js';
import { nextCheck } from './service.js';
import { Failure, id, logFailure, safeCode } from './security.js';
import type { Store, Lookup, AccountCheck } from './model.js';

const retryAt = (e: unknown) => new Date(Date.now() + ((e instanceof Failure && e.retryAfter ? e.retryAfter : 60) + Math.random()*10) * 1000);
export class Jobs {
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<Promise<void>>();
  constructor(private c: Config, private db: Database, private service: Service, private discord: DiscordApi, private refreshSetup?: (panelId: string) => Promise<boolean>) {}
  async start() {
    await Promise.all([
      this.db.db.collection('account_checks').createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
    ]);
    await this.service.reconcileIndex();
    for(const [name,every] of [['roles',5_000],['providers',15_000],['index',2_000],['maintenance',60_000]] as const) {
      const tick=()=>{
        const run=this.db.withLease(`job:${name}`,()=>this[name]())
          .catch(e=>{ if(!(e instanceof Failure && e.code==='busy')) process.stderr.write('job_failed\n'); })
          .finally(()=>this.running.delete(run));
        this.running.add(run);
      };
      this.timers.push(setInterval(tick,every)); tick();
    }
  }
  async stop(timeout=30_000) {
    this.timers.forEach(clearInterval); this.timers=[];
    await Promise.race([Promise.allSettled([...this.running]),new Promise(resolve=>setTimeout(resolve,timeout).unref())]);
  }
  async roles() {
    for(const panel of await this.db.panels.find({active:true,refreshAt:{$lte:new Date()}}).limit(5).toArray()) {
      const current={_id:panel._id,revision:panel.revision},ready=await this.service.ready(panel);
      let retry: Date | undefined;
      for(const location of panel.messages) {
        try { await this.discord.updatePanel(panel,ready,location); }
        catch(e) {
          if(safeCode(e)==='message_missing') await this.db.panels.updateOne({_id:panel._id},{$pull:{messages:location}});
          else retry=retryAt(e);
        }
      }
      await this.db.panels.updateOne(current,retry?{$set:{refreshAt:retry}}:{$unset:{refreshAt:''}});
    }
    const members = await this.db.members.find({dirty: true, $or: [{nextAt: {$exists: false}}, {nextAt: {$lte: new Date()}}]}).limit(10).toArray();
    for (const member of members) {
      try { await this.service.reconcile(member._id); }
      catch(e) { await this.db.members.updateOne({_id: member._id}, {$set: {error: safeCode(e), nextAt: retryAt(e)}}); }
    }
    for (const deletion of await this.service.pendingDeletions(5)) {
      try { await this.service.finishDeletion(deletion._id); }
      catch { /* Claims remain reserved until cleanup succeeds. */ }
    }
  }
  async store(storeId: string) { const s = await this.db.stores.findOne({_id: storeId, status: 'active'}); if (!s) throw new Failure('store_disconnected'); return s; }
  async providers() {
    for(const check of await this.db.db.collection<AccountCheck>('account_checks').find({expiresAt:{$lte:new Date(Date.now()+30_000)}}).limit(10).toArray()) {
      if(check.token) try { await this.discord.reply(await this.service.secrets.open(check.token,check.tokenContext),'## Check timed out\nReturn to the creator’s verification message to try again. Purchases already verified are saved.',[accessRow()]); } catch {}
      await this.db.db.collection<AccountCheck>('account_checks').deleteOne({_id:check._id});
    }
    for (const check of await this.db.db.collection<AccountCheck>('account_checks').find({nextAt: {$lte: new Date()}, expiresAt: {$gt: new Date()}}).limit(2).toArray()) {
      let result: string;
      try {
        const step = await this.db.withLease(`account:${check._id}`,()=>this.service.accountStep(check));
        if(!step.done) {
          await this.db.db.collection<AccountCheck>('account_checks').updateOne({_id:check._id},{$set:{cursor:step.cursor,roles:step.roles,nextAt:new Date(),attempts:0}});
          continue;
        }
        result = step.roles.length ? roleSummary(step.roles) : '## No matching purchases\nNo purchases in this Gumroad account unlock roles from this creator. If you bought with another account or as a guest, return to the creator’s verification message and use your license key.';
      } catch(e) {
        if (check.attempts<3 && e instanceof Failure && ['rate_limited','provider_unavailable','busy'].includes(e.code)) {
          await this.db.db.collection('account_checks').updateOne({_id:check._id as never},{$set:{nextAt:retryAt(e)},$inc:{attempts:1}}); continue;
        }
        result = errorCopy(safeCode(e));
      }
      if (check.token) try { await this.discord.reply(await this.service.secrets.open(check.token, check.tokenContext), result,[accessRow()]); } catch { /* No public fallback. */ }
      await this.db.db.collection('account_checks').deleteOne({_id: check._id as never});
    }
    for (const hint of await this.db.hints.find({nextAt: {$lte: new Date()}}).limit(2).toArray()) {
      try {
        const store = await this.store(hint.storeId);
        const e = await this.service.providers.readReference(store,hint.referenceId,hint.membership,true);
        if (!await this.db.panels.findOne({[`stores.${store.provider}`]:store._id,'mappings.productId':e.productId})) throw new Failure('unmapped_product');
        if (this.service.buyerOAuthEnabled) await this.upsertLookups([{_id:`${store._id}:${e.entitlementId}`,storeId:store._id,productId:e.productId,referenceId:e.referenceId,saleId:e.saleId,membership:e.membership,buyerHash:e.buyerHash}]);
        await this.db.claims.updateOne({_id:await this.service.secrets.hash('claim',store._id,e.entitlementId)},{$set:{nextCheckAt:new Date()}});
        await this.db.hints.deleteOne({_id:hint._id,pings:hint.pings});
      } catch(e) {
        if (e instanceof Failure && ['provider_not_found','unmapped_product'].includes(e.code)) await this.db.hints.deleteOne({_id:hint._id});
        else await this.db.hints.updateOne({_id:hint._id},{$set:{nextAt:retryAt(e)}});
      }
    }
    for (const claim of await this.db.claims.find({nextCheckAt: {$lte: new Date()}}).sort({nextCheckAt:1}).limit(3).toArray()) {
      try {
        await this.db.withLease(`claim-check:${claim._id}`, async guard => {
          const previous = await this.service.entitlementOf(claim);
          const e = await this.service.providers.recheck(await this.store(claim.storeId),previous);
          guard();
          const updated = e.eligibility === 'unknown' ? {nextCheckAt:retryAt(new Failure('unknown'))} : await this.service.storedClaim(claim._id,e,claim.subject,nextCheck(e));
          await this.db.transaction(async session => {
            if (e.entitlementId !== previous.entitlementId) throw new Failure('provider_schema');
            const current = await this.db.claims.findOne({_id:claim._id,subject:claim.subject},{session}); if (!current) return;
            await this.db.claims.updateOne({_id:claim._id},{$set:updated},{session});
            for(const b of await this.db.bindings.find({claimId:claim._id},{session}).toArray()) await this.db.dirty(b.guildId,b.subject,session);
          });
        });
      } catch(e) { await this.db.claims.updateOne({_id:claim._id},{$set:{nextCheckAt:retryAt(e)}}); }
    }
    for(const task of await this.db.catalogJobs.find({nextAt:{$lte:new Date()}}).sort({nextAt:1}).limit(1).toArray()) {
      try {
        await this.db.catalogJobs.updateOne({_id:task._id},{$set:{syncing:true}});
        const page = await this.service.providers.catalogPage(await this.store(task._id),task.page);
        for(const product of page.products) { const {_id,...rest}=product; await this.db.catalog.updateOne({_id},{$set:rest},{upsert:true}); }
        await this.db.catalogJobs.updateOne({_id:task._id},{$set:{page:page.more?task.page+1:1,syncing:page.more,
          nextAt:new Date(Date.now()+(page.more?15_000:6*3600_000))},$unset:{error:''}});
      } catch(e) {
        if(e instanceof Failure && e.code==='store_disconnected') await this.db.catalogJobs.deleteOne({_id:task._id});
        else await this.db.catalogJobs.updateOne({_id:task._id},{$set:{nextAt:retryAt(e),error:safeCode(e)}});
      }
    }
    if(this.refreshSetup) for(const view of await this.db.setupViews.find({expiresAt:{$gt:new Date()}}).limit(20).toArray())
      try { await this.refreshSetup(view._id); } catch { /* Retry privately on the next scheduled pass. */ }
  }
  async index() {
    // One page per two-second tick leaves background capacity for rechecks and hooks.
    const sync=await this.db.sync.findOne({nextAt:{$lte:new Date()}},{sort:{nextAt:1}});
    if(!sync) return;
    try {
      const store=await this.store(sync.storeId);
      const page=await this.service.providers.indexPage(store,sync.productId,sync.membership,sync.cursor,sync.after);
      if(page.cursor===sync.cursor && page.cursor) throw new Failure('provider_schema');
      await this.upsertLookups(page.records);
      const done=!page.cursor;
      await this.db.sync.updateOne({_id:sync._id},{$set:{initialComplete:sync.initialComplete||done,
        nextAt:new Date(Date.now()+(done ? sync.membership ? 6*3600_000 : 300_000 : 0)),
        ...(done ? {after:new Date(sync.startedAt.getTime()-86400_000).toISOString().slice(0,10),startedAt:new Date()} : {cursor:page.cursor})},
        $unset:{error:'',...(done?{cursor:''}:{})}});
      if(done && !sync.initialComplete)
        await this.db.panels.updateMany({[`stores.${store.provider}`]:sync.storeId,'mappings.productId':sync.productId,active:true},{$set:{refreshAt:new Date()},$inc:{revision:1}});
    } catch(e) {
      logFailure('purchase_sync_failed',e);
      await this.db.sync.updateOne({_id:sync._id},{$set:{nextAt:retryAt(e),error:safeCode(e)}});
    }
  }
  async upsertLookups(records: Lookup[]) {
    if(!records.length) return;
    await this.db.transaction(async session => {
      // This one small document fences imports against deletion transactions.
      await this.db.db.collection('privacy_fence').updateOne({_id:'index' as never},{$inc:{revision:1}},{upsert:true,session});
      const hashes=records.flatMap(r=>r.buyerHash?[r.buyerHash]:[]);
      const optedOut=new Set((await this.db.optouts.find({_id:{$in:hashes}},{session}).toArray()).map(r=>r._id));
      const writes=records.filter(r=>!r.buyerHash||!optedOut.has(r.buyerHash)).map(({_id,...fields})=>({updateOne:{filter:{_id},update:{$set:fields},upsert:true}}));
      if(writes.length) await this.db.lookups.bulkWrite(writes,{session});
    });
  }
  async registerHooks(store: Store) {
    const definition=storeDefinition(store.provider),hooks=this.service.providers.get(store.provider).hooks;
    if(!definition.hints || !hooks) throw new Failure('unsupported_store');
    if (!store.webhookToken) {
      const token=id();
      await this.db.stores.updateOne({_id:store._id,webhookToken:{$exists:false}},{$set:{webhookToken:await this.service.secrets.seal(token,store._id),webhookHash:await this.service.secrets.hash('webhook',token)}});
      store=(await this.db.stores.findOne({_id:store._id}))!;
    }
    const url=`${this.c.BASE_URL}/webhooks/${definition.id}/${await this.service.secrets.open(store.webhookToken!,store._id)}`;
    const resources=definition.hints.resources(this.service.buyerOAuthEnabled);
    for(const resource of resources) {
      if(store.webhookResources?.includes(resource)) continue;
      if(!(await hooks.list(store,resource,url)).length) await hooks.create(store,resource,url);
      await this.db.stores.updateOne({_id:store._id},{$addToSet:{webhookResources:resource}});
    }
    await this.db.stores.updateOne({_id:store._id},{$set:{webhookPending:false}});
  }
  async maintenance() {
    for(const store of await this.db.stores.find({status:'active',webhookPending:true}).limit(1).toArray()) {
      try { await this.db.withLease(`hooks:${store._id}`,async()=>this.registerHooks(store)); } catch { /* Retry without accepting events as proof. */ }
    }
    for(const store of await this.db.stores.find({status:'disconnecting'}).limit(1).toArray()) {
      try {
        const definition=storeDefinition(store.provider),hooks=this.service.providers.get(store.provider).hooks;
        if(definition.hints && hooks && store.webhookToken) {
          const active={...store,status:'active' as const};
          const url=`${this.c.BASE_URL}/webhooks/${definition.id}/${await this.service.secrets.open(store.webhookToken,store._id)}`;
          for(const resource of definition.hints.resources(true)) {
            if(store.removedResources?.includes(resource)) continue;
            for(const id of await hooks.list(active,resource,url)) await hooks.remove(store,id);
            await this.db.stores.updateOne({_id:store._id},{$addToSet:{removedResources:resource}});
          }
        }
        await this.db.transaction(async session=>{
          if(await this.db.panels.findOne({[`stores.${store.provider}`]:store._id},{session})) return;
          await this.db.lookups.deleteMany({storeId:store._id},{session});
          await this.db.catalog.deleteMany({storeId:store._id},{session});
          // Roles were recorded in members before bindings were removed, so
          // deletion of the credential cannot orphan pending role cleanup.
          await this.db.claims.deleteMany({storeId:store._id},{session});
          await this.db.stores.deleteOne({_id:store._id,status:'disconnecting'},{session});
          await this.db.hints.deleteMany({storeId:store._id},{session});
        });
      } catch(e) {
        if((e instanceof Failure && e.code==='store_reconnect') || (store.disconnectedAt && Date.now()-store.disconnectedAt.getTime()>86400_000)) {
          logFailure('remote_unsubscribe_unconfirmed',e);
          await this.db.transaction(async session=>{
            await this.db.stores.deleteOne({_id:store._id,status:'disconnecting'},{session});
            await this.db.lookups.deleteMany({storeId:store._id},{session});
            await this.db.catalog.deleteMany({storeId:store._id},{session});
            await this.db.claims.deleteMany({storeId:store._id},{session});
            await this.db.hints.deleteMany({storeId:store._id},{session});
          });
        }
      }
    }
    if(await this.db.once('installation-check:'+new Date().toISOString().slice(0,10),172800)) {
      let after: string | undefined; const installed=new Set<string>();
      do {
        const guilds=await this.discord.call<{id:string}[]>('get',(`/users/@me/guilds?limit=200${after?`&after=${after}`:''}`));
        guilds.forEach(g=>installed.add(g.id)); after=guilds.length===200?guilds.at(-1)!.id:undefined;
      } while(after);
      for(const panel of await this.db.panels.find({active:true,guildId:{$nin:[...installed]}}).toArray()) {
        for(const provider of Object.keys(panel.stores)) await this.service.disconnect(panel,provider);
        await this.db.panels.updateOne({_id:panel._id},{$set:{active:false}});
        await this.db.members.deleteMany({guildId:panel.guildId});
      }
    }
  }
}

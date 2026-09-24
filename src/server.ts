import Fastify from 'fastify';
import { verifyKey } from 'discord-interactions';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { Authentication } from './auth.js';
import { closeDocument, closeScriptHash } from './auth.js';
import { errorCopy, message } from './discord.js';
import { interactionSchema, type Interactions } from './interactions.js';
import { Failure, logFailure, safeCode, type Secrets } from './security.js';
import type { Limits } from './http.js';
import { storeDefinitions } from './stores/registry.js';

export function createServer(c: Config, db: Database, interactions: Interactions, auth: Authentication, secrets: Secrets, limits: Limits) {
  const app = Fastify({logger: false, bodyLimit: 32_768, requestTimeout: 30_000, connectionTimeout: 10_000, trustProxy: false});
  const inflight = new Set<Promise<void>>();
  app.addHook('onResponse',async(req,reply)=>{
    if(req.routeOptions.url==='/interactions') process.stdout.write(`discord_response:${reply.statusCode}:${Math.round(reply.elapsedTime)}ms\n`);
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control','no-store').header('referrer-policy','no-referrer').header('x-content-type-options','nosniff')
      .header('content-security-policy',`default-src 'none'; script-src 'sha256-${closeScriptHash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`)
      .header('permissions-policy','camera=(), microphone=(), geolocation=()');
    if(c.BASE_URL.startsWith('https:')) reply.header('strict-transport-security','max-age=31536000');
  });
  app.setErrorHandler((error,req,reply)=>{
    // Gumroad retries only 499/500/502/503/504, so transient failures must be 503.
    if(req.url.startsWith('/webhooks/')) return reply.code(503).send();
    if(req.url.startsWith('/oauth/') || req.url.startsWith('/connect/')) return reply.code(400).type('text/html').send(closeDocument());
    const status = error instanceof Failure && error.code==='rate_limited' ? 429 : 400;
    return reply.code(status).send({error:'request_failed'});
  });
  app.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string'},(_req,body,done)=>{
    try { done(null,Object.fromEntries(new URLSearchParams(body as string))); } catch { done(new Error('invalid_form')); }
  });
  app.get('/health/live',async()=>({ok:true}));
  app.get('/health/ready',async(_req,reply)=>{
    try { await db.db.command({ping:1}); return {ok:true}; } catch { return reply.code(503).send({ok:false}); }
  });
  app.register(async discordRoutes=>{
    discordRoutes.removeContentTypeParser('application/json');
    discordRoutes.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
    discordRoutes.post('/interactions',async(req,reply)=>{
      const signature=req.headers['x-signature-ed25519'], timestamp=req.headers['x-signature-timestamp'];
      if(typeof signature!=='string' || !/^[a-f\d]{128}$/i.test(signature) || typeof timestamp!=='string' || !/^\d{10,11}$/.test(timestamp)
        || Math.abs(Date.now()/1000-Number(timestamp))>300 || !Buffer.isBuffer(req.body)
        || !await verifyKey(req.body,signature,timestamp,c.DISCORD_PUBLIC_KEY)) return reply.code(401).send();
      let raw: unknown; try { raw=JSON.parse(req.body.toString('utf8')); } catch { return reply.code(400).send(); }
      if(raw && typeof raw==='object' && 'type' in raw && raw.type===1) return {type:1};
      const parsed=interactionSchema.safeParse(raw);
      if(!parsed.success || parsed.data.application_id!==c.DISCORD_APPLICATION_ID || ![2,3,4,5].includes(parsed.data.type)) {
        process.stderr.write('interaction_invalid\n');return reply.code(400).send();
      }
      const interaction=parsed.data;
      if(!await db.once('interaction:'+interaction.id)) return reply.code(204).send();
      try {
        let timer: NodeJS.Timeout | undefined;
        const prepared=await Promise.race([interactions.prepare(interaction),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Failure('busy')),2000);})]).finally(()=>clearTimeout(timer));
        reply.send(prepared.response);
        if(prepared.work) {
          const work=prepared.work().catch(()=>{}).finally(()=>inflight.delete(work));
          inflight.add(work);
        }
        return reply;
      } catch(e) { logFailure('interaction_prepare_failed',e);return interaction.type===4?{type:8,data:{choices:[]}}:{type:4,data:message(errorCopy(safeCode(e)))}; }
    });
  });
  for(const definition of storeDefinitions.values()) if(definition.hints) app.post(`/webhooks/${definition.id}/:secret`,async(req,reply)=>{
    const secret=(req.params as {secret:string}).secret;
    if(!/^[\w-]{32}$/.test(secret)) return reply.code(404).send();
    const store=await db.stores.findOne({provider:definition.id,webhookHash:await secrets.hash('webhook',secret),status:'active'});
    if(!store) return reply.code(404).send();
    await limits.take('webhook',store._id,30);
    const hint=definition.hints!.parse(req.body,store.ownerId);
    if(!hint) return reply.code(400).send();
    const {referenceId,membership}=hint;
    if(!referenceId || !await db.panels.findOne({[`stores.${definition.id}`]:store._id,mappings:{$elemMatch:{provider:definition.id,productId:hint.productId}}})) return reply.code(202).send();
    if(await db.hints.countDocuments({storeId:store._id})>=100) return reply.code(503).send();
    const key=await secrets.hash('hint',store._id,membership?'subscription':'sale',referenceId);
    // Pings are unordered triggers: one hint per sale/subscription. Each ping bumps
    // `pings`, so a refund arriving mid-read forces one more read of current state.
    await db.hints.updateOne({_id:key},{$set:{nextAt:new Date()},$inc:{pings:1},$setOnInsert:{storeId:store._id,reference:await secrets.seal(referenceId,key),membership,expiresAt:new Date(Date.now()+86400_000)}},{upsert:true});
    return reply.code(202).send();
  });
  app.register(auth.register);
  app.addHook('onClose',async()=>{await Promise.allSettled(inflight);});
  return app;
}

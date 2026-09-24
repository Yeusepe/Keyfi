import {createHash} from 'node:crypto';
import cookie from '@fastify/cookie';
import oauth2 from '@fastify/oauth2';
import {z} from 'zod';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {oauthConfigured, type Config} from './config.js';
import type {Database} from './db.js';
import {accessRow, type DiscordApi, errorCopy} from './discord.js';
import {Failure, id, logFailure, safeCode, type Secrets} from './security.js';
import {parse, readJson, type Limits} from './http.js';
import type {Service} from './service.js';
import type {Flow, Panel} from './model.js';

export const closeScript = 'const {app,web}=document.body.dataset;try{location.href=app;setTimeout(()=>{if(document.visibilityState==="visible")location.replace(web);},1500);}catch{location.replace(web);}';
export const closeScriptHash = createHash('sha256').update(closeScript).digest('base64');
export function closeDocument(guildId?: string, channelId?: string) {
  const channel = guildId && channelId && /^\d+$/.test(guildId) && /^\d+$/.test(channelId) ? `${guildId}/${channelId}` : '@me';
  const web = `https://discord.com/channels/${channel}`;
  const app = channel === '@me' ? 'discord://' : `discord://-/channels/${channel}`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body data-web="${web}" data-app="${app}"><script>${closeScript}</script></body>`;
}

export function createAuthentication(c: Config, db: Database, service: Service, discord: DiscordApi, secrets: Secrets, limits: Limits) {
  async function begin(panel: Panel, discordId: string, kind: Flow['kind'], interactionToken: string, channelId?: string, provider = 'gumroad') {
    if (provider !== 'gumroad') throw new Failure('unsupported_store');
    if (!oauthConfigured(c, kind)) throw new Failure('oauth_not_configured');
    const flow: Flow = {_id: id(), panelId: panel._id, guildId: panel.guildId, channelId, discordId, kind,
      expiresAt: new Date(Date.now() + 600_000), epoch: kind === 'buyer' && panel.stores.gumroad ? await service.subjectEpoch(discordId, panel.stores.gumroad) : ''};
    flow.interactionToken = await secrets.seal(interactionToken, flow._id);
    await db.flows.insertOne(flow);
    return `${c.BASE_URL}/connect/${flow._id}`;
  }
  async function flowFor(req: FastifyRequest) {
    const candidate = (req.params as {flowId?: string}).flowId ?? (req.query as {state?: string}).state;
    const flowId = parse(z.string().regex(/^[\w-]{32}$/), candidate);
    const flow = await db.flows.findOne({_id: flowId, expiresAt: {$gt: new Date()}, completed: {$ne: true}});
    if (!flow) throw new Failure('expired');
    return flow;
  }
  async function register(app: FastifyInstance) {
    const secure = c.BASE_URL.startsWith('https:');
    const cookieName = (name: string, type: string) => `${secure ? '__Host-' : ''}${name}-${type}`;
    await app.register(cookie);
    function settings(name: string) {
      return {
        cookie: {secure, path: '/'},
        redirectStateCookieName: cookieName(name, 'state'),
        verifierCookieName: cookieName(name, 'verifier'),
        generateStateFunction: (req: FastifyRequest) => (req.params as {flowId: string}).flowId,
        checkStateFunction: async (req: FastifyRequest) => {
          const state = (req.query as {state?: string}).state;
          return !!(state && req.cookies[cookieName(name, 'state')] === state
            && await db.flows.findOne({_id: state, expiresAt: {$gt: new Date()}, completed: {$ne: true}}));
        },
      };
    }
    if (c.DISCORD_CLIENT_SECRET) await app.register(oauth2, {
      ...settings('discord'), name: 'discord',
      credentials: {client: {id: c.DISCORD_APPLICATION_ID, secret: c.DISCORD_CLIENT_SECRET}, http: {timeout: 10_000},
        auth: {authorizeHost: 'https://discord.com', authorizePath: '/api/oauth2/authorize', tokenHost: 'https://discord.com', tokenPath: '/api/oauth2/token'}},
      scope: ['identify'], callbackUri: `${c.BASE_URL}/oauth/discord/callback`, callbackUriParams: {prompt: 'consent'}, pkce: 'S256',
    });
    for (const kind of ['buyer', 'creator'] as const) if (oauthConfigured(c, kind)) {
      const name = `gumroad${kind === 'buyer' ? 'Buyer' : 'Creator'}`;
      await app.register(oauth2, {
        ...settings(name), name,
        credentials: {
          http: {timeout: 10_000},
          client: {id: (kind === 'buyer' ? c.GUMROAD_BUYER_CLIENT_ID : c.GUMROAD_CREATOR_CLIENT_ID)!,
            secret: (kind === 'buyer' ? c.GUMROAD_BUYER_CLIENT_SECRET : c.GUMROAD_CREATOR_CLIENT_SECRET)!},
          auth: {authorizeHost: 'https://gumroad.com', authorizePath: '/oauth/authorize', tokenHost: 'https://api.gumroad.com', tokenPath: '/oauth/token'},
          options: {authorizationMethod: 'body'},
        },
        scope: kind === 'buyer' ? ['view_profile'] : ['view_profile', 'view_sales'],
        callbackUri: `${c.BASE_URL}/api/auth/callback/gumroad-${kind}`,
        pkce: 'S256',
      });
    }
    async function fail(flow: Flow, reply: FastifyReply, copy = '## Sign-in didn’t finish\nReturn to the Discord message where you started to try again.') {
      try {
        if (flow.interactionToken) await discord.reply(await secrets.open(flow.interactionToken, flow._id), copy, flow.kind === 'buyer' ? [accessRow()] : []);
      } catch { /* Ephemeral token may have expired. */ }
      finally { await db.flows.deleteOne({_id: flow._id}); }
      return reply.type('text/html').send(closeDocument(flow.guildId, flow.channelId));
    }
    app.setErrorHandler(async (error, req, reply) => {
      logFailure('oauth_request_failed',error);
      const flowId = (req.params as {flowId?: string}).flowId;
      const flow = flowId && /^[\w-]{32}$/.test(flowId)
        ? await db.flows.findOne({_id: flowId, expiresAt: {$gt: new Date()}, completed: {$ne: true}}) : null;
      if (flow) return fail(flow, reply, errorCopy(safeCode(error)));
      return reply.code(400).type('text/html').send(closeDocument());
    });
    app.get('/done', async (_req, reply) => reply.type('text/html').send(closeDocument()));
    app.get('/connect/:flowId', async (req, reply) => {
      const flow = await flowFor(req);
      await limits.take('oauth_start', flow.discordId, 5);
      return reply.redirect(await app.oauth2Discord!.generateAuthorizationUri(req, reply));
    });
    app.get('/oauth/discord/callback', async (req, reply) => {
      const flow = await flowFor(req);
      if ((req.query as {error?: string}).error) {
        if (req.cookies[cookieName('discord', 'state')] !== flow._id) return reply.code(400).type('text/html').send(closeDocument());
        return fail(flow, reply);
      }
      const {token} = await app.oauth2Discord!.getAccessTokenFromAuthorizationCodeFlow(req, reply);
      try {
        const response = await fetch('https://discord.com/api/v10/users/@me', {headers: {Authorization: `Bearer ${token.access_token}`}, redirect: 'error', signal: AbortSignal.timeout(10_000)});
        if (!response.ok) throw new Failure('expired');
        const profile = parse(z.object({id: z.string()}), await readJson(response, 32_768));
        if (profile.id !== flow.discordId) return fail(flow, reply, '## Discord account didn’t match\nReturn to the message where you started and try again with the same Discord account.');
        if (flow.kind === 'creator') await discord.administrator(flow.guildId, flow.discordId);
        await db.flows.updateOne({_id: flow._id, completed: {$ne: true}}, {$set: {discordVerified: true}});
        return reply.redirect(`/oauth/gumroad/start/${flow._id}`);
      } catch (error) { logFailure('discord_callback_failed',error); return fail(flow, reply, errorCopy(safeCode(error))); }
    });
    app.get('/oauth/gumroad/start/:flowId', async (req, reply) => {
      const flow = await flowFor(req);
      if (!flow.discordVerified) throw new Failure('expired');
      const provider = flow.kind === 'buyer' ? app.oauth2GumroadBuyer : app.oauth2GumroadCreator;
      return reply.redirect(await provider!.generateAuthorizationUri(req, reply));
    });
    const gumroadCallback = async (req: FastifyRequest, reply: FastifyReply) => {
      const flow = await flowFor(req);
      if (req.routeOptions.url !== `/api/auth/callback/gumroad-${flow.kind}`) throw new Failure('expired');
      if (!flow.discordVerified) throw new Failure('expired');
      const name = flow.kind === 'buyer' ? 'gumroadBuyer' : 'gumroadCreator';
      if ((req.query as {error?: string}).error) {
        if (req.cookies[cookieName(name, 'state')] !== flow._id) return reply.code(400).type('text/html').send(closeDocument());
        return fail(flow, reply);
      }
      const provider = flow.kind === 'buyer' ? app.oauth2GumroadBuyer : app.oauth2GumroadCreator;
      const {token} = await provider!.getAccessTokenFromAuthorizationCodeFlow(req, reply);
      try {
        await limits.take('oauth_profile', flow.discordId, 6);
        const response = await fetch('https://api.gumroad.com/v2/user', {headers: {Authorization: `Bearer ${token.access_token}`}, redirect: 'error', signal: AbortSignal.timeout(10_000)});
        if (!response.ok) throw new Failure('expired');
        const profile = parse(z.object({success: z.literal(true), user: z.object({user_id: z.string().min(1)})}), await readJson(response, 32_768));
        if (!(await db.flows.updateOne({_id: flow._id, discordVerified: true, completed: {$ne: true}, expiresAt: {$gt: new Date()}}, {$set: {completed: true}})).modifiedCount) throw new Failure('expired');
        const panel = await service.panel(flow.panelId, flow.guildId);
        if (flow.kind === 'creator') {
          await service.connect(panel._id, flow.discordId, 'gumroad', profile.user.user_id, token.access_token);
          await db.setupViews.updateOne({_id: panel._id, discordId: flow.discordId, waitingForOAuth: true}, {$set: {signature: ''}, $unset: {waitingForOAuth: ''}});
        } else {
          const storeId = panel.stores.gumroad; if (!storeId) throw new Failure('store_disconnected');
          const hash = await secrets.hash('gumroad-buyer', storeId, profile.user.user_id);
          await service.linkBuyer(flow.discordId, hash, flow.epoch, storeId);
          if (flow.interactionToken) await service.queueAccount(panel, flow.discordId, hash, await secrets.open(flow.interactionToken, flow._id), flow.epoch, flow.expiresAt);
        }
      } catch (error) {
        logFailure('gumroad_callback_failed',error);
        if (flow.interactionToken) try { await discord.reply(await secrets.open(flow.interactionToken, flow._id), errorCopy(safeCode(error)), flow.kind === 'buyer' ? [accessRow()] : []); } catch { /* Ephemeral token may have expired. */ }
      } finally { await db.flows.deleteOne({_id: flow._id}); }
      return reply.type('text/html').send(closeDocument(flow.guildId, flow.channelId));
    };
    app.get('/api/auth/callback/gumroad-buyer', gumroadCallback);
    app.get('/api/auth/callback/gumroad-creator', gumroadCallback);
  }
  return {begin, register};
}
export type Authentication = ReturnType<typeof createAuthentication>;

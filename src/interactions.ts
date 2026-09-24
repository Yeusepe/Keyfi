import { ActionRowBuilder, FileBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder, Routes, PermissionFlagsBits, MessageFlags, type ContainerComponentBuilder } from 'discord.js';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Filter } from 'mongodb';
import type { Limits } from './http.js';
import type { Database } from './db.js';
import { accessRow, button, DiscordApi, display, divider, errorCopy, message, panelMessage, roleSummary, row, section } from './discord.js';
import type { Authentication } from './auth.js';
import type { Service } from './service.js';
import { Failure, id, logFailure, productNameKey, safeCode, text } from './security.js';
import { providerFor, storeDefinition, storeDefinitions } from './stores/registry.js';
import type { Action, CatalogProduct, Mapping, Panel, Provider, Store } from './model.js';
import { buyerNotice, creatorPrivacy } from './notices.js';

export const interactionSchema = z.object({id: z.string().regex(/^\d+$/), application_id: z.string(), type: z.number(), token: z.string(), guild_id: z.string().regex(/^\d+$/), channel_id: z.string().optional(),
  member: z.object({user: z.object({id: z.string().regex(/^\d+$/)}), permissions: z.string().regex(/^\d+$/)}),
  message: z.object({id: z.string(), flags: z.number().optional()}).optional(),
  data: z.object({name: z.string().optional(), custom_id: z.string().optional(), values: z.array(z.string()).optional(), components: z.array(z.unknown()).optional(),
    options: z.array(z.object({name: z.string(), value: z.unknown().optional(), options: z.array(z.object({name:z.string(),value:z.unknown().optional(),focused:z.boolean().optional()})).optional()})).optional()}),
});
export type Interaction = z.infer<typeof interactionSchema>;
const pageSize = 10, rolePageSize = 5;
function pageInfo(requested: number, total: number, size = pageSize) {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages - 1, Math.max(0, Number.isFinite(requested) ? Math.trunc(requested) : 0));
  const start = page * size, end = Math.min(start + size, total);
  return {page, pages, start, end, label: total ? `Page ${page + 1} of ${pages} · ${start + 1}–${end} of ${total}` : ''};
}
// Preserve distinguishing suffixes in native selectors with Discord's 100-character limit.
const optionText = (value: string) => {
  const plain = value.replace(/\s+/g, ' ').trim();
  return plain.length > 100 ? `${plain.slice(0, 69)}…${plain.slice(-30)}` : plain || 'Untitled';
};
export class Interactions {
  constructor(private db: Database, private service: Service, private discord: DiscordApi, private auth: Authentication, private limits: Limits, private contact = 'the Keyfi operator') {}
  private actor(i: Interaction) { return i.member.user.id; }
  private isAdmin(i: Interaction) { return !!(BigInt(i.member.permissions) & (PermissionFlagsBits.ManageGuild | PermissionFlagsBits.Administrator)); }
  private async action(i: Interaction, panelId: string, action: string, data?: Record<string,string>) {
    const a: Action = {_id: id(), panelId, guildId: i.guild_id, discordId: this.actor(i), action, data, expiresAt: new Date(Date.now()+600_000)};
    await this.db.actions.insertOne(a); return `action:${a._id}`;
  }
  private async takeAction(i: Interaction) {
    const actionId = i.data.custom_id?.split(':')[1];
    const a = await this.db.actions.findOneAndDelete({_id: actionId, guildId: i.guild_id, discordId: this.actor(i), expiresAt: {$gt: new Date()}});
    if (!a) throw new Failure('expired'); return a;
  }
  private async send(i: Interaction, body: object, files?: {name: string; data: Buffer}[]) { await this.discord.call('patch', Routes.webhookMessage(this.discord.applicationId, i.token, '@original'), body, files); }
  private modal(customId: string, title: string, label: string, description: string) {
    return {type: 9, data: new ModalBuilder().setCustomId(customId).setTitle(title).addLabelComponents(
      new LabelBuilder().setLabel(label).setDescription(description).setTextInputComponent(new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(160)),
    ).toJSON()};
  }
  private value(i: Interaction) {
    const values: string[] = [];
    const walk = (component: unknown) => {
      if (!component || typeof component !== 'object') return;
      const c = component as {custom_id?: string; value?: unknown; component?: unknown; components?: unknown[]};
      if (c.custom_id === 'value' && typeof c.value === 'string') values.push(c.value);
      if (c.component) walk(c.component); if (c.components) c.components.forEach(walk);
    };
    i.data.components?.forEach(walk);
    if (values.length !== 1) throw new Failure('invalid_key'); return values[0]!;
  }
  async prepare(i: Interaction): Promise<{response: object; work?: () => Promise<void>}> {
    if(i.type===4) {
      let choices: {name:string;value:string}[]=[];
      try {
        if(!this.isAdmin(i) || i.data.name!=='keyfi' || i.data.options?.[0]?.name!=='map') return {response:{type:8,data:{choices}}};
        await this.limits.take('autocomplete_user',this.actor(i),60);
        const focused=i.data.options[0].options?.find(o=>o.focused);
        if(focused?.name==='product' && typeof focused.value==='string' && focused.value.length<=160) {
          const panels=await this.db.panels.find({guildId:i.guild_id,administrator:this.actor(i),active:true}).toArray();
          const products=await this.catalogChoices(panels,{storeId:{$in:panels.flatMap(p=>Object.values(p.stores))},name:{$regex:focused.value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),$options:'i'}},0,25);
          choices=products.map(p=>({name:optionText(`${providerFor(panels.find(panel=>Object.values(panel.stores).includes(p.storeId))!,p.storeId).name} · ${p.name}${p.mapped?' · Added':''}`),value:p._id}));
        }
      } catch { /* Autocomplete always returns a valid, private empty result on failure. */ }
      return {response:{type:8,data:{choices}}};
    }
    await this.limits.take('interaction_user', this.actor(i), 20);
    if(i.data.name==='keyfi' && !this.isAdmin(i)) throw new Failure('admin_required');
    const custom = i.data.custom_id;
    if (custom === 'keyfi:privacy') return {response: {type: i.message?.flags&&i.message.flags&MessageFlags.Ephemeral?7:4,
      data: message(buyerNotice(this.contact),[],[row(button(i.message?.flags&&i.message.flags&MessageFlags.Ephemeral?'Back to Privacy & Data':'Privacy & Data',await this.action(i,'','privacy-settings')))])}};
    if (i.data.name === 'keyfi' && i.data.options?.[0]?.name === 'privacy') return {response: {type: 4, data: message(creatorPrivacy(this.contact))}};
    if (custom?.startsWith('verify:key:')) {
      const p = await this.service.panel(custom.slice(11), i.guild_id);
      if (!p.messages.some(m=>m.messageId===i.message?.id && m.channelId===i.channel_id)) throw new Failure('expired');
      const key = await this.action(i, p._id, 'license');
      return {response: this.modal(key, 'Verify your purchase', 'License key', 'Paste the full key from your receipt. Discord processes this form; Keyfi never saves the key.')};
    }
    let action: Action | undefined;
    if (custom?.startsWith('action:')) {
      action = await this.takeAction(i);
      if(!['license','enter-license','delete-confirm','delete','recheck','verification','privacy-settings','relink','unlink','show-data'].includes(action.action) && !this.isAdmin(i)) throw new Failure('admin_required');
      await this.db.setupViews.deleteMany({discordId:this.actor(i),guildId:i.guild_id});
      if(action.action==='enter-license') {
        await this.service.panel(action.panelId,i.guild_id);
        return {response:this.modal(await this.action(i,action.panelId,'license'),'Verify your purchase','License key','Paste the full key from your receipt. Discord processes this form; Keyfi never saves the key.')};
      }
      const connection=action.action==='connect-store'?storeDefinition(action.data?.provider??''):undefined;
      if (action.action==='search' || connection?.connection.type==='api-key') {
        await this.admin(i,await this.service.panel(action.panelId,i.guild_id));
        const next = await this.action(i, action.panelId, action.action === 'search' ? 'search-submit' : 'credential-submit', action.data);
        return {response: this.modal(next, action.action === 'search' ? 'Find a product' : `Connect ${connection!.name}`, action.action === 'search' ? 'Product name' : 'Read-only API key',
          action.action === 'search' ? 'Enter all or part of the product name.' : connection!.connection.type==='api-key'?connection!.connection.description:'')};
      }
    }
    const work = async () => {
      try { await this.run(i, action); }
      catch(e) {
        logFailure('interaction_work_failed',e);
        try {
          const recovery=action?.action==='license'?[row(button('Enter License Key…',await this.action(i,action.panelId,'enter-license'),ButtonStyle.Primary)),accessRow()]:[];
          await this.send(i, message(errorCopy(safeCode(e)),recovery.slice(0,1),recovery.slice(1)));
        } catch { process.stderr.write('interaction_reply_failed\n'); }
      }
    };
    const update = [3,5].includes(i.type) && !!((i.message?.flags??0)&MessageFlags.Ephemeral);
    return {response: update ? {type:6} : {type: 5, data: {flags: MessageFlags.Ephemeral}}, work};
  }
  async admin(i: Interaction, panel: Panel) {
    await this.discord.administrator(i.guild_id, this.actor(i));
    if (panel.administrator !== this.actor(i)) throw new Failure('admin_required');
  }
  private async back(i: Interaction, panelId: string, label='Back to Setup') { return button(label,await this.action(i,panelId,'settings')); }
  private async setupState(panel: Panel) {
    const storeIds=Object.values(panel.stores), count=await this.db.catalog.countDocuments({storeId:{$in:storeIds}});
    const tasks=await this.db.catalogJobs.find({_id:{$in:storeIds},syncing:{$ne:false}}).toArray();
    const step=!storeIds.length?'1 of 3 · Connect a store':!panel.mappings.length?'2 of 3 · Choose a product and role':panel.messages.length?'Buyer panel published':'3 of 3 · Publish verification';
    const sync=tasks.some(t=>t.error==='store_reconnect')?'Reconnect a store to resume syncing.':tasks.some(t=>t.error)?'Sync delayed. Retrying automatically.':tasks.length?'Syncing products…':`${count} ${count===1?'product':'products'} available.`;
    let account='';
    if(panel.mappings.some(m=>storeDefinition(m.provider).buyerSignIn)) {
      if(!this.service.buyerOAuthEnabled) account='Account sign-in is unavailable. License keys work now.';
      else if(await this.service.ready(panel)) account='Account sign-in is ready.';
      else {
        const query={storeId:panel.stores.gumroad,productId:{$in:[...new Set(panel.mappings.filter(m=>m.provider==='gumroad').map(m=>m.productId))]}};
        const [purchases,scans]=await Promise.all([this.db.lookups.countDocuments(query),this.db.sync.find(query).toArray()]);
        const failed=scans.find(s=>!s.initialComplete&&s.error);
        const status=failed?.error==='store_reconnect'?'Reconnect Gumroad to resume.':failed?`Sync delayed. Retrying <t:${Math.floor(failed.nextAt.getTime()/1000)}:R>.`:'Sign-in enables when the scan finishes.';
        account=`Preparing account sign-in: ${purchases.toLocaleString('en-US')} purchases indexed · ${scans.filter(s=>s.initialComplete).length} of ${query.productId.$in.length} products ready. ${status} License keys work now.`;
      }
    }
    const copy=`## Verification setup\n${step}`;
    return {copy,count,sync,account,signature:JSON.stringify([copy,count,sync,account,panel.stores,panel.mappings,panel.messages])};
  }
  private async watch(i: Interaction, panel: Panel, signature: string, waitingForOAuth=false) {
    await this.db.setupViews.replaceOne({_id:panel._id},{discordId:this.actor(i),guildId:i.guild_id,channelId:i.channel_id,
      token:await this.service.secrets.seal(i.token,`setup:${panel._id}`),version:id(),signature,waitingForOAuth,expiresAt:new Date(Date.now()+600_000)},{upsert:true});
  }
  async settings(i: Interaction, panel: Panel, notice='', watching=true) {
    const state=await this.setupState(panel), content: ContainerComponentBuilder[]=[];
    if(notice) content.push(display(notice));
    if(!Object.keys(panel.stores).length) {
      content.push(...await this.connections(i,panel));
      content.push(display('-# Products sync automatically. Connecting accepts the data terms in /keyfi privacy.'));
    }
    else {
      content.push(section(`**Stores**\n${state.sync}`,button('Stores',await this.action(i,panel._id,'stores'))));
      content.push(section(`**Product roles**\n${panel.mappings.length?`${panel.mappings.length} configured. Add or change who receives a role.`:'Choose a product and the role its buyers receive.'}`,
        panel.mappings.length?button('Product Roles',await this.action(i,panel._id,'roles')):button('Choose Product…',await this.action(i,panel._id,'products',{page:'0'}),ButtonStyle.Primary).setDisabled(!state.count)));
      if(panel.mappings.length) {
        content.push(divider());
        content.push(section(`**Verification messages**\n${panel.messages.length?`Published in ${panel.messages.length} ${panel.messages.length===1?'channel':'channels'}. Changes update automatically.\n`:''}Create or refresh the message in this channel. Open **/keyfi setup** in another channel to publish there too.${state.account?'\n'+state.account:''}`,button('Publish Verification',await this.action(i,panel._id,'publish'),ButtonStyle.Primary)));
      }
    }
    await this.send(i,message(state.copy,content,[row(button('All Panels',await this.action(i,'','panels')),button('Delete Panel…',await this.action(i,panel._id,'delete-panel-confirm')))]));
    if(watching) await this.watch(i,panel,state.signature);
  }
  async refreshSetup(panelId: string, oauthFinished=false): Promise<boolean> {
    const view=await this.db.setupViews.findOne({_id:panelId,expiresAt:{$gt:new Date()}}); if(!view) return false;
    if(view.waitingForOAuth && !oauthFinished) return false;
    const panel=await this.service.panel(panelId,view.guildId), state=await this.setupState(panel);
    if(state.signature===view.signature && !oauthFinished) return false;
    const i: Interaction={id:'0',application_id:this.discord.applicationId,type:3,token:await this.service.secrets.open(view.token,`setup:${panelId}`),guild_id:view.guildId,channel_id:view.channelId,member:{user:{id:view.discordId},permissions:'0'},data:{}};
    try { await this.admin(i,panel); } catch(e) {
      if(safeCode(e)==='admin_required') await this.db.setupViews.deleteOne({_id:panelId,version:view.version});
      throw e;
    }
    if(!await this.db.setupViews.findOne({_id:panelId,version:view.version})) return false;
    await this.settings(i,panel,'',false);
    await this.db.setupViews.updateOne({_id:panelId,version:view.version},{$set:{signature:state.signature},$unset:{waitingForOAuth:''}});
    return true;
  }
  private async pagination(i: Interaction, panelId: string, action: string, page: ReturnType<typeof pageInfo>, data: Record<string,string> = {}) {
    if(page.pages===1) return [];
    const buttons: ButtonBuilder[]=[];
    for(const [label,target,disabled] of [
      ['First',0,page.page===0], ['Previous',page.page-1,page.page===0],
      ['Next',page.page+1,page.page===page.pages-1], ['Last',page.pages-1,page.page===page.pages-1],
    ] as const) buttons.push(button(label,await this.action(i,panelId,action,{...data,page:String(target)})).setDisabled(disabled));
    return [row(...buttons)];
  }
  private async connections(i: Interaction, panel: Panel) {
    const sections=[];
    for(const definition of storeDefinitions.values()) {
      const connected=!!panel.stores[definition.id];
      sections.push(section(`**${definition.name}**\n${connected?'Connected':definition.connection.type==='oauth'?'Connect your creator account.':'Connect with a read-only API key.'}`,
        button(`${connected?'Manage':'Connect'} ${definition.name}`,await this.action(i,panel._id,connected?'store':'connect-store',{provider:definition.id}))));
    }
    return sections;
  }
  async select(i: Interaction, copy: string, actionId: string, options: {label: string; value: string; description?: string}[], extra: ContainerComponentBuilder[] = [], placeholder='Choose an item') {
    if (!options.length) return this.send(i, message(copy,extra));
    const menu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(actionId).setPlaceholder(placeholder).addOptions(options.map(o => ({...o,label:optionText(o.label),description:o.description?optionText(o.description):undefined}))));
    return this.send(i,message(copy,[menu,...extra]));
  }
  private catalogChoices(panels: Panel[], query: Filter<CatalogProduct>, skip: number, limit: number) {
    const mapped=panels.flatMap(p=>p.mappings.filter(m=>p.stores[m.provider]).map(m=>[p.stores[m.provider],m.productId]));
    return this.db.catalog.aggregate<Pick<CatalogProduct,'_id'|'name'|'storeId'> & {mapped:boolean}>([
      {$match:query}, {$project:{name:1,storeId:1,productId:1}},
      {$set:{mapped:{$in:[['$storeId','$productId'],{$literal:mapped}]}}},
      {$sort:{mapped:1,name:1,_id:1}}, {$skip:skip}, {$limit:limit},
    ]).toArray();
  }
  async products(i: Interaction, panel: Panel, page: number, search = '') {
    const query = {storeId: {$in: Object.values(panel.stores)}, ...(search ? {name: {$regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i'}} : {})};
    const paging = pageInfo(page, await this.db.catalog.countDocuments(query));
    const products = await this.catalogChoices([panel],query,paging.start,pageSize);
    const action = await this.action(i, panel._id, 'product-selected', {productPage:String(paging.page),search});
    const nav = [button('Filter Products…', await this.action(i, panel._id, 'search'))];
    if(search) nav.push(button('Clear Filter',await this.action(i,panel._id,'products',{page:'0'})));
    const copy = `## Choose a product\n${search?`Filter: **${text(search)}**\n`:''}${products.length?`${paging.label} products\nChoose a product, then its buyer role.`:search?'No products match. Change or clear the filter.':'No products available yet. Check sync progress in setup.'}`;
    return this.select(i, copy, action, products.map(p => ({label: p.name, value: p._id, description: `${providerFor(panel,p.storeId).name}${p.mapped?' · Added':''}`})),
      [...await this.pagination(i,panel._id,'products',paging,{search}),row(...nav),divider(),row(button('Back to Product Roles',await this.action(i,panel._id,'roles')))],'Choose a product');
  }
  private async panels(i: Interaction, requested = 0, notice = '') {
    const query={guildId:i.guild_id,administrator:this.actor(i),active:true};
    const paging=pageInfo(requested,await this.db.panels.countDocuments(query));
    const panels=await this.db.panels.find(query).sort({createdAt:1,_id:1}).skip(paging.start).limit(pageSize).toArray();
    return this.select(i,`## Choose a creator panel\n${notice?notice+'\n\n':''}${panels.length?`${paging.label} panels`:'No panels available. Use **/keyfi setup** to create one.'}`,await this.action(i,'','edit'),
      panels.map((p,n)=>({label:`Panel ${paging.start+n+1}`,value:p._id,description:`${p.mappings.length} product roles · ${p.messages.length?'Published':'Not published'}`})),
      await this.pagination(i,'','panels',paging),'Choose a creator panel');
  }
  private async mappingAudiences(panel: Panel, mappings: Mapping[]) {
    const products=await this.db.catalog.find({storeId:{$in:Object.values(panel.stores)},productId:{$in:mappings.map(m=>m.productId)}}).toArray();
    return mappings.map(m=>`${storeDefinition(m.provider).name} · ${m.variant?products.find(p=>p.storeId===panel.stores[m.provider]&&p.productId===m.productId)?.variants.find(v=>v.id===m.variant)?.name??`Version ${m.variant}`:'All versions'}`);
  }
  private async productRoles(i: Interaction, panel: Panel, requested = 0, notice = '') {
    const paging=pageInfo(requested,panel.mappings.length,rolePageSize), mappings=panel.mappings.slice(paging.start,paging.end);
    const audiences=await this.mappingAudiences(panel,mappings);
    const copy=`## Product roles\n${notice?notice+'\n\n':''}${mappings.length?`${paging.label} product roles`:'No product roles yet. Add a product to choose the role its buyers receive.'}`;
    const entries=[];
    for(const [n,m] of mappings.entries()) entries.push(section(`**${text(optionText(m.label))}**\n${text(optionText(audiences[n]!))}\n<@&${m.roleId}>`,
      button('Remove…',await this.action(i,panel._id,'remove-selected',{page:String(paging.page),mapping:JSON.stringify(m)}))));
    return this.send(i,message(section(copy,button('Add Product…',await this.action(i,panel._id,'products',{page:'0'}),ButtonStyle.Primary)),
      [...entries,...await this.pagination(i,panel._id,'roles',paging)],[row(await this.back(i,panel._id))]));
  }
  private async run(i: Interaction, action?: Action) {
    const actor = this.actor(i), custom = i.data.custom_id;
    if (i.data.name === 'verification' || custom==='keyfi:verification' || action?.action==='verification') return this.manageAccess(i);
    if(action?.action==='privacy-settings') return this.privacySettings(i);
    if (i.data.name === 'keyfi') {
      await this.discord.administrator(i.guild_id, actor);
      const sub = i.data.options?.[0]?.name;
      const panels = await this.db.panels.find({guildId: i.guild_id, administrator: actor, active: true}).limit(25).toArray();
      if(sub==='map') {
        const options=i.data.options?.[0]?.options,productId=options?.find(o=>o.name==='product')?.value,roleId=options?.find(o=>o.name==='role')?.value;
        if(typeof productId!=='string' || typeof roleId!=='string' || !/^\d+$/.test(roleId)) throw new Failure('mapping_required');
        const product=await this.db.catalog.findOne({_id:productId,storeId:{$in:panels.flatMap(p=>Object.values(p.stores))}});
        if(!product) throw new Failure('expired');
        const matches=panels.filter(p=>Object.values(p.stores).includes(product.storeId));
        if(matches.length!==1) throw new Failure('panel_required');
        const panel=matches[0]!,provider=providerFor(panel,product.storeId).id;
        if(await this.suggestStores(i,panel,product._id,{roleId})) return;
        await this.service.addMapping(panel,{provider,productId:product.productId,roleId,label:product.name,membership:product.membership});
        return this.settings(i,await this.service.panel(panel._id),'Product role saved for all versions. You can reuse this role for other products.');
      }
      if (sub === 'create' || !panels.length) {
        const panel: Panel = {_id: id(), guildId: i.guild_id, administrator: actor, stores: {}, mappings: [], messages: [], active: true, createdAt: new Date()};
        if (await this.db.panels.countDocuments({guildId: i.guild_id, administrator: actor}) >= 25) throw new Failure('panel_limit');
        await this.db.panels.insertOne(panel); return this.settings(i, panel);
      }
      if (panels.length === 1) return this.settings(i, panels[0]!);
      return this.panels(i);
    }
    if (custom?.startsWith('verify:oauth:')) {
      const panel = await this.service.panel(custom.slice(13), i.guild_id);
      if (!panel.messages.some(m=>m.messageId===i.message?.id && m.channelId===i.channel_id)) throw new Failure('expired');
      if (!await this.service.ready(panel)) throw new Failure('index_pending');
      const subject = await this.db.subjects.findOne({_id: await this.service.storeSubject(actor, panel.stores.gumroad!)});
      if (subject?.gumroadHash) {
        await this.service.queueAccount(panel,actor,subject.gumroadHash,i.token);
        return this.send(i,message('## Checking purchases…\nUsing your linked Gumroad account for this creator. The result will appear here.',
          [row(button('Change Account…',await this.action(i,panel._id,'relink')))]));
      }
      return this.connectGumroad(i, panel);
    }
    if (!action) throw new Failure('expired');
    if (action.action === 'delete-confirm') return this.send(i, message('## Delete your data and roles?\nThis removes your Keyfi roles and verification data from **every server** where you use Keyfi. You can verify again after removal finishes.\n\nA one-way opt-out code prevents old records from being imported again.', [row(button('Cancel',await this.action(i,'','privacy-settings')),button('Delete Data', await this.action(i, '', 'delete'), ButtonStyle.Danger))]));
    if (action.action === 'delete') { await this.service.requestDeletion(actor); return this.send(i, message('## Removing data…\nKeyfi is removing your roles, then your verification data. This may take a few minutes.',[],[accessRow()])); }
    if (action.action === 'show-data') {
      const data = Buffer.from(JSON.stringify(await this.service.exportSubject(actor), null, 2));
      const body = message('## Your verification data\nOnly you can see this download.',[new FileBuilder().setURL('attachment://keyfi-data.json')],[row(button('Back to Privacy & Data',await this.action(i,'','privacy-settings')))]);
      return this.send(i, {...body, attachments:[{id:0,filename:'keyfi-data.json'}]}, [{name: 'keyfi-data.json', data}]);
    }
    if (action.action === 'relink') return this.connectGumroad(i, await this.service.panel(action.panelId, i.guild_id));
    if (action.action === 'unlink') {
      await this.service.unlinkBuyer(actor);
      return this.privacySettings(i,'Gumroad disconnected. Your verified purchases and roles are still saved.');
    }
    if (action.action === 'recheck') {
      const codes=await this.service.codes(actor);
      if(await this.db.subjects.countDocuments({_id:{$in:codes.stores},deleting:true}) || await this.db.members.countDocuments({_id:{$in:codes.members},deleting:true})) throw new Failure('deleting');
      return this.db.withLease(`recheck:${await this.service.secrets.hash('recheck',actor)}`,async()=>{
        const requestedAt=new Date();
        const queued=await this.db.claims.updateMany({subject:{$in:codes.stores}},{$set:{nextCheckAt:requestedAt}});
        if(!queued.matchedCount) return this.manageAccess(i);
        await this.send(i,message(`## Checking ${queued.matchedCount} ${queued.matchedCount===1?'purchase':'purchases'}…\nThe result will appear here. Existing access stays in place if a store cannot be reached.`));
        const deadline=Date.now()+30_000;
        while(Date.now()<deadline) {
          if(!await this.db.claims.countDocuments({subject:{$in:codes.stores},nextCheckAt:{$lte:requestedAt}}) && !await this.db.members.countDocuments({_id:{$in:codes.members},dirty:true})) break;
          await delay(1000);
        }
        return this.manageAccess(i,requestedAt);
      });
    }
    const selected = i.data.values?.[0];
    if (action.action === 'panels') { await this.discord.administrator(i.guild_id,actor); return this.panels(i,Number(action.data?.page??0)); }
    if (action.action === 'edit') { const p = await this.service.panel(selected ?? '', i.guild_id); await this.admin(i,p); return this.settings(i,p); }
    const panel = await this.service.panel(action.panelId, i.guild_id);
    if (action.action === 'license') {
      await this.limits.take('verify_key_user', actor, 10, 600);
      return this.send(i, message(roleSummary(await this.service.verifyKey(panel, actor, this.value(i))),[],[accessRow()]));
    }
    await this.admin(i, panel);
    if(action.action==='settings') return this.settings(i,panel);
    if(action.action==='delete-panel-confirm') return this.send(i,message(`## Delete this panel?\nThis removes its ${panel.mappings.length} product roles and ${panel.messages.length} published verification messages. Buyers lose roles granted only through this panel. Stores and access used by other panels stay connected.`,[
      row(button('Cancel',await this.action(i,panel._id,'settings')),button('Delete Panel',await this.action(i,panel._id,'delete-panel'),ButtonStyle.Danger)),
    ]));
    if(action.action==='delete-panel') {
      await this.db.withLease(`panel:${panel._id}`,async()=>{
        const current=await this.service.panel(panel._id,i.guild_id);
        for(const location of current.messages) {
          try { await this.discord.call('delete',Routes.channelMessage(location.channelId,location.messageId)); }
          catch(e) { if(safeCode(e)!=='message_missing') throw e; }
          await this.db.panels.updateOne({_id:panel._id},{$pull:{messages:location}});
        }
        await this.service.deletePanel(panel._id,actor);
      });
      return this.panels(i,0,'Panel deleted. Buyer roles will update automatically.');
    }
    if(action.action==='sync' || action.action==='catalog') {
      const queued=await this.service.syncStores(panel._id,actor);
      return this.settings(i,panel,queued?'Sync queued. Products and mapped Gumroad purchases will update automatically.':'Sync is already running or was requested recently. Your current progress is saved.');
    }
    if(action.action==='stores' || action.action==='manage') return this.send(i,message('## Stores', [
      ...await this.connections(i,panel),divider(),
      section('**Automatic sync**\nChecks for changes every six hours. Sync now to check sooner.',button('Sync Now',await this.action(i,panel._id,'sync')).setDisabled(!Object.keys(panel.stores).length)),
    ],[row(await this.back(i,panel._id))]));
    if(action.action==='store') {
      const definition=storeDefinition(action.data?.provider??'');
      if(!panel.stores[definition.id]) throw new Failure('expired');
      return this.send(i,message(`## ${definition.name}\nConnected to this verification panel.`,[
        section('**Connection**\nAuthorize the store again if its credentials have changed.',button(`Reconnect ${definition.name}`,await this.action(i,panel._id,'connect-store',{provider:definition.id}))),divider(),
        section('**Disconnect store**\nRemove this store and the roles it grants through this panel.',button('Disconnect…',await this.action(i,panel._id,'disconnect-confirm',{provider:definition.id}))),
      ],[row(button('Back to Stores',await this.action(i,panel._id,'stores')))]));
    }
    if(action.action==='roles') return this.productRoles(i,panel,Number(action.data?.page??0));
    if (action.action === 'connect-store') {
      const definition=storeDefinition(action.data?.provider??'');
      if(definition.connection.type!=='oauth') throw new Failure('expired');
      await this.send(i, message(`## Connect ${definition.name}\nSign in to Discord, then authorize read-only store access. Products sync automatically, and setup resumes here.`, [row(new ButtonBuilder().setLabel('Continue in Browser').setStyle(ButtonStyle.Link).setURL(await this.auth.begin(panel, actor, 'creator', i.token, i.channel_id, definition.id)))],[row(await this.back(i,panel._id))]));
      return this.watch(i,panel,(await this.setupState(panel)).signature,true);
    }
    if (action.action === 'credential-submit') {
      const provider=storeDefinition(action.data?.provider??'').id, adapter=this.service.providers.get(provider);
      if(!adapter.identify) throw new Failure('unsupported_store');
      const token = this.value(i).trim(), tempId = await this.service.secrets.hash('credential-budget',this.value(i).trim());
      const temporary: Store = {_id: tempId, provider, ownerId: '', credential: await this.service.secrets.seal(token, tempId), administrator: actor, status: 'active', createdAt: new Date()};
      await this.service.connect(panel._id, actor, provider, await adapter.identify(temporary), token);
      return this.settings(i, await this.service.panel(panel._id));
    }
    if (action.action === 'products' || action.action === 'search-submit') return this.products(i,panel,action.action === 'search-submit' ? 0 : Number(action.data?.page ?? 0),action.action === 'search-submit' ? this.value(i).trim() : action.data?.search);
    if (action.action === 'product-selected' || action.action === 'single-product' || action.action === 'variants') {
      const p = await this.db.catalog.findOne({_id: action.action==='product-selected' ? selected : action.data?.catalogId, storeId: {$in: Object.values(panel.stores)}}); if (!p) throw new Failure('expired');
      const provider = providerFor(panel,p.storeId).id;
      if(action.action==='product-selected' && await this.suggestStores(i,panel,p._id,action.data??{})) return;
      if(action.action==='single-product' && action.data?.roleId) {
        await this.service.mapProducts(panel,[p._id],action.data.roleId,productNameKey(p.name));
        return this.settings(i,await this.service.panel(panel._id),'Product role saved.');
      }
      if (action.action!=='variants') {
        const store = await this.db.stores.findOne({_id:p.storeId}); if (!store) throw new Failure('expired');
        p.variants = await this.service.providers.versions(store,p);
        await this.db.catalog.updateOne({_id:p._id},{$set:{variants:p.variants}});
      }
      const data = {catalogId:p._id,provider,productPage:action.data?.productPage??'0',search:action.data?.search??''};
      if(!p.variants.length) return this.chooseRole(i,panel,{...data,variant:''},p.name);
      const paging=pageInfo(Number(action.data?.page??0),p.variants.length), variants=p.variants.slice(paging.start,paging.end);
      const snapshot=Object.fromEntries(variants.map((v,n)=>[String(n),v.id]));
      return this.select(i, `## Choose buyers\n**${text(p.name)}**\n${paging.label} versions\nChoose a version, or include all buyers.`,
        await this.action(i,panel._id,'variant-selected',{...data,page:String(paging.page),snapshot:JSON.stringify(snapshot)}),
        [{label:'All buyers',value:'all',description:'Includes every version'},...variants.map((v,n)=>({label:v.name,value:String(n)}))],
        [...await this.pagination(i,panel._id,'variants',paging,data),divider(),row(button('Back to Products',await this.action(i,panel._id,'products',{page:data.productPage,search:data.search})))],'Choose buyers');
    }
    if (action.action === 'variant-selected') {
      const p = await this.db.catalog.findOne({_id:action.data?.catalogId,storeId:{$in:Object.values(panel.stores)}}); if (!p) throw new Failure('expired');
      const variant = selected === 'all' ? '' : (JSON.parse(action.data!.snapshot!) as Record<string,string>)[selected??''];
      if (variant === undefined) throw new Failure('expired');
      const {snapshot:_,...data}=action.data!;
      return this.chooseRole(i,panel,{...data,variant},p.name,variant?p.variants.find(v=>v.id===variant)?.name??`Version ${variant}`:'All versions');
    }
    if(action.action==='shared-products') {
      const data=action.data!,ids=JSON.parse(data.catalogIds!) as string[];
      const products=await this.service.matchingProducts(panel,ids[0]!);
      if(products.length!==ids.length || products.some(p=>!ids.includes(p._id))) throw new Failure('expired');
      if(data.roleId) {
        await this.service.mapProducts(panel,ids,data.roleId,data.nameKey!);
        return this.settings(i,await this.service.panel(panel._id),`Product role saved across ${ids.length} stores.`);
      }
      return this.chooseRole(i,panel,data,products[0]!.name,`${products.map(p=>providerFor(panel,p.storeId).name).join(' + ')} · All versions`);
    }
    if (action.action === 'role-selected') {
      if(action.data?.catalogIds) {
        if(!selected) throw new Failure('expired');
        const ids=JSON.parse(action.data.catalogIds) as string[];
        await this.service.mapProducts(panel,ids,selected,action.data.nameKey!);
        return this.settings(i,await this.service.panel(panel._id),`Product role saved across ${ids.length} stores.`);
      }
      const p=await this.db.catalog.findOne({_id:action.data?.catalogId,storeId:{$in:Object.values(panel.stores)}}); if (!p || !selected) throw new Failure('expired');
      await this.service.addMapping(panel,{provider:action.data!.provider as Provider,productId:p.productId,variant:action.data!.variant || undefined,roleId:selected,label:p.name,membership:p.membership});
      return this.settings(i,await this.service.panel(panel._id),'Product role saved. You can give this role to buyers of other products too.');
    }
    if (action.action === 'publish') {
      if (!i.channel_id || !panel.mappings.length) throw new Failure('mapping_required');
      const channelId=i.channel_id;
      await this.db.withLease(`panel:${panel._id}`,async()=>{
        const current=await this.service.panel(panel._id,i.guild_id),ready=await this.service.ready(current);
        if(!current.mappings.length) throw new Failure('mapping_required');
        const location=current.messages.find(m=>m.channelId===channelId);
        if(location) {
          try { await this.discord.updatePanel(current,ready,location); return; }
          catch(e) {
            if(safeCode(e)!=='message_missing') throw e;
            await this.db.panels.updateOne({_id:panel._id},{$pull:{messages:location}});
          }
        }
        const sent=await this.discord.call<{id:string}>('post',Routes.channelMessages(channelId),panelMessage(current,ready));
        await this.db.panels.updateOne({_id:panel._id},{$push:{messages:{channelId,messageId:sent.id}},$set:{refreshAt:new Date()},$inc:{revision:1}});
      });
      return this.settings(i,await this.service.panel(panel._id),`Verification is ready in <#${channelId}>.`);
    }
    if (action.action === 'remove-mapping') return this.productRoles(i,panel,Number(action.data?.page??0));
    if (action.action === 'remove-selected') {
      const mapping=action.data?.mapping?JSON.parse(action.data.mapping) as Mapping:(JSON.parse(action.data!.snapshot!) as Mapping[])[Number(selected)]; if (!mapping) throw new Failure('expired');
      const page=action.data?.page??'0', [audience]=await this.mappingAudiences(panel,[mapping]);
      return this.send(i,message(`## Remove product role?\n**${text(mapping.label)}**\n${text(audience!)}\n\nThese buyers lose <@&${mapping.roleId}> unless another purchase supports it.`,[
        row(button('Cancel',await this.action(i,panel._id,'roles',{page})),button('Remove Role',await this.action(i,panel._id,'remove-confirm',{mapping:JSON.stringify(mapping),page}),ButtonStyle.Danger)),
      ]));
    }
    if (action.action === 'remove-confirm') {
      const mapping=JSON.parse(action.data!.mapping!) as Mapping;
      await this.db.panels.updateOne({_id:panel._id},{$pull:{mappings:mapping},$set:{refreshAt:new Date()},$inc:{revision:1}});
      if(!await this.db.panels.findOne({[`stores.${mapping.provider}`]:panel.stores[mapping.provider],mappings:{$elemMatch:{provider:mapping.provider,productId:mapping.productId}}}))
        await this.db.sync.deleteMany({storeId:panel.stores[mapping.provider],productId:mapping.productId});
      for(const b of await this.db.bindings.find({panelId:panel._id}).toArray()) await this.db.dirty(b.guildId,b.subject);
      return this.productRoles(i,await this.service.panel(panel._id),Number(action.data?.page??0),'Product role removed. Buyer access will update automatically.');
    }
    if (action.action === 'disconnect-menu') return this.select(i,`## Disconnect a store\n${Object.keys(panel.stores).length?'Choose the store to disconnect. Buyers lose roles granted through this panel unless another purchase supports them.':'No connected stores. Return to setup to connect one.'}`,await this.action(i,panel._id,'disconnect-confirm'),Object.keys(panel.stores).map(p=>({label:storeDefinition(p).name,value:p})),[row(await this.back(i,panel._id))],'Choose a store');
    if (action.action === 'disconnect-confirm') {
      const provider=selected??action.data?.provider;
      if(!provider || !panel.stores[provider]) throw new Failure('expired');
      return this.send(i,message(`## Disconnect ${storeDefinition(provider).name}?\nBuyers lose roles granted through this panel unless another purchase supports them. You can reconnect the store later.`,[row(button('Cancel',await this.action(i,panel._id,'store',{provider})),button('Disconnect Store',await this.action(i,panel._id,'disconnect',{provider}),ButtonStyle.Danger))]));
    }
    if (action.action === 'disconnect') { await this.service.disconnect(panel,action.data!.provider as Provider); return this.settings(i,await this.service.panel(panel._id)); }
    throw new Failure('expired');
  }
  private async connectGumroad(i: Interaction, panel: Panel) {
    const url = await this.auth.begin(panel, this.actor(i), 'buyer', i.token, i.channel_id);
    return this.send(i, message('## Sign in with Gumroad\nConfirm your Discord account, then sign in to Gumroad. Your result will appear here.', [row(new ButtonBuilder().setLabel('Continue in Browser').setStyle(ButtonStyle.Link).setURL(url))],
      [section('**Use a license key instead**\nWorks with guest purchases too.',button('Enter License Key…',await this.action(i,panel._id,'enter-license')))]));
  }
  private async manageAccess(i: Interaction, requestedAt?: Date) {
    const codes=await this.service.codes(this.actor(i));
    const claims=await this.db.claims.find({subject:{$in:codes.stores}},{projection:{storeId:1,provider:1,productId:1,eligibility:1,checkedAt:1,nextCheckAt:1}}).sort({provider:1,productId:1,_id:1}).toArray();
    const subject={deleting:!!await this.db.subjects.countDocuments({_id:{$in:codes.stores},deleting:true})||!!await this.db.members.countDocuments({_id:{$in:codes.members},deleting:true})};
    const pending=await this.db.members.countDocuments({_id:{$in:codes.members},dirty:true});
    const shown=claims.slice(0,10),products=shown.length?await this.db.catalog.find({$or:shown.map(c=>({storeId:c.storeId,productId:c.productId}))},{projection:{storeId:1,productId:1,name:1}}).toArray():[];
    const checked=requestedAt?claims.filter(c=>c.checkedAt>=requestedAt).length:0;
    const queued=requestedAt?claims.filter(c=>c.checkedAt<requestedAt&&c.nextCheckAt<=requestedAt).length:0;
    const failed=requestedAt?claims.filter(c=>c.checkedAt<requestedAt&&c.nextCheckAt>requestedAt).length:0;
    const status=subject?.deleting?'Removing your roles and verification data from all servers…':!claims.length?'No purchases verified yet. Use a creator’s verification message to get started.':
      `${requestedAt?`Checked ${checked} of ${claims.length} purchases.`:`${claims.length} ${claims.length===1?'purchase':'purchases'} linked across your servers.`}${queued?' Remaining checks continue automatically.':''}${failed?' Some purchases could not be confirmed; their previous access is retained.':''}\n${pending?'Updating your Discord roles…':'Purchases are checked automatically.'}`;
    const entries=shown.map(c=>{
      const name=products.find(p=>p.storeId===c.storeId&&p.productId===c.productId)?.name??'Purchase';
      const state=requestedAt&&c.checkedAt<requestedAt?(c.nextCheckAt<=requestedAt?'Waiting to check':'Could not confirm'):c.eligibility==='eligible'?'Verified':c.eligibility==='ineligible'?'No longer eligible':'Not confirmed';
      return `- **${text(storeDefinition(c.provider).name)} · ${text(name)}**: ${state}\n  Last checked <t:${Math.floor(c.checkedAt.getTime()/1000)}:R>`;
    }).join('\n');
    const roles=await this.service.desired(i.guild_id,await this.service.guildSubject(this.actor(i),i.guild_id));
    return this.send(i,message('## Manage access',[
      section(`**Purchases**\n${status}${entries?'\n\n'+entries:''}${claims.length>shown.length?`\nShowing ${shown.length} of ${claims.length} purchases. Download your data for the full list.`:''}`,button('Check Purchases',await this.action(i,'','recheck')).setDisabled(!claims.length||!!subject?.deleting)),
      display(`**Verified roles in this server**\n${roles.length?roles.slice(0,10).map(role=>`<@&${role}>`).join(', ')+(roles.length>10?` and ${roles.length-10} more`:''):'No roles from verified purchases.'}`),divider(),
      section('**Privacy & data**\nManage linked accounts and saved verification details.',button('Privacy & Data',await this.action(i,'','privacy-settings'))),
    ]));
  }
  private async privacySettings(i: Interaction, notice = '') {
    const codes=await this.service.codes(this.actor(i));
    const stored=await this.db.subjects.find({_id:{$in:codes.stores}}).toArray();
    const subject={gumroadHash:stored.some(x=>x.gumroadHash),deleting:stored.some(x=>x.deleting)||!!await this.db.members.countDocuments({_id:{$in:codes.members},deleting:true})};
    const content: ContainerComponentBuilder[]=[
      section('**Your data**\nDownload your saved verification details.',button('Download Data',await this.action(i,'','show-data'))),
      section('**Privacy**\nLearn what Keyfi stores and how it is used.',button('View Privacy','keyfi:privacy')),
    ];
    if(subject?.gumroadHash&&!subject.deleting) content.push(section('**Gumroad account**\nDisconnecting keeps your verified purchases and roles.',button('Disconnect Gumroad',await this.action(i,'','unlink'))));
    content.push(divider(),section(`**Delete verification data**\n${subject?.deleting?'Removing your roles and data…':'Removes your data and Keyfi roles from every server.'}`,button('Delete Data…',await this.action(i,'','delete-confirm')).setDisabled(!!subject?.deleting)));
    return this.send(i,message(`## Privacy & data\n${notice?notice+'\n\n':''}Applies to every server where you use Keyfi.`,content,[row(button('Back to Access',await this.action(i,'','verification')))]));
  }
  private async suggestStores(i: Interaction, panel: Panel, catalogId: string, context: Record<string,string>) {
    const products=await this.service.matchingProducts(panel,catalogId);
    if(products.length<2) return false;
    const selected=products.find(p=>p._id===catalogId)!;
    const data={...context,catalogId,catalogIds:JSON.stringify(products.map(p=>p._id)),nameKey:productNameKey(selected.name)};
    const listings=products.map(p=>`**${providerFor(panel,p.storeId).name}** · ${text(p.name)}`).join('\n');
    await this.send(i,message(`## Share a role across stores?\n${listings}\n\n${context.roleId?`Give buyers of each listing <@&${context.roleId}>.`:'Choose one role for buyers of these matching listings.'} Includes all versions. You can also set up ${providerFor(panel,selected.storeId).name} separately.`,[
      row(button(context.roleId?'Share Role':'Share Role…',await this.action(i,panel._id,'shared-products',data),ButtonStyle.Primary),button(`Use ${providerFor(panel,selected.storeId).name}`,await this.action(i,panel._id,'single-product',{...context,catalogId}))),
    ],[row(button('Back to Products',await this.action(i,panel._id,'products',{page:context.productPage??'0',search:context.search??''})))]));
    return true;
  }
  private async chooseRole(i: Interaction, panel: Panel, data: Record<string,string>, name: string, audience = 'All versions') {
    const customId=await this.action(i,panel._id,'role-selected',data);
    const roles=new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(customId).setPlaceholder('Choose buyer role'));
    const back=data.page===undefined?button('Back to Products',await this.action(i,panel._id,'products',{page:data.productPage??'0',search:data.search??''})):
      button('Back to Buyers',await this.action(i,panel._id,'variants',data));
    return this.send(i,message(`## Choose a role\n**${text(name)}**\n${text(audience)}\n\nSelecting a role saves this setting. Choose a role below Keyfi’s highest role.`,[roles],[row(back)]));
  }
}

import { REST, Routes, PermissionFlagsBits, ContainerBuilder, TextDisplayBuilder, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ContainerComponentBuilder, type RESTGetAPIGuildRolesResult, type RESTGetAPIGuildMemberResult } from 'discord.js';
import { Failure } from './security.js';
import type { Panel } from './model.js';
import { storeDefinitions } from './stores/registry.js';

export interface DiscordPort {
  administrator(guildId: string, userId: string): Promise<void>;
  memberRoles(guildId: string, userId: string): Promise<string[]>;
  validateRole(guildId: string, roleId: string): Promise<void>;
  addRole(guildId: string, userId: string, roleId: string): Promise<void>;
  removeRole(guildId: string, userId: string, roleId: string): Promise<void>;
}
export const flags = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;
export const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
export const button = (label: string, customId: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setLabel(label).setCustomId(customId).setStyle(style);
export const display = (copy: string) => new TextDisplayBuilder().setContent(copy);
export const section = (copy: string, accessory: ButtonBuilder) => new SectionBuilder().addTextDisplayComponents(display(copy)).setButtonAccessory(accessory);
export const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
// Keep navigation apart from the content and its contextual controls.
export const message = (copy: string | SectionBuilder, content: ContainerComponentBuilder[] = [], navigation: ContainerComponentBuilder[] = []) => ({flags, attachments: [], allowed_mentions: {parse: []}, components: [new ContainerBuilder().spliceComponents(0,0,typeof copy==='string'?display(copy):copy,...content,...(navigation.length?[divider(),...navigation]:[])).toJSON()]});
export const accessRow = () => row(button('Manage Access','keyfi:verification'));
export function panelMessage(panel: Panel, oauthReady: boolean) {
  const connected=[...storeDefinitions.values()].filter(d=>panel.stores[d.id]&&panel.mappings.some(m=>m.provider===d.id));
  const signIn=connected.find(d=>d.buyerSignIn);
  const methods=[];
  if(signIn) methods.push(section(`**${signIn.name} account**\n${oauthReady?'Find purchases linked to your account.':'Account sign-in is not ready yet. You can use a license key.'}`,button(`Sign In with ${signIn.name}`,`verify:oauth:${panel._id}`,oauthReady?ButtonStyle.Primary:ButtonStyle.Secondary).setDisabled(!oauthReady)));
  methods.push(section(`**License key**\n${connected.length?'Use the key from your purchase receipt.':'Verification is unavailable. Contact the creator.'}`,button('Enter License Key…',`verify:key:${panel._id}`,signIn&&oauthReady?ButtonStyle.Secondary:ButtonStyle.Primary).setDisabled(!connected.length)));
  const body = message(`## Verify your purchase\nGet your Discord roles for purchases from <@${panel.administrator}>.`, methods,
    [display('-# Verification details are private. Your roles are visible in this server.'),row(button('Manage Access','keyfi:verification'),button('Privacy','keyfi:privacy'))]);
  return {...body, flags: MessageFlags.IsComponentsV2};
}
export class DiscordApi implements DiscordPort {
  rest: REST;
  private botId?: string;
  constructor(token: string, public applicationId: string) {
    this.rest = new REST({version: '10', timeout: 10_000, retries: 1}).setToken(token);
  }
  async ensureInteractions(origin: string, publicKey: string) {
    const application=await this.call<{id:string;verify_key:string;interactions_endpoint_url?:string|null}>('get',Routes.currentApplication());
    if(application.id!==this.applicationId || application.verify_key!==publicKey) throw new Failure('discord_configuration');
    const endpoint=`${origin}/interactions`;
    if(application.interactions_endpoint_url!==endpoint) {
      const updated=await this.call<{interactions_endpoint_url?:string}>('patch',Routes.currentApplication(),{interactions_endpoint_url:endpoint});
      if(updated.interactions_endpoint_url!==endpoint) throw new Failure('discord_configuration');
    }
  }
  async call<T>(method: 'get'|'post'|'patch'|'put'|'delete', route: `/${string}`, body?: unknown, files?: {name: string; data: Buffer}[]): Promise<T> {
    try { return await this.rest[method](route, body === undefined ? undefined : {body, files}) as T; }
    catch(e) {
      const code = (e as {code?: number}).code;
      if (code === 10008 || code === 10003) throw new Failure('message_missing');
      if (code === 10007) throw new Failure('member_missing');
      if (code === 10004 || code === 50001) throw new Failure('guild_unavailable');
      if (code === 50013) throw new Failure('discord_permissions');
      throw new Failure('discord_unavailable');
    }
  }
  async administrator(guildId: string, userId: string) {
    const guild = await this.call<{owner_id: string}>('get', Routes.guild(guildId));
    if (guild.owner_id === userId) return;
    const member = await this.call<RESTGetAPIGuildMemberResult>('get', Routes.guildMember(guildId, userId));
    const roles = await this.call<RESTGetAPIGuildRolesResult>('get', Routes.guildRoles(guildId));
    const permissions = roles.filter(r => r.id === guildId || member.roles.includes(r.id)).reduce((p,r) => p | BigInt(r.permissions), 0n);
    if (!(permissions & (PermissionFlagsBits.ManageGuild | PermissionFlagsBits.Administrator))) throw new Failure('admin_required');
  }
  async memberRoles(guildId: string, userId: string) {
    return (await this.call<RESTGetAPIGuildMemberResult>('get', Routes.guildMember(guildId, userId))).roles;
  }
  async validateRole(guildId: string, roleId: string) {
    this.botId ??= (await this.call<{id: string}>('get', Routes.user('@me'))).id;
    const [roles, member] = await Promise.all([
      this.call<RESTGetAPIGuildRolesResult>('get', Routes.guildRoles(guildId)),
      this.call<RESTGetAPIGuildMemberResult>('get', Routes.guildMember(guildId, this.botId)),
    ]);
    const role = roles.find(r => r.id === roleId);
    const botRoles = roles.filter(r => member.roles.includes(r.id));
    const top = Math.max(0, ...botRoles.map(r => r.position));
    const permissions = roles.filter(r => r.id === guildId || member.roles.includes(r.id)).reduce((p,r) => p | BigInt(r.permissions), 0n);
    if (!role || role.id === guildId || role.managed || role.position >= top || (BigInt(role.permissions) & PermissionFlagsBits.Administrator)
      || !(permissions & (PermissionFlagsBits.ManageRoles | PermissionFlagsBits.Administrator))) throw new Failure('role_unassignable');
  }
  async addRole(guild: string, user: string, role: string) { await this.call('put', Routes.guildMemberRole(guild, user, role)); }
  async removeRole(guild: string, user: string, role: string) { await this.call('delete', Routes.guildMemberRole(guild, user, role)); }
  async reply(token: string, copy: string, rows: ActionRowBuilder<ButtonBuilder>[] = []) { await this.call('patch', Routes.webhookMessage(this.applicationId, token, '@original'), message(copy,[],rows)); }
  async updatePanel(panel: Panel, ready: boolean, location: Panel['messages'][number]) {
    await this.call('patch', Routes.channelMessage(location.channelId, location.messageId), panelMessage(panel, ready));
  }
}
export function errorCopy(code: string): string {
  const copy: Record<string,string> = {
    invalid_key: '## Enter a complete license key\nCopy the full key from your purchase receipt, then try again.', key_not_found: '## Purchase not found\nCheck that the key is from this creator’s store, then try again.',
    ambiguous_key: '## Enter the full license key\nThis key matches more than one purchase. Copy the full key from your receipt.',
    claim_taken: '## Purchase already linked\nThis purchase is linked to another Discord account. On that account, open **Manage Access → Privacy & Data** to delete its verification data before linking here.',
    rate_limited: '## Try again shortly\nKeyfi is busy. Wait a moment before trying again.', busy: '## Already checking\nA check is in progress. The result will appear in the original message.',
    ineligible: '## Purchase not eligible\nThis purchase can’t unlock roles. Contact the creator if you expected access.', unknown: '## Purchase couldn’t be confirmed\nTry again later, or contact the creator. Your existing roles stay in place.',
    provider_unavailable: '## Store unavailable\nTry again later. Your existing roles stay in place while the store is unavailable.',
    store_reconnect: 'The creator needs to reconnect this store. Existing access is unchanged.',
    store_disconnected: 'This store is disconnected. Contact the creator.', unmapped_product: 'This purchase has no role configured here. Contact the creator.',
    message_missing: 'This Discord message was deleted. Open **/keyfi setup** to publish the buyer panel again.',
    deleting: 'Your data deletion is in progress. Access must be removed before you can verify again.',
    expired: '## Action expired\nReturn to the creator’s verification message, or run the command again.',
    admin_required: 'You need Manage Server permission to configure verification.', role_unassignable: 'Choose a non-administrator role below the bot’s highest role, and give the bot Manage Roles permission.',
    index_pending: 'Gumroad account verification is still preparing. You can enter a license key now.',
    discord_identity_mismatch: 'Sign in with the same Discord account that started verification.',
    oauth_not_configured: 'Gumroad sign-in is unavailable. Use a license key, or contact the creator.',
    member_missing: 'Join this Discord server before verifying.',
    read_only_key_required: 'Create a read-only API key with exactly the scopes shown in the connection form, then connect again.',
    unsupported_store: 'This store integration is unavailable. Open **/keyfi setup** to choose a supported store.',
    disconnect_first: 'Disconnect the current store before connecting a different creator account.',
    store_already_connected: 'This store is managed by another Discord account. Connect it through that account.',
    membership_license_required: 'Enable license keys on this membership product, sync the catalog, then map its role.',
    mapping_required: 'Map a product to a role before publishing the panel.',
    panel_required: 'This store is connected to several panels. Use **/keyfi setup**, choose the panel, then **Add Product…**.',
    panel_limit: 'You already have 25 panels in this server. Use **/keyfi edit** to update or delete one.',
    discord_permissions: 'Keyfi needs permission to manage these roles or messages. Ask the server administrator to check its role and channel permissions.',
  };
  return copy[code] ?? 'Verification could not finish. Please try again later. Existing access is unchanged.';
}
export const roleSummary = (roles: string[]) => roles.length ? `## Purchase verified\nUpdating your Discord ${roles.length===1?'role':'roles'}: ${roles.slice(0,3).map(r=>`<@&${r}>`).join(', ')}${roles.length>3?` and ${roles.length-3} more`:''}.` : '## Check complete\nNo roles need updating.';

export type Provider = string;
type Eligibility = 'eligible' | 'ineligible' | 'unknown';
export interface Store {
  _id: string; provider: Provider; ownerId: string; credential: string;
  administrator: string; status: 'active' | 'disconnecting';
  webhookHash?: string; webhookPending?: boolean;
  webhookToken?: string;
  webhookResources?: string[]; removedResources?: string[];
  createdAt: Date; revision?: number;
  termsVersion?: string; termsAcceptedAt?: Date;
  disconnectedAt?: Date;
}
export interface Mapping {
  provider: Provider; productId: string; variant?: string; roleId: string;
  label: string; membership?: boolean;
}
export interface Panel {
  _id: string; guildId: string; administrator: string;
  stores: Record<Provider, string>; mappings: Mapping[];
  messages: {channelId: string; messageId: string}[]; active: boolean; createdAt: Date;
  refreshAt?: Date;
  revision?: number;
}
export interface Entitlement {
  provider: Provider; storeId: string; ownerId: string;
  entitlementId: string; referenceId: string; saleId?: string;
  productId: string; variant?: string; membership: boolean;
  eligibility: Eligibility; checkedAt: Date; validUntil?: Date;
  buyerHash?: string; keyHash?: string;
}
// Stored claims hold purchase identifiers only inside the encrypted `reference`, and
// the buyer only as `subject`, a one-way code of their Discord ID.
export interface Claim extends Omit<Entitlement, 'entitlementId' | 'referenceId' | 'saleId'> {
  _id: string; subject: string; reference: string; nextCheckAt: Date;
}
export interface Binding {
  _id: string; claimId: string; panelId: string; guildId: string; subject: string;
}
export interface Member {
  // `discord` is the encrypted Discord ID, opened only to change roles.
  _id: string; guildId: string; subject: string; discord?: string; revision: number; deleting?: boolean;
  dirty: boolean; managedRoles: string[]; error?: string;
  nextAt?: Date;
}
// Per-store buyer record: `_id` is the store-scoped code, never a raw Discord ID.
export interface Subject { _id: string; deleting: boolean; revision: number; epoch: string; gumroadHash?: string; }
// Short-lived list of one person's records while their deletion completes.
export interface Deletion { _id: string; subjects: string[]; guildSubjects: string[]; createdAt: Date; }
export interface Lookup {
  _id: string; storeId: string; productId: string; referenceId: string;
  saleId?: string; membership: boolean; buyerHash?: string;
}
export interface StoredLookup extends Omit<Lookup, 'referenceId' | 'saleId'> { reference: string; }
export interface CatalogProduct {
  _id: string; storeId: string; productId: string; name: string;
  nameKey: string;
  membership: boolean; licensed: boolean; variants: {id: string; name: string}[];
  fetchedAt: Date;
}
export interface Flow {
  _id: string; kind: 'buyer' | 'creator'; panelId: string; guildId: string; channelId?: string; discordId: string;
  expiresAt: Date; discordVerified?: boolean;
  interactionToken?: string; completed?: boolean;
  epoch: string;
}
export interface AccountCheck {
  _id: string; panelId: string; discordId: string; buyerHash: string; epoch: string;
  token?: string; tokenContext: string; expiresAt: Date; nextAt: Date;
  cursor?: string; roles: string[]; attempts: number;
}
export interface Action {
  _id: string; panelId: string; guildId: string; discordId: string;
  action: string; data?: Record<string,string>; expiresAt: Date;
}
export interface Sync {
  _id: string; panelId: string; storeId: string; productId: string;
  membership: boolean; cursor?: string; initialComplete: boolean;
  after?: string; startedAt: Date; nextAt: Date; error?: string;
}
export interface CatalogJob {
  _id: string; page: number; nextAt: Date; syncing: boolean; error?: string;
  manualAfter?: Date;
}
export interface SetupView {
  _id: string; discordId: string; guildId: string; channelId?: string;
  token: string; version: string; signature: string; expiresAt: Date; waitingForOAuth?: boolean;
}

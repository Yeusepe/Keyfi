import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MongoClient } from 'mongodb';

export const id = () => randomBytes(24).toString('base64url');
export class Secrets {
  private dataKey: Buffer;
  private indexKey: Buffer;
  constructor(key: string) {
    if (!/^[a-f\d]{64}$/i.test(key)) throw new Error('ENCRYPTION_KEY must contain 64 hex characters');
    const master = Buffer.from(key, 'hex');
    this.dataKey = Buffer.from(hkdfSync('sha256', master, '', 'keyfi-data', 32));
    this.indexKey = Buffer.from(hkdfSync('sha256', master, '', 'keyfi-index', 32));
  }
  async hash(kind: string, ...parts: string[]): Promise<string> {
    return createHmac('sha256', this.indexKey).update(JSON.stringify([kind, ...parts])).digest('hex');
  }
  // Scope buyer codes to one store or server.
  subject(discordId: string, scope: string) { return this.hash('discord', scope, discordId); }
  async seal(value: string, context: string): Promise<string> {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.dataKey, nonce);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return 'v1.' + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  async open(value: string, context: string): Promise<string> {
    const bytes = Buffer.from(value.slice(3), 'base64url');
    if (!value.startsWith('v1.') || bytes.length < 28) throw new Error('Invalid encrypted value');
    const decipher = createDecipheriv('aes-256-gcm', this.dataKey, bytes.subarray(0, 12), {authTagLength: 16});
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
}
export async function createSecrets(client: MongoClient, database: string, key: string): Promise<Secrets> {
  const secrets = new Secrets(key);
  if (await client.db(database).collection('__keyVault').findOne({})) throw new Failure('legacy_encryption_requires_migration');
  return secrets;
}
export function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export class Failure extends Error {
  constructor(public code: string, public retryAfter = 0) { super(code); }
}
export const safeCode = (error: unknown) => error instanceof Failure ? error.code : 'internal_error';
// Keep exception messages, requests, tokens, and provider URLs out of diagnostics.
export function logFailure(event: string, error: unknown) {
  const site = error instanceof Error ? error.stack?.split('\n').slice(1).filter(line => !line.includes('node_modules')).map(line => line.match(/[\\/]src[\\/][\w./\\-]+:\d+:\d+/)?.[0]).find(Boolean) : undefined;
  const databaseCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
  process.stderr.write(`${JSON.stringify({event, code: safeCode(error), databaseCode, site})}\n`);
}
export const normalizeKey = (key: string) => {
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 160 || /\s|[\x00-\x1f\x7f]/.test(trimmed)) throw new Failure('invalid_key');
  return trimmed;
};
export const productNameKey = (name: string) => name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();
export const text = (value: string) => value.replace(/[\\`*_{}\[\]()<>#+.!|~@]/g, '\\$&').slice(0, 150);

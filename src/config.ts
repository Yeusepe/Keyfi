import { z } from 'zod';

const optionalCredential = z.string().optional().transform(value => value?.trim() || undefined);

const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  BASE_URL: z.url(),
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().default('keyfi'),
  ENCRYPTION_KEY: z.string().regex(/^[a-f\d]{64}$/i),
  DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/),
  DISCORD_PUBLIC_KEY: z.string().regex(/^[a-f\d]{64}$/i),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_CLIENT_SECRET: optionalCredential,
  GUMROAD_BUYER_CLIENT_ID: optionalCredential,
  GUMROAD_BUYER_CLIENT_SECRET: optionalCredential,
  GUMROAD_CREATOR_CLIENT_ID: optionalCredential,
  GUMROAD_CREATOR_CLIENT_SECRET: optionalCredential,
  PRIVACY_CONTACT: z.string().trim().min(3).max(200),
});

export type Config = z.infer<typeof env>;
export function oauthConfigured(c: Config, kind: 'buyer'|'creator') {
  return !!(c.DISCORD_CLIENT_SECRET && (kind==='buyer'
    ? c.GUMROAD_BUYER_CLIENT_ID && c.GUMROAD_BUYER_CLIENT_SECRET
    : c.GUMROAD_CREATOR_CLIENT_ID && c.GUMROAD_CREATOR_CLIENT_SECRET));
}
export function readConfig(input: NodeJS.ProcessEnv = process.env): Config {
  const parsed = env.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map(x => x.path.join('.')).join(', ')}`);
  const c = parsed.data;
  const url = new URL(c.BASE_URL);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('BASE_URL must be an origin');
  if (url.protocol !== 'https:' && !(c.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('BASE_URL requires HTTPS');
  c.BASE_URL = url.origin;
  return c;
}

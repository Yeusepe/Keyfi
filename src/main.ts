import { MongoClient } from 'mongodb';
import { oauthConfigured, readConfig } from './config.js';
import { Database } from './db.js';
import { createSecrets, logFailure } from './security.js';
import { createRequester, Limits } from './http.js';
import { Providers } from './providers.js';
import { DiscordApi } from './discord.js';
import { Service } from './service.js';
import { createAuthentication } from './auth.js';
import { Interactions } from './interactions.js';
import { createServer } from './server.js';
import { Jobs } from './jobs.js';
import { migratePurchaseData } from './purchase-storage.js';

// Last-resort failures must never dump request objects or credential-bearing URLs.
const fatal=()=>{process.stderr.write('keyfi_fatal\n');process.exit(1);};
process.on('uncaughtException',fatal);
process.on('unhandledRejection',fatal);

async function main() {
  const c=readConfig();
  const client=await new MongoClient(c.MONGODB_URI,{maxPoolSize:20,serverSelectionTimeoutMS:2000,connectTimeoutMS:2000,socketTimeoutMS:15_000}).connect();
  const secrets=await createSecrets(client,c.MONGODB_DATABASE,c.ENCRYPTION_KEY);
  const db=new Database(client,c.MONGODB_DATABASE); await db.initialize();
  await migratePurchaseData(db,secrets);
  const limits=new Limits(db);
  const providers=new Providers(createRequester(db,secrets,limits),secrets,(storeId,productId)=>db.catalog.findOne({storeId,productId}));
  const discord=new DiscordApi(c.DISCORD_BOT_TOKEN,c.DISCORD_APPLICATION_ID);
  const service=new Service(db,providers,discord,secrets,oauthConfigured(c,'buyer'));
  const refreshSetup=(panelId:string)=>interactions.refreshSetup(panelId);
  const auth=createAuthentication(c,db,service,discord,secrets,limits);
  const interactions=new Interactions(db,service,discord,auth,limits,c.PRIVACY_CONTACT);
  const app=createServer(c,db,interactions,auth,secrets,limits);
  const jobs=new Jobs(c,db,service,discord,refreshSetup);
  await jobs.start(); await app.listen({port:c.PORT,host:c.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1'});
  await discord.ensureInteractions(c.BASE_URL,c.DISCORD_PUBLIC_KEY);
  process.stdout.write('keyfi_ready\n');
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await app.close();await jobs.stop();await client.close();};
  process.on('SIGTERM',()=>void stop()); process.on('SIGINT',()=>void stop());
}
main().catch(error=>{logFailure('keyfi_startup_failed',error);process.exit(1);});

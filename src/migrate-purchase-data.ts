import { MongoClient } from 'mongodb';
import { readConfig } from './config.js';
import { Database } from './db.js';
import { createSecrets } from './security.js';
import { migratePurchaseData } from './purchase-storage.js';

const c=readConfig();
const client=await new MongoClient(c.MONGODB_URI).connect();
try {
  const db=new Database(client,c.MONGODB_DATABASE);
  await migratePurchaseData(db,await createSecrets(client,c.MONGODB_DATABASE,c.ENCRYPTION_KEY));
  const lookups=db.db.collection('lookups'),hints=db.db.collection('hints');
  const counts={lookups:await lookups.countDocuments(),plaintextLookups:await lookups.countDocuments({referenceId:{$exists:true}}),
    hints:await hints.countDocuments(),plaintextHints:await hints.countDocuments({referenceId:{$exists:true}})};
  console.log(JSON.stringify(counts));
  if(counts.plaintextLookups || counts.plaintextHints) process.exitCode=1;
} finally {await client.close();}

import { MongoClient } from 'mongodb';
import { readConfig } from './config.js';
import { Database } from './db.js';

const c=readConfig();
const client=await new MongoClient(c.MONGODB_URI).connect();
try {
  const db=new Database(client,c.MONGODB_DATABASE);
  const stores=await db.stores.find({provider:'gumroad',status:'active'},{projection:{_id:1,ownerId:1}}).toArray();
  if(process.argv[2]==='queue') for(const store of stores)
    await db.catalogJobs.updateOne({_id:store._id},{$set:{page:1,nextAt:new Date(),syncing:true},$unset:{cursor:'',error:''}},{upsert:true});
  const productId=process.argv[3];
  console.log(JSON.stringify(await Promise.all(stores.map(async store=>{
    const job=await db.catalogJobs.findOne({_id:store._id});
    return {ownerId:store.ownerId,catalogCount:await db.catalog.countDocuments({storeId:store._id}),
      productPresent:productId?!!await db.catalog.findOne({storeId:store._id,productId}):undefined,
      job:job&&{page:job.page,syncing:job.syncing,cursor:!!job.cursor,error:job.error,nextAt:job.nextAt}};
  }))));
} finally {await client.close();}

import type { Database } from './db.js';
import type { Lookup, StoredLookup } from './model.js';
import type { Secrets } from './security.js';

export async function encryptedLookup(record: Lookup, secrets: Secrets): Promise<StoredLookup> {
  const {_id, referenceId, saleId, ...fields} = record;
  const key = await secrets.hash('lookup', record.storeId, _id);
  return {_id: key, ...fields, reference: await secrets.seal(JSON.stringify({referenceId, saleId}), key)};
}

// Safe to rerun after rolling deployments: the new row is inserted and the old
// row removed in one transaction, under the same fence used by privacy deletion.
export async function migratePurchaseData(db: Database, secrets: Secrets) {
  const oldLookups = db.db.collection<Lookup>('lookups');
  for await (const old of oldLookups.find({referenceId: {$exists: true}})) {
    const replacement = await encryptedLookup(old, secrets);
    await db.transaction(async session => {
      await db.db.collection('privacy_fence').updateOne({_id:'index' as never},{$inc:{revision:1}},{upsert:true,session});
      const optedOut = old.buyerHash && await db.optouts.findOne({_id:old.buyerHash},{session});
      if (!optedOut) {
        const {_id,...fields}=replacement;
        await db.lookups.updateOne({_id},{$setOnInsert:fields},{upsert:true,session});
      }
      await oldLookups.deleteOne({_id:old._id,referenceId:old.referenceId},{session});
    });
  }
  const oldHints = db.db.collection<{_id:string;referenceId:string}>('hints');
  for await (const old of oldHints.find({referenceId: {$exists: true}}))
    await oldHints.updateOne({_id:old._id,referenceId:old.referenceId},
      {$set:{reference:await secrets.seal(old.referenceId,old._id)},$unset:{referenceId:''}});
}

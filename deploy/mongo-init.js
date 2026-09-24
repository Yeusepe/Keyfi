// Executed inside the database container; credentials never enter command arguments.
try {
  const admin = db.getSiblingDB('admin');
  if (!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD)) quit(1);
  try { rs.status(); }
  catch (error) {
    if (error.code !== 94) throw error;
    rs.initiate({_id: 'rs0', members: [{_id: 0, host: process.env.MONGO_REPLICA_HOST}]});
  }
  if (!db.hello().isWritablePrimary) quit(1);
  const app = db.getSiblingDB('keyfi');
  if (!app.getUser('keyfi')) app.createUser({user: 'keyfi', pwd: process.env.MONGO_APP_PASSWORD, roles: [{role: 'readWrite', db: 'keyfi'}]});
  quit(0);
} catch { quit(1); }

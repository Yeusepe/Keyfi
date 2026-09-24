import test from 'node:test';
import assert from 'node:assert/strict';
import { logFailure } from '../src/security.js';

test('failure diagnostics expose the code location without credential-bearing exception text',()=>{
  const error=Object.assign(new Error('PRIVATE-TOKEN https://provider.test/?code=PRIVATE-CODE'),{code:11000});
  error.stack+='\n    at handleOk (C:\\repo\\node_modules\\mongodb\\src\\operations\\update.ts:159:32)\n    at connect (C:\\repo\\src\\service.ts:33:7)';
  let output='';
  const write=process.stderr.write;
  process.stderr.write=((chunk:string)=>{output+=chunk;return true;}) as typeof write;
  try { logFailure('connection_failed',error); }
  finally { process.stderr.write=write; }
  assert.deepEqual(JSON.parse(output),{event:'connection_failed',code:'internal_error',databaseCode:11000,site:'\\src\\service.ts:33:7'});
  assert.ok(!output.includes('PRIVATE'));
});

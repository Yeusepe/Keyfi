import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordApi, errorCopy } from '../src/discord.js';
import { Failure } from '../src/security.js';

for (const code of [10004, 50001]) {
  test(`setup gives installation guidance when Discord refuses server access (${code})`, async () => {
    const api = new DiscordApi('test-token', '123');
    api.rest.get = async () => { throw { code }; };
    await assert.rejects(api.administrator('456', '789'), error => {
      assert.ok(error instanceof Failure);
      assert.equal(error.code, 'guild_unavailable');
      const copy = errorCopy(error.code);
      assert.match(copy, /add Keyfi as a server bot/);
      assert.match(copy, /Manage Roles/);
      assert.match(copy, /\/keyfi setup/);
      assert.doesNotMatch(copy, /Verification could not finish/);
      return true;
    });
  });
}

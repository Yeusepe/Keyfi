# Keyfi

A Discord bot that gives buyers roles after verifying a Gumroad, Jinxxy, or Payhip purchase.

## Set up verification

1. Run `/keyfi setup` in the channel buyers will use, then connect your store.
2. Add products and choose the roles buyers receive. Each role must be below both your highest role and Keyfi’s role, with no moderation permissions.
3. Choose **Publish Verification**. Buyers follow the message to verify their purchase.

Have these ready when connecting a store:

| Store | What you need |
| --- | --- |
| Gumroad | Sign in with your creator account. |
| Jinxxy | An API key with `products_read` and `licenses_read`. |
| Payhip | Your account API key from [Developer settings](https://payhip.com/settings/developer), plus a product secret for each product. In Payhip, edit the product, open **Advanced options**, enable license keys, and save to see its secret. |

For Payhip refund updates, add the webhook URL shown in Keyfi to Payhip’s Developer settings and select **paid** and **refunded**. Keep any existing webhook URLs. You can add products before the first sale.

Payhip partial refunds, missed updates, disabled licenses, and subscription cancellations need manual review. To remove access, open **Stores → Manage Payhip → Find Buyer…**, select the purchase, and choose **Revoke Verification**.

Use `/keyfi edit` to manage panels. Buyers can manage their verification and delete their data with `/verification`.

## Run your own bot

Requires **Node 24**, **Docker**, and a public HTTPS URL.

1. Copy [`.env.example`](.env.example) to `.env` and fill in the required values, including `PRIVACY_CONTACT`. Set `BASE_URL` to your public HTTPS origin and forward it to port 8080. Use hex database passwords; the password in `MONGODB_URI` must match `MONGO_APP_PASSWORD`.
2. Generate `ENCRYPTION_KEY` using the command in `.env.example`. Keep the same key on every instance and back it up separately from the database. Losing it makes saved encrypted data unusable.
3. Install dependencies, start MongoDB, register Discord commands, and start Keyfi:

   ```sh
   npm ci
   docker compose up -d mongodb
   npm run commands
   npm run dev
   ```

4. In your Discord application, set **Interactions Endpoint URL** to `<BASE_URL>/interactions`. Install the bot with the `bot` and `applications.commands` scopes and **View Channels**, **Send Messages**, and **Manage Roles** permissions.

For Gumroad, create separate buyer and creator OAuth apps and enter their credentials and `DISCORD_CLIENT_SECRET` in `.env`. Register these redirect URLs, replacing `<BASE_URL>` with your public origin:

| Application | Redirect URL | Scopes |
| --- | --- | --- |
| Discord | `<BASE_URL>/oauth/discord/callback` | `identify` |
| Gumroad buyer | `<BASE_URL>/api/auth/callback/gumroad-buyer` | `view_profile` |
| Gumroad creator | `<BASE_URL>/api/auth/callback/gumroad-creator` | `view_profile view_sales` |

Development checks: `npm run check`, `npm test`, and `npm run build`.

# Keyfi

Keyfi is a Discord bot that verifies Gumroad and Jinxxy purchases and gives buyers their Discord roles. Buyers link a Gumroad account or enter a license key; Keyfi keeps the mapped roles up to date.

## Run locally

Node 24 and Docker.

1. Copy `.env.example` to `.env` and fill it in. Use hex MongoDB passwords, and keep the password in `MONGODB_URI` equal to `MONGO_APP_PASSWORD`.
2. Start the database: `docker compose up -d mongodb`.
3. Run `npm ci`, `npm run check`, `npm test`, and `npm run build`.
4. Expose port 8080 over HTTPS and set `BASE_URL` to that origin.
5. Run `npm run commands` once, then `npm run dev`.

`npm test` uses a temporary MongoDB replica set and never calls live stores or Discord.

## Provider setup

| Application | Callback | Scopes |
| --- | --- | --- |
| Discord | `https://YOUR_DOMAIN/oauth/discord/callback` | `identify` |
| Gumroad buyer app | `https://YOUR_DOMAIN/api/auth/callback/gumroad-buyer` | `view_profile` |
| Gumroad creator app | `https://YOUR_DOMAIN/api/auth/callback/gumroad-creator` | `view_profile view_sales` |

Create two Gumroad OAuth apps. Set the Discord Interactions Endpoint URL to `https://YOUR_DOMAIN/interactions`; install the bot with `bot` and `applications.commands`, and give it View Channels, Send Messages, and Manage Roles with its role above the roles it grants. Gateway intents and message content are not needed. Connect Jinxxy with a read-only API key (`products_read`, `licenses_read`).

## Commands

- `/keyfi setup`, `/keyfi create`, `/keyfi edit` — connect stores, map products to roles, and manage verification panels.
- `/keyfi map product:… role:…` — map all versions of a product to a role.
- `/keyfi privacy`, `/verification` — privacy notices, rechecks, and data deletion.

Products sync every six hours and purchases are rechecked automatically.

Gumroad account sign-in enables after the first scan of mapped products. Setup shows the number of indexed purchases and any retry or reconnection needed. The scan processes one page every two seconds, independently of purchase rechecks. Pages are saved in one database transaction; retries resume from the saved cursor. Gumroad returns [10 sales per page](https://github.com/antiwork/gumroad/blob/main/app/controllers/api/v2/sales_controller.rb), so 1,000 purchases need at least 100 requests. Keyfi caps Gumroad background traffic at 60 requests/minute and reserves another 20 for interactive verification; provider cooldowns still apply.

Open `/keyfi setup` in each channel where you want a verification message, then choose **Publish Verification**. This refreshes the existing message or replaces it if deleted. All copies share the panel's product roles and update automatically. Products already configured appear last in product pickers.

To remove a panel, open `/keyfi edit`, select it, and choose **Delete Panel…**. Confirm to remove its verification messages and product roles. Other panels and the access they grant stay in place.

## Encryption and privacy

Keyfi encrypts saved purchase references, store credentials, tokens, and member Discord IDs with Node's built-in AES-256-GCM; scoped buyer codes use HMAC-SHA-256. Other database fields remain readable. This protects those encrypted fields at rest; the running server can decrypt them.

Purchase lookup document IDs are keyed hashes, and webhook hints store encrypted references. Startup migrates older plaintext lookup and hint rows before serving requests.

Generate `ENCRYPTION_KEY` once using the command in `.env.example`. Set the same value on every app instance (both `keyfi-a` and `keyfi-b` on Zeabur), keep it across restarts, and back it up separately from MongoDB. Losing or replacing it makes existing encrypted records and buyer codes unusable. No external key service is required.

Previous KMS/CSFLE records and buyer codes are incompatible with this format. Startup refuses databases containing the old `__keyVault`; existing installations must migrate before switching. Keep the old keys and database backup until that migration is complete.

Set `PRIVACY_CONTACT` or startup fails. Notices are shown in Discord: `/keyfi privacy` for creators and `/verification → Privacy & Data` for buyers.

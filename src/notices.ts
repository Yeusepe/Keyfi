// Bump TERMS_VERSION when the terms change.
export const TERMS_VERSION = '1';

export const buyerNotice = (contact: string) => `## Privacy
Keyfi checks your purchases to give you Discord roles and keep them up to date.

**What Keyfi keeps**
- Your Discord user ID, servers, and roles Keyfi manages
- Purchase and product IDs, access status, and check dates
- One-way codes from your license key or linked account to prevent duplicate claims

**What Keyfi never keeps**
Your raw license key, email, name, address, payment details, or messages.

**Who processes it**
Discord processes the license form. Keyfi sends the key to the creator’s connected store to check your purchase. Your verification results are private; your roles are visible in the server. Keyfi never sells your data or uses it for ads.

**How long**
Saved verification data stays until you delete it. Temporary sign-in data expires after 10 minutes. After deletion, a one-way opt-out code prevents old purchase records from being imported again.

**Your choices**
Open **/verification → Privacy & Data** to download your saved details, disconnect Gumroad, or delete your data and managed roles across all servers.

Questions, including where Keyfi is hosted: ${contact}. You can also contact your data protection authority.`;

export const creatorPrivacy = (contact: string) => `## Privacy for creators
**What Keyfi reads from your store**
Read-only access. It reads your product list and, when a buyer verifies, that one purchase or subscription. Gumroad scopes: view_profile, view_sales. Jinxxy scopes: products_read, licenses_read.

**What Keyfi stores**
- Your store connection, encrypted
- Your product names and IDs
- For each verified buyer: the purchase ID, the product and whether it's valid
- If Gumroad sign-in is on: one-way buyer codes and purchase IDs for your mapped products, so buyers can sign in instead of pasting a key

Keyfi never stores buyer names, emails, prices, addresses, payment details or license keys.

**Your buyers**
Mention in your own privacy notice that purchases can be verified through Keyfi. Buyers can see or delete their data themselves with **/verification**.

**Disconnecting**
Deletes your store connection, buyer codes and verified purchases.

**Data terms (v${TERMS_VERSION})**
Connecting a store means you agree that Keyfi processes your buyers' data for you, and that Keyfi:
- uses it only for purchase verification
- keeps it confidential and secured
- uses only its hosting and database provider for it, and tells you before that changes
- helps you answer buyer requests, and tells you promptly about any breach affecting your buyers
- deletes it when you disconnect, and gives you the information needed to show compliance

Questions: ${contact}`;

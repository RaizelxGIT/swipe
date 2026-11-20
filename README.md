# Swipe

Sell and buy event tickets. Buyers pay with Interswitch Web Checkout and get a QR ticket; hosts scan it at the door.
Stack: Node.js + Express, MongoDB Atlas, plain HTML/CSS/JS frontend in `public/`.

## Run locally
1. `npm install`
2. Copy `.env.example` to `.env` and paste your Atlas connection string into `MONGODB_URI`.
3. `npm start`, then open http://localhost:3000

All data goes into ONE collection (table) called `swipe` inside your `test` database, created automatically on first run
with two demo events. Events, orders and tickets are told apart by a `type` field. Nothing else in your cluster is touched.

## Atlas checklist
- Connect > Drivers > copy the connection string. Replace `<password>`; URL-encode special characters (`@` becomes `%40`).
- Database Access: the user must be able to read and write the `test` database.
- Network Access: allow your IP for local work. To deploy, allow the host's IPs (simplest: `0.0.0.0/0`, tighten after launch).
- **Delete everything at once:** Atlas > Browse Collections > `test` > hover `swipe` > trash icon, or in mongosh: `use test` then `db.swipe.drop()`.

## Troubleshooting: `querySrv ECONNREFUSED`
Your network's DNS is refusing the lookup that `mongodb+srv://` strings need (common on some ISPs and routers). It is not a password or permissions problem.
The app already retries with public DNS automatically. If it still fails: use a phone hotspot, or set your computer's DNS to 8.8.8.8 and 1.1.1.1,
or in Atlas go to Connect > Drivers, choose Node.js "2.2.12 or later", and paste that longer `mongodb://` (non-SRV) string into `MONGODB_URI`.

## Deploy (Render, Railway, etc.)
Build command `npm install`, start command `npm start`. Set environment variables: `MONGODB_URI`, `MONGODB_DB=test`,
and optionally the Interswitch ones below. The host provides `PORT` automatically. Camera scanning works on https.

## Interswitch LIVE
Set `ISW_MODE=LIVE`, `ISW_MERCHANT_CODE=MX153376` and your team's `ISW_PAY_ITEM_ID` (see `.env.example`). In LIVE mode the server refuses to start if
`SKIP_VERIFY` or `DEMO_PAYMENTS` is on, and a ticket is only issued after Interswitch's `gettransaction.json` confirms response `00` AND the exact amount.
Test with the cheapest real event (live starts from ₦10) and use a real card. Sandbox test cards do not work in LIVE.

## Interswitch (sandbox)
Defaults to Interswitch's public sandbox (TEST) credentials. To use your own:
`ISW_MERCHANT_CODE`, `ISW_PAY_ITEM_ID`, `ISW_MODE=TEST|LIVE`. Payments are verified server-side before tickets are issued.
Override hosts with `ISW_CHECKOUT_URL` / `ISW_VERIFY_URL`. `SKIP_VERIFY=1` skips verification (demo only).

Sandbox test card: Mastercard 5123450000000008, expiry 01/39, CVV 100, PIN 1111, OTP 123456
(official list: https://docs.interswitchgroup.com/docs/test-cards).

## Network check
Open `/api/diag`. Every entry should say `"reachable": true`; if not, your network or DNS is blocking Interswitch.

## Demo fallback
`DEMO_PAYMENTS=1` adds a clearly labelled "Simulate payment (demo mode)" button. Demo only; never enable in production.

## Demo host dashboards
`#/host/demo-night/demo-host-key` and `#/host/demo-brunch/demo-host-key`

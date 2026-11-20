require('dotenv').config();
const express = require('express');
const path = require('path');
const dns = require('dns');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MODE = (process.env.ISW_MODE || 'TEST').toUpperCase() === 'LIVE' ? 'LIVE' : 'TEST';
// Defaults are Interswitch's public sandbox credentials. Override with env vars for your own.
const MERCHANT = process.env.ISW_MERCHANT_CODE || 'MX6072';
const PAY_ITEM = process.env.ISW_PAY_ITEM_ID || '9405967';
const SKIP_VERIFY = process.env.SKIP_VERIFY === '1';
const DEMO = process.env.DEMO_PAYMENTS === '1'; // offline fallback for demos only
if (MODE === 'LIVE') {
  // Live money: refuse to start with sandbox credentials or any verification bypass.
  if (!process.env.ISW_MERCHANT_CODE || !process.env.ISW_PAY_ITEM_ID) { console.error('ISW_MODE=LIVE needs ISW_MERCHANT_CODE and ISW_PAY_ITEM_ID in .env (your own live credentials).'); process.exit(1); }
  if (SKIP_VERIFY || DEMO) { console.error('SKIP_VERIFY and DEMO_PAYMENTS must be off when ISW_MODE=LIVE.'); process.exit(1); }
}
// Interswitch docs/community guides list more than one sandbox hostname, so we try each in turn.
const CHECKOUT_URLS = process.env.ISW_CHECKOUT_URL ? [process.env.ISW_CHECKOUT_URL]
  : MODE === 'LIVE' ? ['https://newwebpay.interswitchng.com/inline-checkout.js']
  : ['https://newwebpay-sandbox.interswitchng.com/inline-checkout.js', 'https://newwebpay.qa.interswitchng.com/inline-checkout.js'];
const VERIFY_URLS = process.env.ISW_VERIFY_URL ? [process.env.ISW_VERIFY_URL]
  : MODE === 'LIVE' ? ['https://webpay.interswitchng.com/collections/api/v1/gettransaction.json']
  : ['https://sandbox.interswitchng.com/collections/api/v1/gettransaction', 'https://qa.interswitchng.com/collections/api/v1/gettransaction.json'];

/* ---------- MongoDB (everything lives in ONE collection, "swipe", inside the "test" database) ---------- */
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'test';
const COLLECTION = process.env.MONGODB_COLLECTION || 'swipe';
if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI. Copy .env.example to .env and paste your Atlas connection string.');
  process.exit(1);
}
let col; // { events, orders, tickets } are views over the single "swipe" collection, told apart by a `type` field
const NO_ID = { projection: { _id: 0, type: 0 } };
function scoped(coll, type) {
  return {
    find: (q = {}, o) => coll.find({ ...q, type }, o),
    findOne: (q, o) => coll.findOne({ ...q, type }, o),
    findOneAndUpdate: (q, u, o) => coll.findOneAndUpdate({ ...q, type }, u, o),
    updateOne: (q, u, o) => coll.updateOne({ ...q, type }, u, o),
    deleteMany: (q) => coll.deleteMany({ ...q, type }),
    countDocuments: (q = {}) => coll.countDocuments({ ...q, type }),
    insertOne: (d) => coll.insertOne({ ...d, type }),
    insertMany: (ds) => coll.insertMany(ds.map(d => ({ ...d, type })))
  };
}
async function connect() {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
  try {
    await client.connect();
    const coll = client.db(DB_NAME).collection(COLLECTION);
    col = { events: scoped(coll, 'event'), orders: scoped(coll, 'order'), tickets: scoped(coll, 'ticket') };
    await Promise.all([
      coll.createIndex({ id: 1 }, { unique: true, partialFilterExpression: { type: 'event' } }),
      coll.createIndex({ txnRef: 1 }, { unique: true, partialFilterExpression: { type: 'order' } }),
      coll.createIndex({ code: 1 }, { unique: true, partialFilterExpression: { type: 'ticket' } }),
      coll.createIndex({ type: 1, eventId: 1 })
    ]);
  } catch (e) { await client.close().catch(() => {}); throw e; }
}
async function seed() {
  if (await col.events.countDocuments() > 0) return;
  const day = 86400000, now = new Date().toISOString();
  await col.events.insertMany([
    { id: 'demo-night', hostKey: 'demo-host-key', title: 'Lagos Product Night', description: 'An evening of short talks and demos from product builders across Lagos.\nLight bites and networking after.', venue: 'Landmark Centre, Victoria Island', date: new Date(Date.now() + 7 * day).toISOString(), price: 5000, capacity: 150, sold: 0, hostName: 'Product Lagos', createdAt: now },
    { id: 'demo-brunch', hostKey: 'demo-host-key', title: 'Community Brunch', description: 'Free brunch for the local developer community. Bring a friend.', venue: 'Yaba, Lagos', date: new Date(Date.now() + 12 * day).toISOString(), price: 0, capacity: 60, sold: 0, hostName: 'Devs of Yaba', createdAt: now }
  ]);
}

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const rid = (n = 6) => crypto.randomBytes(n).toString('hex');
const publicEvent = (e) => {
  const { hostKey, _id, ...rest } = e;
  const sold = e.sold || 0;
  return { ...rest, sold, remaining: Math.max(0, e.capacity - sold) };
};
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normCode = (c) => String(c || '').trim().toUpperCase();
const sameKey = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const ticketsFor = (order) => col.tickets.find({ code: { $in: order.codes || [] } }, NO_ID).toArray();

// Turns a pending order into tickets exactly once. Safe against double-calls and overselling.
async function issueTickets(order) {
  if (order.status === 'paid') return ticketsFor(order);
  const claimed = await col.orders.findOneAndUpdate(
    { txnRef: order.txnRef, status: 'pending' }, { $set: { status: 'issuing' } }, { returnDocument: 'after', ...NO_ID });
  if (!claimed) {
    const cur = await col.orders.findOne({ txnRef: order.txnRef }, NO_ID);
    if (cur && cur.status === 'paid') return ticketsFor(cur);
    throw new HttpError(409, 'Your order is still being processed. Try again in a moment.');
  }
  const reserved = await col.events.findOneAndUpdate(
    { id: order.eventId, $expr: { $lte: [{ $add: [{ $ifNull: ['$sold', 0] }, order.quantity] }, '$capacity'] } },
    { $inc: { sold: order.quantity } }, { projection: { _id: 0, id: 1 } });
  if (!reserved) {
    await col.orders.updateOne({ txnRef: order.txnRef }, { $set: { status: 'pending' } });
    throw new HttpError(409, 'Not enough tickets left for this event');
  }
  const now = new Date().toISOString();
  const tickets = Array.from({ length: order.quantity }, () => ({ code: 'SWP-' + rid(6).toUpperCase(), eventId: order.eventId, txnRef: order.txnRef, name: order.name, email: order.email, createdAt: now, usedAt: null }));
  try {
    await col.tickets.insertMany(tickets.map(t => ({ ...t })));
    await col.orders.updateOne({ txnRef: order.txnRef }, { $set: { status: 'paid', codes: tickets.map(t => t.code), paidAt: now } });
  } catch (e) {
    await col.events.updateOne({ id: order.eventId }, { $inc: { sold: -order.quantity } }).catch(() => {});
    await col.tickets.deleteMany({ txnRef: order.txnRef }).catch(() => {});
    await col.orders.updateOne({ txnRef: order.txnRef }, { $set: { status: 'pending' } }).catch(() => {});
    throw e;
  }
  return tickets;
}

async function verifyWithInterswitch(order) {
  if (SKIP_VERIFY) return { ok: true };
  let lastErr;
  for (const base of VERIFY_URLS) {
    const url = `${base}?merchantcode=${encodeURIComponent(MERCHANT)}&transactionreference=${encodeURIComponent(order.txnRef)}&amount=${order.amountKobo}`;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      const data = await r.json().catch(() => ({}));
      if (data.ResponseCode === undefined) { lastErr = new Error('Unexpected response from ' + base); continue; }
      const amountOk = (data.Amount == null && MODE !== 'LIVE') || Number(data.Amount) === order.amountKobo;
      return { ok: data.ResponseCode === '00' && amountOk, detail: data.ResponseDescription || 'Payment was not completed' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Verification failed');
}

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => res.json({ merchantCode: MERCHANT, payItemId: PAY_ITEM, mode: MODE, checkoutUrls: CHECKOUT_URLS, demo: DEMO }));

// Open /api/diag to see whether THIS machine's network can reach Interswitch.
app.get('/api/diag', h(async (req, res) => {
  const probe = u => u + (u.includes('gettransaction') ? `?merchantcode=${MERCHANT}&transactionreference=diag&amount=100` : '');
  const out = await Promise.all([...CHECKOUT_URLS, ...VERIFY_URLS].map(async u => {
    try { const r = await fetch(probe(u), { signal: AbortSignal.timeout(8000) }); return { url: u, reachable: true, httpStatus: r.status }; }
    catch (e) { return { url: u, reachable: false, error: String((e.cause && e.cause.code) || e.message) }; }
  }));
  res.json(out);
}));

app.get('/api/events', h(async (req, res) => {
  const events = await col.events.find({}, NO_ID).toArray();
  res.json(events.map(publicEvent).sort((a, b) => new Date(a.date) - new Date(b.date)));
}));

app.get('/api/events/:id', h(async (req, res) => {
  const e = await col.events.findOne({ id: String(req.params.id) }, NO_ID);
  if (!e) throw new HttpError(404, 'Event not found');
  res.json(publicEvent(e));
}));

app.post('/api/events', h(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 100), venue = str(b.venue, 120), hostName = str(b.hostName, 80);
  const description = str(b.description, 1000);
  const date = new Date(b.date);
  const price = Number(b.price || 0), capacity = Number(b.capacity);
  if (!title) throw new HttpError(400, 'Add an event title');
  if (!venue) throw new HttpError(400, 'Add a venue');
  if (isNaN(date.getTime())) throw new HttpError(400, 'Choose a valid date and time');
  if (!Number.isFinite(price) || price < 0 || price > 10000000) throw new HttpError(400, 'Price must be 0 or more');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) throw new HttpError(400, 'Capacity must be a whole number of at least 1');
  const event = { id: rid(4), hostKey: rid(12), title, description, venue, date: date.toISOString(), price: Math.round(price), capacity, sold: 0, hostName: hostName || 'Anonymous host', createdAt: new Date().toISOString() };
  await col.events.insertOne({ ...event });
  res.status(201).json({ ...publicEvent(event), hostKey: event.hostKey });
}));

app.post('/api/orders', h(async (req, res) => {
  const b = req.body || {};
  const event = await col.events.findOne({ id: String(b.eventId || '') }, NO_ID);
  if (!event) throw new HttpError(404, 'Event not found');
  const name = str(b.name, 80), email = str(b.email, 120).toLowerCase();
  const quantity = Number(b.quantity);
  if (!name) throw new HttpError(400, 'Enter your name');
  if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new HttpError(400, 'Choose between 1 and 10 tickets');
  if (event.capacity - (event.sold || 0) < quantity) throw new HttpError(409, 'Not enough tickets left for this event');
  const order = { txnRef: 'SWP' + Date.now() + rid(3).toUpperCase(), eventId: event.id, name, email, quantity, amountKobo: event.price * quantity * 100, status: 'pending', codes: [], createdAt: new Date().toISOString() };
  await col.orders.insertOne({ ...order });
  if (event.price === 0) {
    const tickets = await issueTickets(order);
    return res.status(201).json({ free: true, tickets });
  }
  res.status(201).json({ free: false, txnRef: order.txnRef, amountKobo: order.amountKobo, name, email });
}));

app.post('/api/orders/:ref/verify', h(async (req, res) => {
  const order = await col.orders.findOne({ txnRef: String(req.params.ref) }, NO_ID);
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.status === 'paid') return res.json({ tickets: await ticketsFor(order) });
  if (DEMO && req.query.demo === '1') return res.json({ tickets: await issueTickets(order) });
  let v;
  try { v = await verifyWithInterswitch(order); }
  catch (e) { throw new HttpError(502, 'Could not confirm payment with Interswitch. Try again in a moment.'); }
  if (!v.ok) throw new HttpError(402, v.detail || 'Payment was not completed');
  try { res.json({ tickets: await issueTickets(order) }); }
  catch (e) {
    if (e instanceof HttpError && e.status === 409 && /left/.test(e.message)) throw new HttpError(409, 'Sold out before payment was confirmed. Contact the host for a refund.');
    throw e;
  }
}));

app.get('/api/tickets', h(async (req, res) => {
  const codes = String(req.query.codes || '').split(',').map(normCode).filter(Boolean).slice(0, 100);
  const tickets = await col.tickets.find({ code: { $in: codes } }, NO_ID).toArray();
  const events = await col.events.find({ id: { $in: [...new Set(tickets.map(t => t.eventId))] } }, NO_ID).toArray();
  const byCode = new Map(tickets.map(t => [t.code, t]));
  res.json(codes.map(c => byCode.get(c)).filter(Boolean).map(t => {
    const e = events.find(x => x.id === t.eventId);
    return { ticket: t, event: e ? publicEvent(e) : {} };
  }));
}));

app.get('/api/tickets/:code', h(async (req, res) => {
  const t = await col.tickets.findOne({ code: normCode(req.params.code) }, NO_ID);
  if (!t) throw new HttpError(404, 'Ticket not found');
  const e = await col.events.findOne({ id: t.eventId }, NO_ID);
  const qr = await QRCode.toDataURL(t.code, { margin: 1, width: 360, color: { dark: '#14161a', light: '#ffffff' } });
  res.json({ ticket: t, event: e ? publicEvent(e) : null, qr });
}));

app.get('/api/events/:id/attendees', h(async (req, res) => {
  const e = await col.events.findOne({ id: String(req.params.id) }, NO_ID);
  if (!e) throw new HttpError(404, 'Event not found');
  if (!sameKey(req.query.key, e.hostKey)) throw new HttpError(403, 'Invalid host key');
  const tickets = await col.tickets.find({ eventId: e.id }, NO_ID).sort({ createdAt: -1 }).toArray();
  res.json({ event: publicEvent(e), tickets, checkedIn: tickets.filter(t => t.usedAt).length, revenue: tickets.length * e.price });
}));

app.post('/api/events/:id/scan', h(async (req, res) => {
  const e = await col.events.findOne({ id: String(req.params.id) }, NO_ID);
  if (!e) throw new HttpError(404, 'Event not found');
  if (!sameKey(req.body && req.body.hostKey, e.hostKey)) throw new HttpError(403, 'Invalid host key');
  const t = await col.tickets.findOne({ code: normCode(req.body && req.body.code) }, NO_ID);
  if (!t) throw new HttpError(404, 'Ticket not recognised', { status: 'invalid' });
  if (t.eventId !== e.id) throw new HttpError(404, 'This ticket is for a different event', { status: 'invalid' });
  const upd = await col.tickets.findOneAndUpdate({ code: t.code, usedAt: null }, { $set: { usedAt: new Date().toISOString() } }, { returnDocument: 'after', ...NO_ID });
  if (upd) return res.json({ status: 'valid', ticket: upd });
  const cur = await col.tickets.findOne({ code: t.code }, NO_ID);
  res.json({ status: 'used', ticket: cur });
}));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

(async () => {
  try {
    try { await connect(); }
    catch (e) {
      // "querySrv ECONNREFUSED" = this network's DNS refuses the SRV lookup Atlas needs. Retry with public DNS.
      if (MONGODB_URI.startsWith('mongodb+srv://') && /querySrv|ENOTFOUND|ECONNREFUSED|ETIMEOUT|ESERVFAIL/.test(String(e.message))) {
        console.warn('Atlas DNS lookup failed on this network. Retrying with public DNS (8.8.8.8, 1.1.1.1)...');
        dns.setServers(['8.8.8.8', '1.1.1.1']);
        await connect();
      } else throw e;
    }
    await seed();
    app.listen(PORT, () => {
      console.log(`Swipe running at http://localhost:${PORT}  (Interswitch mode: ${MODE}, database: ${DB_NAME}, collection: ${COLLECTION})`);
      console.log(`Demo host dashboards: http://localhost:${PORT}/#/host/demo-night/demo-host-key  |  #/host/demo-brunch/demo-host-key`);
    });
  } catch (e) {
    console.error('Could not start Swipe:', e.message);
    console.error('Check MONGODB_URI, that special characters in the password are URL-encoded, that the Atlas user can read and write the "' + DB_NAME + '" database, and that Atlas Network Access allows this machine.');
    if (/querySrv|ENOTFOUND|ESERVFAIL/.test(String(e.message))) console.error('This looks like a DNS problem on your network: try a phone hotspot, set your DNS to 8.8.8.8 / 1.1.1.1, or use Atlas\'s non-SRV connection string (see README).');
    process.exit(1);
  }
})();

const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = n => n > 0 ? '₦' + Number(n).toLocaleString('en-NG') : 'Free';
const fmtDate = d => new Date(d).toLocaleString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const store = {
  get: (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
async function api(url, opts = {}) {
  const init = { ...opts };
  if (opts.body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(opts.body); }
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Something went wrong'), { data: d });
  return d;
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
const loadScript = src => new Promise((res, rej) => {
  if (document.querySelector(`script[src="${src}"]`)) return res();
  const s = document.createElement('script');
  s.src = src; s.onload = res; s.onerror = () => { s.remove(); rej(new Error('Could not load ' + new URL(src).hostname)); };
  document.head.appendChild(s);
});
let cfg;
const getCfg = async () => cfg || (cfg = await api('/api/config'));

/* ---------- scanner state ---------- */
let stream = null, scanTimer = null;
function stopScanner() {
  clearInterval(scanTimer); scanTimer = null;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

/* ---------- router ---------- */
async function route() {
  stopScanner();
  const [, page = '', a = '', b = ''] = (location.hash || '#/').split('/');
  document.querySelectorAll('nav a').forEach(l => l.classList.toggle('on', l.dataset.r === page));
  window.scrollTo(0, 0);
  try {
    if (page === '') await home();
    else if (page === 'event') await eventPage(a);
    else if (page === 'sell') sellPage();
    else if (page === 'tickets') await myTickets();
    else if (page === 'ticket') await ticketPage(a);
    else if (page === 'hosting') await hostingList();
    else if (page === 'host') await hostPage(a, b);
    else $app.innerHTML = '<p class="empty">Page not found. <a href="#/">Back to events</a></p>';
  } catch (e) {
    $app.innerHTML = `<p class="empty">${esc(e.message)} <a href="#/">Back to events</a></p>`;
  }
}
window.addEventListener('hashchange', route);

/* ---------- home ---------- */
async function home() {
  const events = await api('/api/events');
  $app.innerHTML = `
    <section class="intro">
      <div><h1>Find a ticket.<br>Or sell your own.</h1>
      <p>Pay securely with Interswitch, get a QR code, and walk in. Hosting something? List it in a minute.</p></div>
      <a class="btn" href="#/sell">Sell tickets</a>
    </section>
    ${events.length ? `<div class="grid">${events.map(e => `
      <a class="card" href="#/event/${esc(e.id)}">
        <h3>${esc(e.title)}</h3>
        <div class="meta"><span>${esc(fmtDate(e.date))}</span><span>${esc(e.venue)}</span></div>
        <div class="row"><span class="price">${naira(e.price)}</span>
        ${e.remaining ? `<span class="pill">${e.remaining} left</span>` : '<span class="pill bad">Sold out</span>'}</div>
      </a>`).join('')}</div>` : '<p class="empty">No events yet. Be the first to <a href="#/sell">sell tickets</a>.</p>'}`;
}

/* ---------- event + buy ---------- */
async function eventPage(id) {
  const e = await api('/api/events/' + encodeURIComponent(id));
  const c = await getCfg();
  const max = Math.min(10, e.remaining);
  $app.innerHTML = `
    <a class="back" href="#/">‹ All events</a>
    <div class="split">
      <div>
        <h1>${esc(e.title)}</h1>
        <dl class="facts">
          <div><dt>When</dt><dd>${esc(fmtDate(e.date))}</dd></div>
          <div><dt>Where</dt><dd>${esc(e.venue)}</dd></div>
          <div><dt>Hosted by</dt><dd>${esc(e.hostName)}</dd></div>
        </dl>
        ${e.description ? `<p class="desc">${esc(e.description)}</p>` : ''}
      </div>
      ${max < 1 ? '<div class="panel"><h2>Sold out</h2><p class="note">All tickets for this event have been claimed.</p></div>' : `
      <form id="buy" class="panel">
        <h2>${e.price > 0 ? naira(e.price) + ' per ticket' : 'Free entry'}</h2>
        <label>Full name<input name="buyer" required autocomplete="name"></label>
        <label>Email<input name="email" type="email" required autocomplete="email"></label>
        <label>Tickets<select name="qty">${Array.from({ length: max }, (_, i) => `<option>${i + 1}</option>`).join('')}</select></label>
        <div class="total"><span>Total</span><span id="total">${naira(e.price)}</span></div>
        <button class="btn block" type="submit">${e.price > 0 ? 'Pay with Interswitch' : 'Get free ticket'}</button>
        ${c.demo && e.price > 0 ? '<button class="btn ghost block" type="button" id="sim">Simulate payment (demo mode)</button>' : ''}
        <p class="note">${e.price > 0 ? 'You will pay in a secure Interswitch window. Your QR ticket appears right after.' : 'Your QR ticket appears right after.'}</p>
      </form>`}
    </div>`;
  const f = document.getElementById('buy');
  if (!f) return;
  const sim = document.getElementById('sim');
  if (sim) sim.onclick = async () => {
    if (!f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f)); sim.disabled = true;
    try {
      const o = await api('/api/orders', { method: 'POST', body: { eventId: e.id, name: d.buyer, email: d.email, quantity: Number(d.qty) } });
      const r = await api(`/api/orders/${encodeURIComponent(o.txnRef)}/verify?demo=1`, { method: 'POST' });
      finish(r.tickets);
    } catch (err) { toast(err.message); } finally { sim.disabled = false; }
  };
  f.qty.onchange = () => { document.getElementById('total').textContent = naira(e.price * Number(f.qty.value)); };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      const o = await api('/api/orders', { method: 'POST', body: { eventId: e.id, name: d.buyer, email: d.email, quantity: Number(d.qty) } });
      if (o.free) return finish(o.tickets);
      await checkout(o, e);
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  };
}

async function checkout(o, e) {
  const c = await getCfg();
  for (const u of c.checkoutUrls) {
    try { await loadScript(u); } catch {}
    if (typeof window.webpayCheckout === 'function') break;
  }
  if (typeof window.webpayCheckout !== 'function') throw new Error('Could not reach Interswitch from this network. Try a phone hotspot, and turn off any VPN or ad blocker.');
  return new Promise(resolve => {
    window.webpayCheckout({
      merchant_code: c.merchantCode,
      pay_item_id: c.payItemId,
      pay_item_name: e.title,
      txn_ref: o.txnRef,
      site_redirect_url: location.origin + location.pathname,
      amount: o.amountKobo,
      currency: 566,
      cust_id: o.email,
      cust_name: o.name,
      cust_email: o.email,
      mode: c.mode,
      onComplete: async resp => {
        console.log('Interswitch response', resp);
        try {
          const r = await api(`/api/orders/${encodeURIComponent(o.txnRef)}/verify`, { method: 'POST' });
          finish(r.tickets);
        } catch (err) { toast(err.message); }
        resolve();
      }
    });
  });
}

function finish(tickets) {
  const mine = store.get('swipe_tickets', []);
  store.set('swipe_tickets', [...tickets.map(t => t.code), ...mine.filter(c => !tickets.some(t => t.code === c))]);
  location.hash = tickets.length === 1 ? '#/ticket/' + tickets[0].code : '#/tickets';
}

/* ---------- tickets ---------- */
async function ticketPage(code) {
  const { ticket: t, event: e, qr } = await api('/api/tickets/' + encodeURIComponent(code));
  $app.innerHTML = `
    <a class="back" href="#/tickets">‹ My tickets</a>
    <article class="ticket">
      <div class="head">
        <span class="pill ${t.usedAt ? 'warn' : 'ok'}">${t.usedAt ? 'Used' : 'Valid'}</span>
        <h1>${esc(e ? e.title : 'Event')}</h1>
        <div class="meta">${e ? `<span>${esc(fmtDate(e.date))}</span><span>${esc(e.venue)}</span>` : ''}<span>${esc(t.name)}</span></div>
      </div>
      <div class="tear"></div>
      <div class="body">
        <img src="${qr}" alt="QR code for ticket ${esc(t.code)}">
        <div class="code">${esc(t.code)}</div>
        <p class="note">Show this code at the entrance.</p>
        <a class="btn ghost small" href="${qr}" download="${esc(t.code)}.png">Save QR image</a>
      </div>
    </article>`;
}

async function myTickets() {
  const codes = store.get('swipe_tickets', []);
  const list = codes.length ? await api('/api/tickets?codes=' + encodeURIComponent(codes.join(','))) : [];
  $app.innerHTML = `<h1 style="font-size:2rem;margin:24px 0">My tickets</h1>` + (list.length ? `<div class="stack">${list.map(({ ticket: t, event: e }) => `
    <a class="item" href="#/ticket/${esc(t.code)}">
      <div><strong>${esc(e.title || 'Event')}</strong><div class="meta"><span>${esc(fmtDate(e.date))}</span><span class="code">${esc(t.code)}</span></div></div>
      <span class="pill ${t.usedAt ? 'warn' : 'ok'}">${t.usedAt ? 'Used' : 'Valid'}</span>
    </a>`).join('')}</div>` : '<p class="empty">Tickets you buy on this device show up here. <a href="#/">Browse events</a></p>');
}

/* ---------- sell ---------- */
function sellPage() {
  $app.innerHTML = `
    <div class="narrow">
      <h1 style="font-size:2.2rem;margin:24px 0 8px">Sell tickets</h1>
      <p class="note" style="margin-bottom:24px">Set up your event. Leave the price at 0 to make it free.</p>
      <form id="sell" class="panel">
        <label>Event title<input name="title" required maxlength="100"></label>
        <label>Description <small>optional</small><textarea name="description" maxlength="1000"></textarea></label>
        <label>Venue<input name="venue" required maxlength="120"></label>
        <label>Date and time<input name="date" type="datetime-local" required></label>
        <div class="two">
          <label>Price per ticket (₦)<input name="price" type="number" min="0" step="1" value="0" required></label>
          <label>Number of tickets<input name="capacity" type="number" min="1" step="1" value="100" required></label>
        </div>
        <label>Your name or organisation<input name="hostName" maxlength="80"></label>
        <button class="btn block" type="submit">Publish event</button>
      </form>
    </div>`;
  const f = document.getElementById('sell');
  f.onsubmit = async ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      const e = await api('/api/events', { method: 'POST', body: { ...d, date: new Date(d.date).toISOString(), price: Number(d.price), capacity: Number(d.capacity) } });
      const hosts = store.get('swipe_hosts', {}); hosts[e.id] = e.hostKey; store.set('swipe_hosts', hosts);
      toast('Event published');
      location.hash = `#/host/${e.id}/${e.hostKey}`;
    } catch (err) { toast(err.message); btn.disabled = false; }
  };
}

/* ---------- hosting ---------- */
async function hostingList() {
  const hosts = store.get('swipe_hosts', {});
  const ids = Object.keys(hosts);
  const events = (await Promise.all(ids.map(id => api('/api/events/' + id).catch(() => null)))).filter(Boolean);
  $app.innerHTML = `<h1 style="font-size:2rem;margin:24px 0">Hosting</h1>` + (events.length ? `<div class="stack">${events.map(e => `
    <a class="item" href="#/host/${esc(e.id)}/${esc(hosts[e.id])}">
      <div><strong>${esc(e.title)}</strong><div class="meta"><span>${esc(fmtDate(e.date))}</span></div></div>
      <span class="pill">${e.sold} / ${e.capacity} sold</span>
    </a>`).join('')}</div>` : '<p class="empty">Events you create on this device show up here. <a href="#/sell">Sell tickets</a></p>');
}

async function hostPage(id, key) {
  const q = () => api(`/api/events/${encodeURIComponent(id)}/attendees?key=${encodeURIComponent(key)}`);
  let d = await q();
  $app.innerHTML = `
    <a class="back" href="#/hosting">‹ Hosting</a>
    <h1 style="font-size:2rem">${esc(d.event.title)}</h1>
    <div class="meta" style="margin-top:8px"><span>${esc(fmtDate(d.event.date))} · ${esc(d.event.venue)}</span><span><a href="#/event/${esc(id)}">Public event page</a></span></div>
    <div class="stats" id="stats"></div>
    <div class="split" style="grid-template-columns:360px 1fr">
      <div class="panel">
        <h2>Check in</h2>
        <video id="cam" playsinline muted></video>
        <button class="btn ghost" id="camBtn" type="button">Start camera</button>
        <div id="res" class="result" role="status"></div>
        <form id="manual" class="inline"><input name="code" placeholder="Or type a code, e.g. SWP-…" autocomplete="off" required><button class="btn" type="submit">Check</button></form>
      </div>
      <div class="tablewrap" id="list"></div>
    </div>`;
  const paint = () => {
    document.getElementById('stats').innerHTML = `
      <div class="stat"><b>${d.tickets.length} / ${d.event.capacity}</b><span>Tickets sold</span></div>
      <div class="stat"><b>${d.checkedIn}</b><span>Checked in</span></div>
      <div class="stat"><b>${naira(d.revenue) === 'Free' ? '₦0' : naira(d.revenue)}</b><span>Ticket sales</span></div>`;
    document.getElementById('list').innerHTML = d.tickets.length ? `<table><thead><tr><th>Name</th><th>Code</th><th>Status</th></tr></thead><tbody>${d.tickets.map(t => `
      <tr><td>${esc(t.name)}<div class="meta">${esc(t.email)}</div></td><td class="code">${esc(t.code)}</td>
      <td><span class="pill ${t.usedAt ? 'ok' : ''}">${t.usedAt ? 'Checked in' : 'Not yet'}</span></td></tr>`).join('')}</tbody></table>` : '<p class="empty">No tickets sold yet.</p>';
  };
  paint();
  const res = document.getElementById('res');
  const show = (cls, msg) => { res.className = 'result ' + cls; res.textContent = msg; };
  async function check(code) {
    try {
      const r = await api(`/api/events/${encodeURIComponent(id)}/scan`, { method: 'POST', body: { hostKey: key, code } });
      if (r.status === 'valid') show('ok', `Valid — ${r.ticket.name}`);
      else show('warn', `Already used — ${r.ticket.name}, ${new Date(r.ticket.usedAt).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}`);
      d = await q(); paint();
    } catch (err) { show('bad', err.message); }
  }
  document.getElementById('manual').onsubmit = ev => { ev.preventDefault(); const i = ev.target.code; check(i.value); i.value = ''; };
  const video = document.getElementById('cam');
  document.getElementById('camBtn').onclick = async ev => {
    const btn = ev.target;
    if (stream) { stopScanner(); video.style.display = 'none'; btn.textContent = 'Start camera'; return; }
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch { return toast('Camera unavailable. Type the ticket code instead.'); }
    video.srcObject = stream; video.style.display = 'block'; await video.play(); btn.textContent = 'Stop camera';
    const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
    let last = '', lastAt = 0;
    scanTimer = setInterval(() => {
      if (!video.videoWidth || !window.jsQR) return;
      c.width = video.videoWidth; c.height = video.videoHeight;
      x.drawImage(video, 0, 0);
      const img = x.getImageData(0, 0, c.width, c.height);
      const r = window.jsQR(img.data, c.width, c.height);
      if (r && r.data && (r.data !== last || Date.now() - lastAt > 4000)) { last = r.data; lastAt = Date.now(); check(r.data); }
    }, 250);
  };
}

route();

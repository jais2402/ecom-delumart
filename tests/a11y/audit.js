const { chromium } = require('playwright');
const { execSync } = require('node:child_process');
const path = require('node:path');
// Run against a dev server (AUTH_PROVIDER=dev):  BASE_URL=http://localhost:3000 node tests/a11y/audit.js
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
// path, whether it needs a signed-in account, and whether the cart is filled first
const pages = [
  { path: '/' },
  { path: '/c/impossible-tech' },
  { path: '/p/{product}' },
  { path: '/search?q=jar' },
  { path: '/design-system' },
  { path: '/sign-in' },
  { path: '/cart', cart: true },
  { path: '/cart', signedIn: true, cart: true, label: '/cart (signed in)' },
  { path: '/account', signedIn: true },
  { path: '/account/profile', signedIn: true },
  { path: '/account/saved', signedIn: true },
  { path: '/sell', label: '/sell (signed out)' },
  { path: '/sell', signedIn: true, label: '/sell (signed in)' },
  { path: '/sell/passport', signedIn: true },
  { path: '/store/{handle}' },
  { path: '/account/reports', signedIn: true },
  { path: '/account/blocks', signedIn: true },
  { path: '/account/addresses', signedIn: true },
  // DeluluPay (PRD R4): the Payments list and the bank inbox with rows (see makePayments), and the two
  // bank steps of checkout (net banking with a code in the inbox, an approval request in it)
  { path: '/account/payments', signedIn: true, payments: true },
  { path: '/account/bank-inbox', signedIn: true, payments: true },
  { path: '/p/{product}', signedIn: true, flow: 'netBanking', label: '/checkout (net banking step)' },
  { path: '/p/{product}', signedIn: true, flow: 'approval', label: '/checkout (DeluluPay ID approval step)' },
  { path: '/account/addresses?add=1', signedIn: true, label: '/account/addresses (add form)' },
  { path: '/p/{product}', signedIn: true, openDialog: 'Report this product', label: '/p/[id] report dialog' },
  // the Partner Portal and the Commerce Console: operator frames have no site footer
  { path: '/studio', as: 'owner', operator: true },
  { path: '/studio/new', as: 'owner', operator: true },
  { path: '/studio/{listing}', as: 'owner', operator: true, label: '/studio/[id] (published listing)' },
  { path: '/studio/{draft}', as: 'owner', operator: true, label: '/studio/[id] (draft)' },
  { path: '/studio/inventory', as: 'owner', operator: true },
  { path: '/studio/pricing', as: 'owner', operator: true },
  { path: '/studio/shipping', as: 'owner', operator: true },
  { path: '/studio/overview', as: 'owner', operator: true },
  { path: '/studio/orders', as: 'owner', operator: true },
  { path: '/studio/earnings', as: 'owner', operator: true },
  { path: '/studio/coupons', as: 'owner', operator: true },
  { path: '/studio/appeals', as: 'owner', operator: true },
  { path: '/console/moderation', as: 'admin', operator: true },
  { path: '/console/reports', as: 'admin', operator: true },
  { path: '/console/reviews', as: 'admin', operator: true },
  { path: '/console/actions', as: 'admin', operator: true },
  { path: '/console/configuration', as: 'admin', operator: true },
  // analytics screens: the admin API is answered by fixtures (no Super Admin needed, see mockAnalytics)
  { path: '/console/analytics', as: 'mocked', operator: true },
  { path: '/console/analytics/places', as: 'mocked', operator: true },
  { path: '/console/analytics/places?level=city&country=IN&region=Maharashtra', as: 'mocked', operator: true, label: '/console/analytics/places (city level)' },
  { path: '/console/analytics/top', as: 'mocked', operator: true },
  { path: '/console/analytics/top?kind=company', as: 'mocked', operator: true, label: '/console/analytics/top (shops)' },
  { path: '/console/analytics/top', as: 'mocked', operator: true, mockMode: 'empty', label: '/console/analytics/top (empty)' },
  { path: '/console/analytics', as: 'mocked', operator: true, mockMode: 'error', label: '/console/analytics (error)' },
  { path: '/console/analytics', label: '/console/analytics (not available)' },
  { path: '/console/reports', label: '/console/reports (not available)' },
  { path: '/console/moderation', label: '/console/moderation (not available)' },
  { path: '/console/actions', label: '/console/actions (not available)' },
  { path: '/console/configuration', label: '/console/configuration (not available)' },
];
const sizes = [[1280, 900], [360, 800]];
const schemes = ['light', 'dark'];
const pageFn = () => {
  const out = { overflow: null, names: [], h: [], touch: [], contrast: [], landmarks: {} };
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) out.overflow = `${de.scrollWidth}>${de.clientWidth}`;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\s+/).slice(0, 3).join('.') : '') + ' "' + (el.textContent || '').trim().slice(0, 30) + '"';
  const hidden = (el) => !!el.closest('[aria-hidden="true"]');
  const labelOf = (el) => {
    let n = el.getAttribute('aria-label'); if (n && n.trim()) return n;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ').trim(); if (t) return t; }
    if (el.labels && el.labels.length) { const t = [...el.labels].map((l) => l.textContent).join(' ').trim(); if (t) return t; }
    const t = (el.textContent || '').trim(); if (t) return t;
    const img = el.querySelector('img[alt]:not([alt=""]), [role=img][aria-label], svg[aria-label]'); if (img) return img.getAttribute('alt') || img.getAttribute('aria-label');
    return (el.getAttribute('title') || '').trim();
  };
  document.querySelectorAll('img, svg[role=img], [role=img]').forEach((el) => {
    if (hidden(el)) return;
    if (el.tagName === 'IMG' && el.getAttribute('alt') === '') return;
    const n = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('aria-labelledby') || el.querySelector('title');
    if (!n) out.names.push('IMG ' + desc(el));
  });
  document.querySelectorAll('svg:not([role]):not([aria-hidden])').forEach((el) => { if (!hidden(el) && vis(el) && !el.closest('[role=img]') && !el.getAttribute('aria-label')) out.names.push('SVG unmarked ' + desc(el.parentElement)); });
  const inter = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=switch], summary';
  const interactive = [...document.querySelectorAll(inter)].filter((e) => vis(e) && !hidden(e));
  interactive.forEach((el) => {
    if (!labelOf(el)) out.names.push('NAME ' + desc(el));
    const r = el.getBoundingClientRect();
    let h = r.height, w = r.width;
    if ((el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)) ) { const l = el.closest('label'); if (l) { const lr = l.getBoundingClientRect(); h = Math.max(h, lr.height); w = Math.max(w, lr.width); } }
    // inline text links within paragraphs are exempt (WCAG 2.5.8 inline exception)
    const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
    const stretched = el.className && String(el.className).includes('after:absolute');
    const skip = String(el.className).includes('sr-only');
    if (stretched || skip) return;
    if (h < 43.5 && !inline) out.touch.push(`${Math.round(w)}x${Math.round(h)} ${desc(el)}`);
    else if (inline && h < 43.5) out.touch.push(`(inline) ${Math.round(w)}x${Math.round(h)} ${desc(el)}`);
  });
  const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')].filter((e) => vis(e) && !hidden(e));
  const lv = hs.map((h) => +(h.tagName[1] || h.getAttribute('aria-level')));
  const h1 = lv.filter((l) => l === 1).length; if (h1 !== 1) out.h.push(`h1 count=${h1}`);
  let prev = 0; hs.forEach((h, i) => { if (prev && lv[i] > prev + 1) out.h.push(`skip h${prev}->h${lv[i]} "${h.textContent.trim().slice(0, 30)}"`); prev = lv[i]; });
  // contrast
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/) || c.match(/color\(srgb ([^)]+)\)/); if (!m) return null; let p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); if (c.startsWith('color(')) p = [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; return [p[0], p[1], p[2], p[3] ?? 1]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { chain.push(c); if (c[3] >= 1) break; } if (getComputedStyle(e).backgroundImage !== 'none') return null; } let base = [255, 255, 255, 1]; for (let i = chain.length - 1; i >= 0; i--) base = blend(chain[i], base); return base; };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = walker.nextNode())) {
    if (!n.textContent.trim()) continue; const el = n.parentElement; if (!el || seen.has(el) || !vis(el)) continue; seen.add(el);
    if (el.closest('script,style,noscript')) continue;
    const s = getComputedStyle(el); if (s.opacity === '0') continue;
    const fgc = parse(s.color); const bg = bgOf(el); if (!fgc || !bg) { if (!bg) out.contrast.push('?bgimage ' + desc(el)); continue; }
    const fg = blend(fgc, bg); const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(s.fontSize), bold = parseInt(s.fontWeight) >= 700; const large = px >= 24 || (px >= 18.66 && bold);
    const dis = el.closest(':disabled, [aria-disabled=true]');
    out.min = Math.min(out.min ?? 99, ratio); out.n = (out.n || 0) + 1; if (ratio < (large ? 3 : 4.5) && !dis) out.contrast.push(`${ratio.toFixed(2)} ${s.color} on rgb(${bg.slice(0, 3).map(Math.round)}) ${desc(el)}`);
  }
  const lm = (sel) => document.querySelectorAll(sel).length;
  out.landmarks = { main: lm('main,[role=main]'), banner: lm('body > header, header[role=banner], [role=banner], #root > header, body header'), footer: lm('footer,[role=contentinfo]') };
  const navs = [...document.querySelectorAll('nav,[role=navigation]')];
  out.landmarks.navs = navs.length; out.landmarks.unlabelledNavs = navs.length > 1 ? navs.filter((x) => !x.getAttribute('aria-label') && !x.getAttribute('aria-labelledby')).map(desc) : [];
  out.landmarks.skip = !!document.querySelector('a[href^="#"]');
  return out;
};
// Answers /api/v1/admin/analytics/* with fixtures so the screens can be audited without the Super Admin role.
// mode: 'data' | 'empty' | 'error' (the time series fails, the rest answers).
async function mockAnalytics(page, mode) {
  const DAY = 86400000;
  const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
  const span = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY + 1;
  await page.route('**/api/v1/admin/analytics/**', (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split('/').pop();
    const q = Object.fromEntries(url.searchParams);
    const empty = mode === 'empty';
    const base = { from: q.from, to: q.to, days: span(q.from, q.to), asOf: new Date().toISOString() };
    if (mode === 'error' && name === 'timeseries') return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'The analytics service is unavailable.', retryable: false, details: {} } } });
    if (name === 'overview') {
      const t = (v) => ({ visitors: v, trafficDays: Math.max(base.days - 5, 0), signUps: v ? 21 : 0, orders: v ? 9 : 0, spendPaise: v ? '18450000' : '0', averageOrderValuePaise: v ? '2050000' : null, creatorUnlocks: v ? 1 : 0, shopsRegistered: v ? 3 : 0, listingsPublished: v ? 4 : 0 });
      return route.fulfill({ json: { ...base, previousFrom: shift(q.from, -base.days), previousTo: shift(q.from, -1), current: t(empty ? 0 : 1284), previous: { ...t(empty ? 0 : 1100), shopsRegistered: 0, orders: empty ? 0 : 12 }, trafficComputedAt: empty ? null : new Date().toISOString() } });
    }
    if (name === 'timeseries') {
      const points = Array.from({ length: base.days }, (_, i) => ({ day: shift(q.from, i), value: empty || i % 7 === 3 ? null : String(40 + ((i * 17) % 60)) }));
      return route.fulfill({ json: { ...base, metric: q.metric, unit: 'count', source: 'events', points } });
    }
    if (name === 'funnel') {
      const v = empty ? [0, 0, 0, 0, 0] : [1284, 642, 128, 64, 9];
      const keys = ['visitors', 'product_views', 'cart_adds', 'checkout_starts', 'purchases'];
      return route.fulfill({ json: { ...base, steps: keys.map((step, i) => ({ step, visitors: v[i], conversionFromPrevious: i === 0 || !v[i - 1] ? null : v[i] / v[i - 1] })), overallConversion: empty ? null : 9 / 1284, trafficDays: base.days } });
    }
    if (name === 'places') {
      const rows = { country: [['IN', null, null, 820], ['US', null, null, 210], ['ZZ', null, null, 40], ['Other', null, null, null]], region: [['IN', 'Maharashtra', null, 410], ['IN', null, null, 90]], city: [['IN', 'Maharashtra', 'Pune', 120], ['IN', 'Maharashtra', null, 40]] }[q.level] || [];
      // a row below the minimum even after merging comes back suppressed, with no counts (0059)
      const items = empty ? [] : rows.map(([country, region, city, visitors]) => (visitors === null ? { country, region, city, visitors: null, signUps: null, purchases: null, suppressed: true } : { country, region, city, visitors, signUps: 3, purchases: 1, suppressed: false }));
      return route.fulfill({ json: { ...base, level: q.level, country: q.country || null, region: q.region || null, minVisitors: 5, items, trafficDays: base.days } });
    }
    if (name === 'top') {
      const all = { product: [{ productId: 'p1', name: 'Pocket Cloud', category: 'impossible-tech', shop: { name: 'Cloud Works', handle: 'cloud-works' }, orders: 4, units: 5, spendPaise: '1100000' }, { productId: 'p2', name: 'Moonlight Kettle', category: 'impossible-tech', shop: null, orders: 3, units: 3, spendPaise: '750000' }], company: [{ companyId: null, shop: null, orders: 6, units: 6, spendPaise: '1500000' }, { companyId: 'c1', shop: { name: 'Cloud Works', handle: 'cloud-works' }, orders: 4, units: 5, spendPaise: '1100000' }], category: [{ category: 'impossible-tech', orders: 9, units: 9, spendPaise: '2600000' }] };
      return route.fulfill({ json: { ...base, kind: q.kind, limit: 10, items: empty ? [] : all[q.kind] } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'unknown', retryable: false, details: {} } } });
  });
}
const rand = () => Math.random().toString(36).slice(2, 10);

// A real product id from the public catalog route (the seed's addresses are not stable).
async function discoverProducts() {
  const response = await fetch(BASE + '/api/v1/catalog?limit=50');
  if (!response.ok) throw new Error('catalog route answered ' + response.status + ' (is the dev server up and seeded?)');
  const { items } = await response.json();
  const ready = items.filter((p) => p.available);
  if (ready.length < 2) throw new Error('the catalog has fewer than two available products');
  return ready;
}

// Sign in through the dev flow and finish onboarding with API calls from the page itself, so the
// browser holds the session cookie. Returns once /api/v1/me reports a finished account.
async function signInAndOnboard(page, address) {
  await page.goto(BASE + '/');
  await page.evaluate(async ({ email, phone }) => {
    const post = async (path, body, token) => {
      const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + (await r.text()).slice(0, 120));
      return r.json();
    };
    const token = (await (await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })).json()).csrfToken;
    // signing in answers the CSRF token bound to the new session; later calls use that one
    const session = (await post('/api/v1/auth/dev/sign-in', { email }, token)).csrfToken;
    await post('/api/v1/onboarding/phone', { phone }, session);
    await post('/api/v1/onboarding/phone/verify', { code: '000000' }, session);
    await post('/api/v1/onboarding/birthdate', { birthdate: '1995-06-15' }, session);
    const created = await post('/api/v1/onboarding/provision', {}, session);
    await post('/api/v1/cards/' + created.card.id + '/pin', { pin: '482915' }, session);
  }, { email: address || `audit-${rand()}@example.com`, phone: `+91 9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}` });
}

// Opens a shop for a throw-away account (passport unlock, then the registration quote paid from the
// bank balance) so the public shop page can be audited. Returns the handle.
async function createStore(page, products, handle) {
  await page.evaluate(async ({ handle: h, ids }) => {
    const call = async (method, path, body, extra = {}) => {
      const token = (await (await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })).json()).csrfToken;
      const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': token, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await r.json();
      if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(json).slice(0, 160));
      return json;
    };
    await call('POST', '/api/v1/passport/quiz', { answers: { 'q-money': 'opt-money-play', 'q-delivery': 'opt-delivery-sim', 'q-buyers': 'opt-buyers-sim' } });
    for (const id of ids) await call('POST', '/api/v1/saves', { productId: id });
    await call('POST', '/api/v1/passport/concept', { concept: 'A kettle that boils moonlight into tea.' });
    const quote = await call('POST', '/api/v1/company/quote', { handle: h, displayName: 'Audit Shop', description: 'A shop made by the accessibility audit.' });
    const attempt = await call('POST', '/api/v1/checkout-sessions/' + quote.sessionId + '/attempts', { method: 'BALANCE' });
    await call('POST', '/api/v1/company/register', { sessionId: quote.sessionId, attemptId: attempt.id }, { 'idempotency-key': crypto.randomUUID() });
  }, { handle, ids: products.slice(0, 3).map((p) => p.id) });
}


// Sign an existing, finished account in again (the dev provider needs only the email).
async function signInOnly(page, email) {
  await page.goto(BASE + '/');
  await page.evaluate(async (address) => {
    const token = (await (await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })).json()).csrfToken;
    const r = await fetch('/api/v1/auth/dev/sign-in', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify({ email: address }) });
    if (!r.ok) throw new Error('sign-in ' + r.status);
  }, email);
}

// A published listing, a listing waiting for review (its text needs a person) and a plain draft,
// for the shop owner's studio pages and the moderation queue. Returns the ids.
async function createListings(page) {
  return page.evaluate(async () => {
    const call = async (method, path, body) => {
      const token = (await (await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })).json()).csrfToken;
      const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await r.json();
      if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(json).slice(0, 160));
      return json;
    };
    const base = { category: 'impossible-tech', templateId: 120, altText: 'A drawing of the product', priceRupees: 2500, inventoryMode: 'STANDARD_STOCKED', quantity: 3 };
    const make = async (name, description) => (await call('POST', '/api/v1/studio/products', { ...base, name, description })).product;
    const live = await make('Audit Pocket Cloud', 'A small friendly cloud that follows you around and rains on bad news.');
    await call('POST', '/api/v1/studio/products/' + live.id + '/submit', {});
    const review = await make('Official Audit Teapot', 'A teapot that pours a different kind of weather into every cup.');
    await call('POST', '/api/v1/studio/products/' + review.id + '/submit', {});
    const draft = await make('Audit Draft Kite', 'A kite that flies itself and comes home before supper every day.');
    return { live: live.id, review: review.id, draft: draft.id };
  });
}

// A finished account that becomes the Super Admin through the local setup script.
async function makeAdmin(page, email) {
  await signInAndOnboard(page, email);
  execSync('pnpm dev:setup', { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, SUPER_ADMIN_EMAIL: email }, stdio: 'pipe' });
}

async function addToServerCart(page, productId) {
  await page.evaluate(async (id) => {
    const token = (await (await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })).json()).csrfToken;
    const r = await fetch('/api/v1/cart/lines', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify({ productId: id }) });
    if (!r.ok) throw new Error('cart add ' + r.status);
  }, productId);
}

// A captured balance payment, and a net banking attempt waiting on its code, so the Payments list and the
// bank inbox have rows to audit. Uses the third product (the first two are in the audit's cart).
async function makePayments(page, productId) {
  await page.evaluate(async (id) => {
    const call = async (method, path, body, extra = {}) => {
      const token = (await (await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })).json()).csrfToken;
      const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': token, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await r.json();
      if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(json).slice(0, 160));
      return json;
    };
    const session = async () => call('POST', '/api/v1/checkout-sessions', { lines: [{ productId: id }], speedBySeller: { SEED: 'STANDARD' } }, { 'idempotency-key': crypto.randomUUID() });
    const q1 = await session();
    const a1 = await call('POST', '/api/v1/checkout-sessions/' + q1.id + '/attempts', { method: 'BALANCE' });
    await call('POST', '/api/v1/checkout-sessions/' + q1.id + '/pay', { attemptId: a1.id }, { 'idempotency-key': crypto.randomUUID() });
    const q2 = await session();
    await call('POST', '/api/v1/checkout-sessions/' + q2.id + '/attempts', { method: 'NET_BANKING' });
    await call('POST', '/api/v1/checkout-sessions/' + q2.id + '/challenge');
  }, productId);
}

// Opens checkout for the product and goes to the bank step of the method, leaving it open for the audit.
async function toBankStep(page, method) {
  await page.getByRole('button', { name: 'Buy now' }).click();
  await page.waitForURL(/\/checkout\//);
  await page.getByRole('radio', { name: /Standard/ }).check();
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.getByRole('radio', { name: method === 'netBanking' ? /Net banking/ : /DeluluPay ID/ }).check();
  await page.getByRole('button', { name: 'Review your order' }).click();
  await page.getByRole('button', { name: 'Pay now' }).click();
  if (method === 'netBanking') {
    await page.getByRole('form', { name: 'Delulu Bank SecureCheck' }).waitFor();
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await page.getByTestId('inbox-code').waitFor();
  } else {
    await page.getByRole('heading', { level: 2, name: 'Delulu Bank approval request' }).waitFor();
    await page.getByRole('button', { name: 'Approve' }).waitFor();
  }
  await page.waitForLoadState('networkidle');
}

(async () => {
  const products = await discoverProducts();
  const browser = await chromium.launch();
  const handle = `audit-${rand()}`;
  const ownerEmail = `audit-owner-${rand()}@example.com`;
  const adminEmail = `audit-admin-${rand()}@example.com`;
  let ids = {};
  {
    const ctx = await browser.newContext({ baseURL: BASE });
    const owner = await ctx.newPage();
    await signInAndOnboard(owner, ownerEmail);
    await createStore(owner, products, handle);
    ids = await createListings(owner);
    await ctx.close();
    // SKIP_ADMIN=1 leaves out the Super Admin setup (it runs `pnpm dev:setup`) and the pages that need it
    if (!process.env.SKIP_ADMIN) {
      const actx = await browser.newContext({ baseURL: BASE });
      await makeAdmin(await actx.newPage(), adminEmail);
      await actx.close();
    }
  }
  let failures = 0;
  for (const scheme of schemes) for (const [w, h] of sizes) {
    for (const role of ['anon', 'user', 'owner', 'admin', 'mocked']) {
      if (role === 'admin' && process.env.SKIP_ADMIN) continue;
      const signedIn = role !== 'anon' && role !== 'mocked';
      const list = pages.filter((p) => (p.as || (p.signedIn ? 'user' : 'anon')) === role);
      if (list.length === 0) continue;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, baseURL: BASE });
      const page = await ctx.newPage();
      let paymentsMade = false;
      if (role === 'owner') {
        await signInOnly(page, ownerEmail);
      } else if (role === 'admin') {
        await signInOnly(page, adminEmail);
      } else if (signedIn) {
        await signInAndOnboard(page);
        await addToServerCart(page, products[0].id);
        await addToServerCart(page, products[1].id);
      } else {
        // the signed-out cart is product ids in localStorage
        await ctx.addInitScript((ids) => { try { if (!localStorage.getItem('dm.cart.v1')) localStorage.setItem('dm.cart.v1', JSON.stringify(ids)); } catch {} }, [products[0].id, products[1].id]);
      }
      for (const entry of list) {
        if (role === 'mocked') { await page.unroute('**/api/v1/admin/analytics/**').catch(() => {}); await mockAnalytics(page, entry.mockMode || 'data'); }
        const p = entry.path.replace('{product}', (entry.flow === 'netBanking' ? products[2] : entry.flow === 'approval' ? products[3] : products[0]).id).replace('{handle}', handle).replace('{listing}', ids.live).replace('{draft}', ids.draft);
        if (entry.payments && !paymentsMade) { await makePayments(page, products[4].id); paymentsMade = true; }
        await page.goto(BASE + p, { waitUntil: 'networkidle' });
        // client screens fill in after the first paint: wait for a heading and for loading to settle
        await page.getByRole('heading', { level: 1 }).first().waitFor();
        await page.waitForLoadState('networkidle');
        if (entry.cart) await page.waitForSelector('button[aria-label^="Remove "]');
        if (entry.flow) await toBankStep(page, entry.flow);
        if (entry.openDialog) {
          await page.getByRole('button', { name: entry.openDialog }).click();
          await page.getByRole('dialog').waitFor();
        }
        const key = `${entry.label || p} ${w} ${scheme}`;
        const r = await page.evaluate(pageFn);
        const focus = [];
        // screens that move focus to their heading on arrival start tabbing after it, not at the skip link
        const startedOnHeading = await page.evaluate(() => !!document.activeElement && /^H[1-6]$/.test(document.activeElement.tagName));
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        for (let i = 0; i < 15; i++) {
          await page.keyboard.press('Tab');
          const f = await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const s = getComputedStyle(e); const rect = e.getBoundingClientRect(); return { t: e.tagName + ' ' + (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 25), ol: s.outlineStyle, ow: s.outlineWidth, bs: s.boxShadow, w: rect.width, h: rect.height, fw: (() => { const a = e.closest('article'); if (!a) return false; const as = getComputedStyle(a); return as.outlineStyle !== 'none' && parseFloat(as.outlineWidth) > 0; })() }; });
          // focus left the page (a short page, or the dev-only Next.js overlay): nothing more to check
          if (!f || /^NEXTJS-PORTAL/.test(f.t)) break;
          if (i === 0 && !startedOnHeading && !entry.openDialog && !/skip|main|content/i.test(f.t)) focus.push('first stop not skip link: ' + f.t);
          if (i === 0 && !startedOnHeading && !entry.openDialog && f.h < 43.5) focus.push('skip link focused height ' + f.h);
          const visible = (f.ol !== 'none' && parseFloat(f.ow) > 0 && f.ol !== 'none') || (f.bs && f.bs !== 'none') || f.fw;
          if (!visible) focus.push(`no focus indicator: ${f.t} (${f.ol} ${f.ow})`);
        }
        const issues = [];
        if (r.overflow) issues.push('OVERFLOW ' + r.overflow);
        r.names.forEach((x) => issues.push(x)); if (!entry.openDialog) r.h.forEach((x) => issues.push('HEAD ' + x));
        r.touch.forEach((x) => issues.push('TOUCH ' + x)); r.contrast.forEach((x) => issues.push('CONTRAST ' + x));
        focus.forEach((x) => issues.push('FOCUS ' + x));
        const L = r.landmarks; if (L.main !== 1) issues.push('LM main=' + L.main); if (!L.banner) issues.push('LM banner missing'); if (!L.footer && !entry.operator) issues.push('LM footer=' + L.footer); L.unlabelledNavs.forEach((x) => issues.push('LM unlabelled nav ' + x));
        failures += issues.length;
        console.log(`== ${key}: ${issues.length} issues (contrast nodes ${r.n} min ${r.min && r.min.toFixed(2)})`);
        issues.slice(0, +process.env.MAX || 12).forEach((x) => console.log('   ' + x));
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`\nTotal issues: ${failures}`);
  if (failures) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exit(1); });

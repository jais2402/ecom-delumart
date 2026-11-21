const { chromium } = require('playwright');
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
async function signInAndOnboard(page) {
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
  }, { email: `audit-${rand()}@example.com`, phone: `+91 9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}` });
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

async function addToServerCart(page, productId) {
  await page.evaluate(async (id) => {
    const token = (await (await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })).json()).csrfToken;
    const r = await fetch('/api/v1/cart/lines', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify({ productId: id }) });
    if (!r.ok) throw new Error('cart add ' + r.status);
  }, productId);
}

(async () => {
  const products = await discoverProducts();
  const browser = await chromium.launch();
  const handle = `audit-${rand()}`;
  {
    const ctx = await browser.newContext({ baseURL: BASE });
    const owner = await ctx.newPage();
    await signInAndOnboard(owner);
    await createStore(owner, products, handle);
    await ctx.close();
  }
  let failures = 0;
  for (const scheme of schemes) for (const [w, h] of sizes) {
    for (const signedIn of [false, true]) {
      const list = pages.filter((p) => !!p.signedIn === signedIn);
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, baseURL: BASE });
      const page = await ctx.newPage();
      if (signedIn) {
        await signInAndOnboard(page);
        await addToServerCart(page, products[0].id);
        await addToServerCart(page, products[1].id);
      } else {
        // the signed-out cart is product ids in localStorage
        await ctx.addInitScript((ids) => { try { if (!localStorage.getItem('dm.cart.v1')) localStorage.setItem('dm.cart.v1', JSON.stringify(ids)); } catch {} }, [products[0].id, products[1].id]);
      }
      for (const entry of list) {
        const p = entry.path.replace('{product}', products[0].id).replace('{handle}', handle);
        await page.goto(BASE + p, { waitUntil: 'networkidle' });
        // client screens fill in after the first paint: wait for a heading and for loading to settle
        await page.getByRole('heading', { level: 1 }).first().waitFor();
        await page.waitForLoadState('networkidle');
        if (entry.cart) await page.waitForSelector('button[aria-label^="Remove "]');
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
          if (i === 0 && !startedOnHeading && !/skip|main|content/i.test(f.t)) focus.push('first stop not skip link: ' + f.t);
          if (i === 0 && !startedOnHeading && f.h < 43.5) focus.push('skip link focused height ' + f.h);
          const visible = (f.ol !== 'none' && parseFloat(f.ow) > 0 && f.ol !== 'none') || (f.bs && f.bs !== 'none') || f.fw;
          if (!visible) focus.push(`no focus indicator: ${f.t} (${f.ol} ${f.ow})`);
        }
        const issues = [];
        if (r.overflow) issues.push('OVERFLOW ' + r.overflow);
        r.names.forEach((x) => issues.push(x)); r.h.forEach((x) => issues.push('HEAD ' + x));
        r.touch.forEach((x) => issues.push('TOUCH ' + x)); r.contrast.forEach((x) => issues.push('CONTRAST ' + x));
        focus.forEach((x) => issues.push('FOCUS ' + x));
        const L = r.landmarks; if (L.main !== 1) issues.push('LM main=' + L.main); if (!L.banner) issues.push('LM banner missing'); if (!L.footer) issues.push('LM footer=' + L.footer); L.unlabelledNavs.forEach((x) => issues.push('LM unlabelled nav ' + x));
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

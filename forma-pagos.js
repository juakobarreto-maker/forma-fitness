/* FORMA 3.15 — Suscripción con Mercado Pago (lado web).
   La web NUNCA decide precio ni acceso: pide al servidor los planes a la venta (forma_planes_venta), la función Edge
   forma-pagos crea la suscripción y devuelve el link de pago, y el acceso lo da el servidor cuando Mercado Pago confirma.
   Si los pagos están apagados (por defecto), no se muestra ningún botón de pago: queda la lista de espera.
   Todo dato se pinta con textContent. */
(function (root) {
  'use strict';
  const ERR = {
    payments_off: 'Los pagos todavía no están habilitados. Anotate en la lista de espera y te avisamos.',
    not_on_sale: 'Este plan todavía no está a la venta.',
    already_subscribed: 'Ya tenés una suscripción activa. La ves en Perfil.',
    no_subscription: 'No encontramos una suscripción activa.',
    auth: 'Tu sesión venció. Volvé a iniciar sesión.',
    mp_failed: 'Mercado Pago no respondió. Probá de nuevo en unos minutos.'
  };
  const STATUS = { pending: 'Esperando el pago', authorized: 'Activa', paused: 'Pausada', review: 'En revisión' };
  const PLAN = { rutinas: 'Rutinas', asesoria: 'Asesoría', integral: 'Integral' };
  const errorText = code => ERR[code] || 'Algo salió mal. Probá de nuevo.';
  function price(p) {
    const n = Number(p && p.amount); if (!Number.isFinite(n) || n <= 0) return '';
    const s = n.toLocaleString('es-UY', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
    return (p.currency === 'USD' ? 'US$\u00a0' : '$\u00a0') + s;   // espacio que no corta línea
  }
  const safeLink = u => typeof u === 'string' && /^https:\/\/(www\.|sandbox\.)?mercadopago\.com(\.[a-z]{2})?\//.test(u);
  const fmtDate = v => { const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' }); };

  async function fnError(r) {   // supabase-js: el cuerpo del error viene en error.context (Response)
    try { const b = await r.error.context.json(); if (b && b.error) return b.error; } catch (e) { }
    return 'server';
  }
  let cache = null;
  async function planes(client) {
    if (cache && Date.now() - cache.t < 60000) return cache.v;
    const { data, error } = await client.rpc('forma_planes_venta');
    if (error) throw error;
    cache = { t: Date.now(), v: Array.isArray(data) ? data : [] }; return cache.v;
  }
  async function subscribe(client, plan) {
    const r = await client.functions.invoke('forma-pagos', { body: { action: 'crear', plan } });
    if (r.error) return { ok: false, msg: errorText(await fnError(r)) };
    if (!safeLink(r.data && r.data.init_point)) return { ok: false, msg: errorText('mp_failed') };
    return { ok: true, url: r.data.init_point };
  }
  async function cancel(client) {
    const r = await client.functions.invoke('forma-pagos', { body: { action: 'cancelar' } });
    if (r.error) return { ok: false, msg: errorText(await fnError(r)) };
    return { ok: true };
  }
  async function mine(client) {
    const { data, error } = await client.rpc('forma_mi_suscripcion');
    if (error) throw error;
    return data || null;
  }

  function h(doc, tag, props, ...kids) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : doc.createTextNode(String(kid)));
    return el;
  }

  /* Pantalla "Desbloquear FORMA": si Rutinas está a la venta, muestra precio real y botón; si no, no hace nada. */
  async function mountUpsell(box, ctx) {
    const doc = box.ownerDocument, cloud = ctx.cloud;
    if (!cloud || !cloud.client) return false;
    let list = [];
    try { list = await planes(cloud.client); } catch (e) { return false; }
    const p = list.find(x => x.plan === 'rutinas'); if (!p) return false;
    if (ctx.priceEl) ctx.priceEl.replaceChildren(price(p), h(doc, 'small', { style: 'display:block;font-size:13px;color:var(--muted);margin-top:4px', text: 'por mes · se renueva solo y lo cancelás cuando quieras' }));
    if (!cloud.user) {
      box.replaceChildren(h(doc, 'p', { class: 'muted', text: 'Para suscribirte necesitás una cuenta: así tu plan te sigue en cualquier dispositivo.' }),
        h(doc, 'a', { class: 'btn', href: 'auth.html', text: 'Crear cuenta o entrar' }));
      return true;
    }
    const msg = h(doc, 'p', { class: 'muted', role: 'status', 'aria-live': 'polite', style: 'min-height:1.4em;margin:10px 0 0' });
    const chk = h(doc, 'input', { type: 'checkbox', id: 'payTerms', style: 'width:22px;height:22px;flex:0 0 22px;margin:1px 0 0' });
    const label = 'Suscribirme · ' + price(p) + '\u00a0/\u00a0mes';
    const btn = h(doc, 'button', { class: 'btn', type: 'button', id: 'payBtn', text: label });
    btn.addEventListener('click', async () => {
      if (!chk.checked) { msg.textContent = 'Para seguir, aceptá los términos y la privacidad.'; chk.focus(); return; }
      btn.disabled = true; btn.textContent = 'Abriendo Mercado Pago…'; msg.textContent = '';
      const r = await subscribe(cloud.client, 'rutinas');
      if (r.ok) { (ctx.go || (u => { root.location.href = u; }))(r.url); return; }
      btn.disabled = false; btn.textContent = label; msg.textContent = r.msg;
    });
    box.replaceChildren(
      h(doc, 'label', { for: 'payTerms', style: 'display:flex;gap:10px;align-items:flex-start;text-align:left;font-size:13px;margin:0 auto 14px;max-width:420px' }, chk,
        h(doc, 'span', {}, 'Leí y acepto los ', h(doc, 'a', { href: 'terms.html', target: '_blank', rel: 'noopener', text: 'términos' }), ' y la ',
          h(doc, 'a', { href: 'privacy.html', target: '_blank', rel: 'noopener', text: 'privacidad' }), '. El cobro es mensual en Mercado Pago y lo cancelás cuando quieras desde Perfil.')),
      btn, msg,
      h(doc, 'p', { class: 'footnote', text: 'Pagás en la página de Mercado Pago: FORMA nunca ve ni guarda los datos de tu tarjeta.' }));
    return true;
  }

  /* Perfil: estado de la suscripción y botón para cancelar. */
  async function mountSettings(box, ctx) {
    const doc = box.ownerDocument, cloud = ctx.cloud;
    if (!cloud || !cloud.client || !cloud.user) return false;
    let s = null;
    try { s = await mine(cloud.client); } catch (e) { return false; }
    if (!s) return false;
    const msg = h(doc, 'p', { class: 'muted', role: 'status', 'aria-live': 'polite', style: 'min-height:1.4em' });
    const rows = [
      ['Plan', PLAN[s.plan] || s.plan], ['Estado', STATUS[s.status] || s.status], ['Precio', price(s) + ' / mes'],
      s.paid_until ? ['Acceso pago hasta', fmtDate(s.paid_until)] : null
    ].filter(Boolean);
    const card = h(doc, 'div', { class: 'card' }, h(doc, 'div', { class: 'eyebrow', text: 'MI SUSCRIPCIÓN' }),
      h(doc, 'dl', { style: 'display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:12px 0' }, rows.map(([k, v]) => [h(doc, 'dt', { class: 'muted', text: k }), h(doc, 'dd', { style: 'margin:0', text: v })])),
      msg);
    if (s.status === 'authorized' || s.status === 'pending' || s.status === 'paused') {
      const btn = h(doc, 'button', { class: 'btn secondary', type: 'button', text: 'Cancelar suscripción' });
      btn.addEventListener('click', async () => {
        if (!(ctx.confirm || root.confirm)('¿Cancelar la suscripción? No se te va a volver a cobrar. Lo que ya pagaste sigue activo hasta su fecha.')) return;
        btn.disabled = true; msg.textContent = 'Cancelando…';
        const r = await cancel(cloud.client);
        msg.textContent = r.ok ? 'Listo: la suscripción quedó cancelada. No se te va a volver a cobrar.' : r.msg;
        if (!r.ok) btn.disabled = false; else btn.remove();
      });
      card.append(btn);
    } else if (s.status === 'review') {
      card.append(h(doc, 'p', { class: 'muted', text: 'Estamos revisando un cobro con Mercado Pago. Si tenés dudas, escribinos.' }));
    }
    box.replaceChildren(card);
    return true;
  }

  /* Vuelta desde Mercado Pago (?pago=vuelta). Se guarda el History real ahora, porque app.html declara una función
     global history() (la pantalla Historial) que después tapa window.history. */
  const realHistory = root.history;
  function takeReturn() {
    const loc = root.location;
    if (!loc || !/[?&]pago=vuelta\b/.test(loc.search)) return false;
    try { realHistory.replaceState(null, '', loc.pathname + loc.hash); } catch (e) { }
    return true;
  }

  const api = { errorText, price, safeLink, planes, subscribe, cancel, mine, mountUpsell, mountSettings, takeReturn, _reset: () => { cache = null; } };
  root.FormaPagos = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* FORMA 3.14 — Panel de administración.
   Quién es administrador lo decide el servidor (tabla forma_admins + funciones forma_admin_*): esta página solo muestra
   lo que el servidor devuelve. Nada de lo que pase acá en el navegador concede permisos.
   Todo dato que viene de la base se pinta con textContent, nunca como HTML. */
(function (root) {
  'use strict';
  const PLANS = ['free', 'rutinas', 'asesoria', 'integral'];
  const PLAN_LABEL = { free: 'Gratis', rutinas: 'Rutinas', asesoria: 'Asesoría', integral: 'Integral' };
  const STATUS_LABEL = { active: 'Activo', canceled: 'Cancelado', past_due: 'Pago atrasado' };
  const WAIT_PLANS = ['rutinas', 'asesoria', 'integral'];
  const PAGE = 50;

  const ERRORS = [
    [/FORBIDDEN/, 'Tu cuenta no tiene permisos de administración.'],
    [/NOT_AUTHENTICATED|JWT|session/i, 'Tu sesión venció. Volvé a iniciar sesión.'],
    [/USER_NOT_FOUND/, 'Ese usuario ya no existe.'],
    [/INVALID_PLAN/, 'Plan no válido.'],
    [/INVALID_STATUS/, 'Estado no válido.'],
    [/INVALID_DATE/, 'La fecha de vencimiento tiene que ser futura.'],
    [/NOTE_TOO_LONG/, 'La nota no puede pasar de 200 caracteres.'],
    [/PGRST202|Could not find the function|does not exist/i, 'El panel todavía no está activado en la base: falta aplicar 15-panel-admin.sql.'],
    [/Failed to fetch|NetworkError|network/i, 'No hay conexión con el servidor. Probá de nuevo.']
  ];
  function errorText(e) {
    const msg = String((e && (e.message || e.details || e.hint || e.code)) || e || '');
    for (const [re, txt] of ERRORS) if (re.test(msg) || (e && re.test(String(e.code || '')))) return txt;
    return 'Algo salió mal. Probá de nuevo.';
  }

  const pad = n => String(n).padStart(2, '0');
  function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v); if (isNaN(d)) return '—';
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
  }
  function fmtDateTime(v) {
    if (!v) return '—';
    const d = new Date(v); if (isNaN(d)) return '—';
    return fmtDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

  /* CSV para Excel en español: separador ;, BOM UTF-8 y celdas que empiezan con = + - @ neutralizadas. */
  function csv(rows, cols) {
    const cell = v => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.map(c => cell(c.label)).join(';')];
    for (const r of rows) lines.push(cols.map(c => cell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(';'));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /* Valida el formulario de cambio de plan y arma los parámetros de forma_admin_set_plan. */
  function planChange(form, now) {
    now = now || new Date();
    const plan = String(form.plan || ''), status = String(form.status || 'active'), note = String(form.note || '').trim();
    if (!PLANS.includes(plan)) return { ok: false, error: 'Elegí un plan.' };
    if (!STATUS_LABEL[status]) return { ok: false, error: 'Elegí un estado.' };
    if (note.length > 200) return { ok: false, error: 'La nota no puede pasar de 200 caracteres.' };
    let until = null;
    if (form.until) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(form.until));
      if (!m) return { ok: false, error: 'Fecha no válida.' };
      const d = new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59);
      if (isNaN(d) || d.getMonth() !== +m[2] - 1) return { ok: false, error: 'Fecha no válida.' };
      if (d <= now) return { ok: false, error: 'La fecha de vencimiento tiene que ser futura.' };
      until = d.toISOString();
    }
    return { ok: true, params: { p_plan: plan, p_status: status, p_valid_until: until, p_note: note || null } };
  }

  /* ───────── Interfaz ───────── */
  function start(opts) {
    const doc = opts.document || root.document, client = opts.client;
    const $ = id => doc.getElementById(id);
    const h = (tag, props, ...kids) => {
      const el = doc.createElement(tag);
      for (const [k, v] of Object.entries(props || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
      }
      for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : doc.createTextNode(String(kid)));
      return el;
    };
    const S = { users: [], total: 0, offset: 0, search: '', waitlist: [], waitPlan: '', editing: null, me: null };
    const say = (txt, kind) => { const m = $('adminMsg'); m.textContent = txt || ''; m.className = 'msg' + (txt ? ' show ' + (kind || '') : ''); };
    async function rpc(name, args) {
      const { data, error } = await client.rpc(name, args || {});
      if (error) throw error;
      return data;
    }
    function gate(title, text, link) {
      $('gate').replaceChildren(h('h1', { text: title }), h('p', { text }),
        link ? h('a', { class: 'btn', href: link.href, text: link.text }) : null);
      $('gate').hidden = false; $('panel').hidden = true;
    }

    /* Pestañas accesibles: flechas, Inicio y Fin. */
    const tabs = ['resumen', 'usuarios', 'espera', 'registro'];
    function showTab(name, focus) {
      for (const t of tabs) {
        const b = $('tab-' + t), p = $('sec-' + t), on = t === name;
        b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; b.classList.toggle('active', on); p.hidden = !on;
      }
      if (focus) $('tab-' + name).focus();
      loaders[name] && loaders[name]();
    }
    function wireTabs() {
      for (const t of tabs) $('tab-' + t).addEventListener('click', () => showTab(t));
      $('tablist').addEventListener('keydown', e => {
        const i = tabs.findIndex(t => $('tab-' + t).getAttribute('aria-selected') === 'true');
        const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (j === undefined) return;
        e.preventDefault(); showTab(tabs[(j + tabs.length) % tabs.length], true);
      });
    }

    /* Resumen */
    async function loadOverview() {
      const box = $('kpis'); box.setAttribute('aria-busy', 'true');
      try {
        const o = await rpc('forma_admin_overview');
        const plans = o.plans || {}, wl = o.waitlist || {};
        const pago = num(plans.rutinas) + num(plans.asesoria) + num(plans.integral);
        const k = (label, value, sub) => h('div', { class: 'kpi' }, h('span', { class: 'kl', text: label }), h('strong', { text: String(value) }), sub ? h('span', { class: 'ks', text: sub }) : null);
        box.replaceChildren(
          k('Cuentas', num(o.users_total), num(o.users_new_7d) + ' nuevas en 7 días'),
          k('Entrenaron (7 días)', num(o.active_7d), num(o.active_30d) + ' en 30 días · ' + num(o.with_data) + ' con datos'),
          k('Con plan activo', pago, WAIT_PLANS.map(p => PLAN_LABEL[p] + ' ' + num(plans[p])).join(' · ')),
          k('Vencen en 7 días', num(o.expiring_7d), 'planes activos con fecha'),
          k('Lista de espera', WAIT_PLANS.reduce((n, p) => n + num(wl[p]), 0), WAIT_PLANS.map(p => PLAN_LABEL[p] + ' ' + num(wl[p])).join(' · ')),
          k('Rutinas con IA', num(o.ai_today) + ' hoy', num(o.ai_7d) + ' en 7 días'));
        $('kpiTime').textContent = 'Actualizado ' + fmtDateTime(o.generated_at) + '. Los planes son de prueba: todavía no se cobra.';
      } catch (e) { say(errorText(e), 'error'); }
      finally { box.removeAttribute('aria-busy'); }
    }

    /* Usuarios */
    function planBadge(u) {
      const txt = (PLAN_LABEL[u.plan] || u.plan) + (u.status !== 'active' ? ' · ' + (STATUS_LABEL[u.status] || u.status) : '');
      return h('span', { class: 'badge' + (u.pro ? ' pro' : '') }, txt, u.valid_until ? h('small', { text: ' hasta ' + fmtDate(u.valid_until) }) : null);
    }
    async function loadUsers() {
      const body = $('usersBody'); $('usersTable').setAttribute('aria-busy', 'true');
      try {
        const r = await rpc('forma_admin_users', { p_search: S.search, p_limit: PAGE, p_offset: S.offset });
        S.users = Array.isArray(r.rows) ? r.rows : []; S.total = num(r.total);
        body.replaceChildren(...(S.users.length ? S.users.map((u, i) => h('tr', {},
          h('td', { 'data-l': 'Correo' }, h('span', { class: 'email', text: u.email || '—' }), u.is_admin ? h('span', { class: 'tag', text: 'admin' }) : null),
          h('td', { 'data-l': 'Alta', text: fmtDate(u.created_at) }),
          h('td', { 'data-l': 'Último guardado', text: fmtDate(u.last_save) }),
          h('td', { 'data-l': 'Sesiones', class: 'n', text: String(num(u.sessions)) }),
          h('td', { 'data-l': 'IA 7 días', class: 'n', text: String(num(u.ai_7d)) }),
          h('td', { 'data-l': 'Plan' }, planBadge(u)),
          h('td', {}, h('button', { class: 'btn small secondary', type: 'button', 'data-uid': u.id, 'aria-label': 'Cambiar plan de ' + (u.email || 'usuario'), onclick: () => openPlan(i), text: 'Cambiar plan' }))
        )) : [h('tr', {}, h('td', { colspan: '7', class: 'empty', text: S.search ? 'Ningún correo coincide con la búsqueda.' : 'Todavía no hay cuentas.' }))]));
        const from = S.total ? S.offset + 1 : 0, to = Math.min(S.offset + PAGE, S.total);
        $('usersCount').textContent = from + '–' + to + ' de ' + S.total;
        $('prevPage').disabled = S.offset === 0; $('nextPage').disabled = S.offset + PAGE >= S.total;
      } catch (e) { say(errorText(e), 'error'); }
      finally { $('usersTable').removeAttribute('aria-busy'); }
    }
    let lastFocus = null;
    function openPlan(i) {
      const u = S.users[i]; if (!u) return;
      S.editing = u; lastFocus = doc.activeElement;
      $('dlgEmail').textContent = u.email || '';
      $('fPlan').value = u.plan || 'free'; $('fStatus').value = u.status || 'active';
      $('fUntil').value = u.valid_until ? (d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()))(new Date(u.valid_until)) : '';
      $('fNote').value = ''; $('dlgErr').textContent = '';
      const d = $('planDialog'); if (d.showModal) d.showModal(); else d.setAttribute('open', '');
      $('fPlan').focus();
    }
    function closePlan() {
      const d = $('planDialog'); if (d.close) d.close(); else d.removeAttribute('open');
      S.editing = null; if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    async function savePlan(e) {
      e.preventDefault();
      const u = S.editing; if (!u) return;
      const v = planChange({ plan: $('fPlan').value, status: $('fStatus').value, until: $('fUntil').value, note: $('fNote').value });
      if (!v.ok) { $('dlgErr').textContent = v.error; return; }
      const btn = $('dlgSave'); btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        await rpc('forma_admin_set_plan', Object.assign({ p_user: u.id }, v.params));
        closePlan();
        say('Plan de ' + u.email + ' actualizado a ' + PLAN_LABEL[v.params.p_plan] + '.', 'ok');
        await loadUsers();
        const again = [...doc.querySelectorAll('#usersBody button[data-uid]')].find(b => b.getAttribute('data-uid') === String(u.id));
        if (again) again.focus();
      } catch (err) { $('dlgErr').textContent = errorText(err); }
      finally { btn.disabled = false; btn.textContent = 'Guardar cambio'; }
    }

    /* Lista de espera */
    async function loadWaitlist() {
      const body = $('waitBody'); $('waitTable').setAttribute('aria-busy', 'true');
      try {
        const rows = await rpc('forma_admin_waitlist', { p_plan: S.waitPlan || null, p_limit: 2000 });
        S.waitlist = Array.isArray(rows) ? rows : [];
        body.replaceChildren(...(S.waitlist.length ? S.waitlist.map(w => h('tr', {},
          h('td', { 'data-l': 'Correo' }, h('span', { class: 'email', text: w.email || '' })),
          h('td', { 'data-l': 'Plan', text: PLAN_LABEL[w.plan] || w.plan || '' }),
          h('td', { 'data-l': 'Objetivo', text: w.goal || '—' }),
          h('td', { 'data-l': 'Fecha', text: fmtDate(w.created_at) }))) : [h('tr', {}, h('td', { colspan: '4', class: 'empty', text: 'Nadie anotado todavía.' }))]));
        $('waitCount').textContent = S.waitlist.length + (S.waitlist.length === 1 ? ' persona' : ' personas');
        $('waitCsv').disabled = !S.waitlist.length;
      } catch (e) { say(errorText(e), 'error'); }
      finally { $('waitTable').removeAttribute('aria-busy'); }
    }
    function downloadCsv() {
      const text = csv(S.waitlist, [{ label: 'correo', key: 'email' }, { label: 'plan', get: r => PLAN_LABEL[r.plan] || r.plan },
        { label: 'objetivo', key: 'goal' }, { label: 'fecha', get: r => fmtDate(r.created_at) }]);
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
      const a = h('a', { href: url, download: 'forma-lista-espera' + (S.waitPlan ? '-' + S.waitPlan : '') + '.csv' });
      doc.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      say('Descargado. Tratá estos correos como datos personales: solo para avisar del lanzamiento.', 'ok');
    }

    /* Registro */
    async function loadAudit() {
      const body = $('auditBody');
      try {
        const rows = await rpc('forma_admin_audit', { p_limit: 100 });
        const list = Array.isArray(rows) ? rows : [];
        const desc = r => {
          const d = r.detail || {}, b = d.before || {}, a = d.after || {};
          if (r.action !== 'set_plan') return r.action;
          const p = x => x && x.plan ? (PLAN_LABEL[x.plan] || x.plan) + (x.status && x.status !== 'active' ? ' (' + (STATUS_LABEL[x.status] || x.status) + ')' : '') + (x.valid_until ? ' hasta ' + fmtDate(x.valid_until) : '') : 'sin plan';
          return p(b) + ' → ' + p(a) + (d.note ? ' · ' + d.note : '');
        };
        body.replaceChildren(...(list.length ? list.map(r => h('tr', {},
          h('td', { 'data-l': 'Fecha', text: fmtDateTime(r.at) }),
          h('td', { 'data-l': 'Usuario' }, h('span', { class: 'email', text: r.target_email || '—' })),
          h('td', { 'data-l': 'Cambio', text: desc(r) }),
          h('td', { 'data-l': 'Hecho por' }, h('span', { class: 'email', text: r.admin_email || '—' })))) : [h('tr', {}, h('td', { colspan: '4', class: 'empty', text: 'Todavía no hay cambios registrados.' }))]));
      } catch (e) { say(errorText(e), 'error'); }
    }
    const loaders = { resumen: loadOverview, usuarios: loadUsers, espera: loadWaitlist, registro: loadAudit };

    function wire() {
      wireTabs();
      $('refresh').addEventListener('click', () => { say(''); const t = tabs.find(x => $('tab-' + x).getAttribute('aria-selected') === 'true'); loaders[t](); });
      $('searchForm').addEventListener('submit', e => { e.preventDefault(); S.search = $('search').value.trim().slice(0, 100); S.offset = 0; loadUsers(); });
      $('prevPage').addEventListener('click', () => { S.offset = Math.max(0, S.offset - PAGE); loadUsers(); });
      $('nextPage').addEventListener('click', () => { S.offset += PAGE; loadUsers(); });
      $('planForm').addEventListener('submit', savePlan);
      $('dlgCancel').addEventListener('click', closePlan);
      $('planDialog').addEventListener('cancel', e => { e.preventDefault(); closePlan(); });
      $('waitPlan').addEventListener('change', () => { S.waitPlan = $('waitPlan').value; loadWaitlist(); });
      $('waitCsv').addEventListener('click', downloadCsv);
      $('logout').addEventListener('click', async () => { try { await client.auth.signOut(); } catch (e) {} root.location.href = 'auth.html'; });
    }

    async function boot() {
      if (!client) return gate('Panel no disponible', 'Falta la configuración de Supabase en este sitio.', null);
      let session = null;
      try { session = (await client.auth.getSession()).data.session; } catch (e) { }
      if (!session) return gate('Iniciá sesión', 'Entrá con tu cuenta de administrador para ver el panel.', { href: 'auth.html', text: 'Ir a iniciar sesión' });
      let ok = false;
      try { ok = (await rpc('forma_admin_me')) === true; }
      catch (e) { return gate('Panel no disponible', errorText(e), { href: 'app.html', text: 'Volver a la app' }); }
      if (!ok) return gate('Sin acceso', 'Tu cuenta no tiene permisos de administración.', { href: 'app.html', text: 'Volver a la app' });
      S.me = session.user && session.user.email;
      $('meEmail').textContent = S.me || '';
      $('gate').hidden = true; $('panel').hidden = false;
      wire(); showTab('resumen');
    }
    return { boot, state: S, loaders, showTab, openPlan };
  }

  const api = { PLANS, PLAN_LABEL, STATUS_LABEL, errorText, fmtDate, fmtDateTime, csv, planChange, start };
  root.FormaAdmin = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

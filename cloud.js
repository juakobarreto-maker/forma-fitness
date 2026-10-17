/* FORMA 3.7.1 — Sincronización Supabase para la versión de prueba.
   El estado de cada usuario se guarda como un documento JSON con revisión atómica.
   Nunca agregues una secret key o service_role al navegador.

   Claves de localStorage (por usuario):
   - forma_cloud_cache_<id>     copia del estado (compatibilidad).
   - forma_cloud_meta_<id>      {version}: última revisión del servidor que conocemos.
   - forma_cloud_pending_<id>   {v:2, baseVersion, state}: cambios sin confirmar y la revisión sobre la que se hicieron.
   - forma_cloud_conflict_<id>  copia local en conflicto; NUNCA la pisa un dato de la nube.
   - forma_cloud_archive_<id>   última copia local descartada a pedido del usuario. */
(function () {
  'use strict';
  const cfg = window.FORMA_CONFIG || {};
  const FS = window.FormaState;
  const banner = document.getElementById('cloudBanner');
  const accountLink = document.getElementById('accountLink');
  const gate = document.getElementById('cloudGate');
  const configured = Boolean(cfg.supabaseUrl && cfg.supabasePublishableKey && window.supabase?.createClient && FS);
  const clone = v => JSON.parse(JSON.stringify(v));
  const rd = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const rm = k => { try { localStorage.removeItem(k); return true; } catch (e) { return false; } };
  const okState = s => { const r = FS.check(s, { strict: false }); return r.ok ? r.value : null; };
  const baseOf = p => (p && FS.parseRevision(p.baseVersion !== undefined ? p.baseVersion : p.version));
  const CONFLICT_RE = /VERSION_CONFLICT|STATE_CONFLICT/i;
  const BTN_EXPORT_MINE = '<button class="btn small secondary" onclick="exportData()">↓ Exportar mi copia</button>';
  const BTN_EXPORT_PENDING = '<button class="btn small secondary" onclick="window.formaCloud.exportPending()">↓ Exportar copia en conflicto</button>';
  const BTN_USE_CLOUD = '<button class="btn small secondary" onclick="window.formaCloud.discardAndReload()">Usar versión de la nube</button>';

  const C = {
    client: null, user: null, ready: false, cacheKey: null, dirtyKey: null, metaKey: null, conflictKey: null, archiveKey: null,
    version: 0,            // última revisión confirmada del servidor (null = desconocida)
    verified: false,       // ¿la revisión coincide con el servidor en esta sesión?
    pending: null, inflight: null, seq: 0, acked: 0,
    timer: 0, sending: null,
    conflict: false, conflictOwnsData: false, conflictBase: null, conflictServer: null,
    blocked: false, suspended: false,

    setMessage(message, type = 'normal', actions = '') {
      if (!banner) return;
      banner.className = 'cloud-message' + (type === 'warning' ? ' warning' : type === 'error' ? ' error' : '');
      // message y actions son texto fijo de la app; los datos dinámicos nunca se interpolan acá.
      banner.innerHTML = '<span>' + message + '</span>' + actions;
    },
    showWarning(message) { this.setMessage(message, 'warning'); },
    updateUI() {
      if (accountLink) {
        accountLink.textContent = this.user ? '◉ Mi cuenta' : '♙ Entrar / crear cuenta';
        accountLink.href = 'auth.html';
      }
      const node = document.getElementById('accountDetail');
      if (node) node.textContent = this.user
        ? 'Conectada: ' + (this.user.email || 'Cuenta FORMA') + '. Sesiones PRO: modo tester, sin pagos.'
        : 'Sin sesión de usuario: los datos quedan en este navegador.';
    },
    busy(v) { if (gate) gate.classList.toggle('hide', !v); },
    cache(snapshot) {
      if (!this.cacheKey) return false;
      if (wr(this.cacheKey, snapshot)) return true;
      this.showWarning('El navegador bloquea el respaldo local. Exportá tus registros desde Perfil.');
      return false;
    },
    writeMeta() { if (this.metaKey && this.version !== null) wr(this.metaKey, { version: this.version, at: new Date().toISOString() }); },
    writeDirty() {
      const rec = { v: 2, baseVersion: this.version, state: this.pending, savedAt: new Date().toISOString() };
      // Si hay un envío en curso, guardamos su huella: si la página se cierra justo cuando el servidor lo aplicó, se reconoce al volver.
      if (this.inflight) { const s = okState(this.inflight.state); if (s) rec.sent = { hash: FS.hash(s), expected: this.inflight.expected }; }
      return wr(this.dirtyKey, rec);
    },

    /* La app NO debe aceptar ediciones cuando no hay forma segura de conservarlas. */
    blocksEdits() { return !!this.user && (!this.ready || this.blocked || (this.conflict && !this.conflictOwnsData)); },
    blockMessage() {
      if (this.blocked) return 'No se pudieron leer tus datos de la nube con seguridad: la edición está bloqueada para no sobrescribirlos.';
      if (this.conflict && !this.conflictOwnsData) return 'Hay un conflicto de sincronización sin resolver: la edición está bloqueada. Exportá tu copia o elegí qué versión conservar.';
      return 'Esperá a que finalice la carga de la nube.';
    },
    hasUnsynced() { return !!this.pending || this.acked < this.seq || this.conflict || !!rd(this.dirtyKey) || !!rd(this.conflictKey); },

    /* Registra un cambio. Devuelve true si quedó encolado para enviarse. Nunca depende de que localStorage funcione. */
    queue(snapshot) {
      if (!this.user || !this.ready || this.blocked || this.suspended) return false;
      const snap = clone(snapshot);
      this.seq++;
      if (this.conflict) {
        // Mientras el conflicto sigue abierto no se envía nada. Si la app muestra la copia local, se conserva en el archivo de conflicto.
        if (this.conflictOwnsData) {
          const saved = wr(this.conflictKey, { v: 2, baseVersion: this.conflictBase, serverVersion: this.conflictServer, state: snap, at: new Date().toISOString() });
          if (!saved) this.setMessage('⚠ Conflicto de sincronización y <b>no se pudo guardar la copia local</b> (almacenamiento lleno o bloqueado). Exportá tu copia ahora.', 'error', '<div class="stack">' + BTN_EXPORT_MINE + BTN_USE_CLOUD + '</div>');
        }
        return false;
      }
      this.pending = snap;
      const cached = this.cache(snap), dirty = this.writeDirty();
      if (cached && dirty) this.setMessage('◷ <b>Cambios pendientes.</b> Guardado local realizado; sincronizando con tu cuenta…');
      else this.setMessage('◷ <b>Cambios pendientes.</b> No se pudo guardar la copia local (almacenamiento lleno o bloqueado); los cambios siguen en memoria y se están enviando. No cierres esta pestaña hasta ver «Sincronizado».', 'warning', '<div class="stack"><button class="btn small secondary" onclick="exportData()">↓ Exportar respaldo</button></div>');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 800);
      return true;
    },

    /* true SOLO si todos los cambios encolados hasta ahora fueron confirmados por el servidor. */
    async flush() {
      if (!this.user || !this.ready || this.conflict || this.blocked || this.suspended) return false;
      clearTimeout(this.timer);
      if (this.sending) { try { await this.sending; } catch (e) { /* lo informa _send */ } }
      if (this.conflict || this.suspended) return false;
      if (!this.pending) return this.acked >= this.seq;
      if (this.sending) return this.sending;
      const run = this._send();
      this.sending = run;
      try { return await run; } finally { if (this.sending === run) this.sending = null; }
    },
    async _send() {
      while (this.pending && !this.conflict && !this.suspended) {
        if (!this.verified) {
          if (!(await this.reconcile())) return false;
          continue; // reconcile pudo haber confirmado o cambiado el pendiente
        }
        const snapshot = this.pending, mySeq = this.seq, expected = this.version;
        this.pending = null;
        this.inflight = { state: snapshot, expected, seq: mySeq };
        try {
          const res = await this.client.rpc('forma_save_state', { p_payload: snapshot, p_expected_version: expected });
          if (res.error) throw res.error;
          const nv = FS.parseRevision(res.data);
          if (nv === null || nv <= expected) { const e = new Error('El servidor devolvió una revisión inválida'); e.invalidRevision = true; throw e; }
          this.version = nv; this.acked = mySeq; this.inflight = null; this.verified = true; this.writeMeta();
          if (this.pending) this.writeDirty();
          else { rm(this.dirtyKey); this.setMessage('● <b>Sincronizado en la nube.</b> Tus datos están vinculados a tu cuenta FORMA.'); }
        } catch (err) {
          if (!this.pending) this.pending = snapshot; // las ediciones más nuevas, si existen, ya incluyen a las anteriores
          if (CONFLICT_RE.test(String(err && err.message || ''))) {
            this.inflight = null;
            this.enterConflict(this.pending, null);
          } else {
            // No sabemos si el servidor aplicó el cambio (respuesta perdida / inválida): antes de reintentar se reconcilia.
            this.verified = false;
            this.setMessage('⚠ <b>Sin conexión o error de guardado.</b> Tus cambios están pendientes en este dispositivo. No cierres sin exportar un respaldo.', 'warning', '<div class="stack"><button class="btn small secondary" onclick="window.formaCloud.flush()">↻ Reintentar</button><button class="btn small secondary" onclick="exportData()">↓ Exportar respaldo</button></div>');
          }
          return false;
        }
      }
      return !this.conflict && !this.pending && this.acked >= this.seq;
    },

    /* Lee la revisión real del servidor antes de enviar tras un fallo o una recuperación offline. */
    async reconcile() {
      try {
        const r = await this.client.from('forma_user_state').select('state,version').eq('user_id', this.user.id).maybeSingle();
        if (r.error) throw r.error;
        const row = r.data;
        const sv = row ? FS.parseRevision(row.version) : 0;
        if (sv === null) throw new Error('El servidor devolvió una revisión inválida');
        if (this.version === null && !row) this.version = 0;
        if (sv === this.version) { this.verified = true; this.writeMeta(); return true; }
        const inf = this.inflight;
        if (inf && row && sv > inf.expected && okState(row.state) && okState(inf.state) && FS.sameState(okState(row.state), okState(inf.state))) {
          // La respuesta se perdió pero el servidor sí aplicó ese envío: confirmarlo sin reenviar.
          this.version = sv; this.acked = Math.max(this.acked, inf.seq); this.verified = true; this.inflight = null;
          if (this.pending && FS.sameState(this.pending, inf.state)) this.pending = null;
          this.writeMeta();
          if (this.pending) this.writeDirty();
          else { rm(this.dirtyKey); this.setMessage('● <b>Sincronizado en la nube.</b> Tus datos están vinculados a tu cuenta FORMA.'); }
          return true;
        }
        this.enterConflict(this.pending, sv);
        return false;
      } catch (e) {
        this.setMessage('⚠ <b>Sin conexión o error de guardado.</b> Tus cambios están pendientes en este dispositivo. No cierres sin exportar un respaldo.', 'warning', '<div class="stack"><button class="btn small secondary" onclick="window.formaCloud.flush()">↻ Reintentar</button><button class="btn small secondary" onclick="exportData()">↓ Exportar respaldo</button></div>');
        return false;
      }
    },

    enterConflict(state, serverVersion) {
      this.conflict = true; this.conflictOwnsData = true; this.conflictBase = this.version; this.conflictServer = serverVersion;
      this.pending = null; clearTimeout(this.timer);
      const saved = state ? wr(this.conflictKey, { v: 2, baseVersion: this.version, serverVersion, state, at: new Date().toISOString() }) : true;
      if (saved) rm(this.dirtyKey); // los pendientes ahora viven en la copia de conflicto
      this.setMessage('⚠ Hay cambios más recientes en otro dispositivo. No los sobreescribimos' + (saved ? ' y tu copia local se conserva aparte' : ', pero <b>no se pudo guardar tu copia local</b>: exportala ahora') + '. Exportá tus registros y luego elegí qué versión usar.', 'error', '<div class="stack">' + BTN_EXPORT_MINE + BTN_USE_CLOUD + '</div>');
    },

    /* Descarta la copia local en conflicto: la archiva (una copia) y recarga desde la nube. */
    async discardAndReload() {
      if (!confirm('¿Descartar los cambios de ESTE dispositivo y abrir la versión guardada en la nube? Exportá un respaldo primero. Se guardará una copia de archivo en este navegador por si la necesitás.')) return;
      const rec = rd(this.conflictKey) || rd(this.dirtyKey);
      const state = rec && rec.state ? rec.state : (typeof data !== 'undefined' ? data : null);
      if (state && !wr(this.archiveKey, { at: new Date().toISOString(), reason: 'descartada por el usuario', state })) {
        if (!confirm('No se pudo guardar la copia de archivo (almacenamiento lleno o bloqueado). ¿Descartar igualmente? Esto no se puede deshacer.')) return;
      }
      this.suspended = true; clearTimeout(this.timer);
      rm(this.conflictKey); rm(this.dirtyKey);
      location.reload();
    },
    /* "Limpiar este navegador": borra las copias locales de la cuenta sin tocar la nube ni el archivo de conflicto. */
    dropLocalState() {
      this.suspended = true; clearTimeout(this.timer); this.pending = null;
      rm(this.cacheKey); rm(this.dirtyKey); rm(this.metaKey);
    },

    async initialize() {
      if (!configured) {
        this.setMessage('● <b>Modo local.</b> Para activar cuentas y sincronización, seguí el README y completá config.js con la URL y la clave publicable de tu proyecto Supabase.', 'warning');
        this.updateUI();
        return;
      }
      this.busy(true);
      try {
        this.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
        // Si la sesión cambia en otra pestaña, recargamos para no mostrar datos de la cuenta anterior.
        this.client.auth.onAuthStateChange((event, session) => {
          if (event === 'SIGNED_OUT' && this.user) setTimeout(() => location.reload(), 80);
          if (event === 'SIGNED_IN' && this.ready && session?.user?.id !== this.user?.id) setTimeout(() => location.reload(), 80);
        });
        const { data: sessionData, error: sessionError } = await this.client.auth.getSession();
        if (sessionError) throw sessionError;
        const session = sessionData?.session;
        if (!session?.user) {
          this.setMessage('● <b>Estás en modo invitado.</b> Tus registros permanecen en este navegador. <a href="auth.html" style="color:#efd5a1;text-decoration:underline">Creá una cuenta o iniciá sesión</a> para sincronizarlos.', 'warning');
          this.updateUI();
          return;
        }
        this.user = session.user;
        const id = session.user.id;
        this.cacheKey = 'forma_cloud_cache_' + id; this.metaKey = 'forma_cloud_meta_' + id; this.dirtyKey = 'forma_cloud_pending_' + id;
        this.conflictKey = 'forma_cloud_conflict_' + id; this.archiveKey = 'forma_cloud_archive_' + id;
        let row = null, readError = null;
        try {
          const r = await this.client.from('forma_user_state').select('state,version').eq('user_id', id).maybeSingle();
          if (r.error) throw r.error;
          row = r.data;
        } catch (e) { readError = e; }
        if (readError) { this.loadOffline(readError); return; }
        this.loadOnline(row);
      } catch (err) {
        console.error('[FORMA] No pudo iniciar sincronización:', err);
        if (this.user) this.loadOffline(err);
        else this.showWarning('No se pudo verificar Supabase: ' + safeError(err) + '. La demostración permanece en modo local.');
      } finally { this.busy(false); this.updateUI(); }
    },

    loadOnline(row) {
      const sv = row ? FS.parseRevision(row.version) : 0;
      const cloudOk = row ? okState(row.state) : null;
      if (sv === null || (row && !cloudOk && !rd(this.dirtyKey) && !rd(this.conflictKey))) {
        data = fresh(); this.ready = false; this.blocked = true;
        this.setMessage('⚠ No se pudo leer con seguridad el estado guardado en la nube (formato o revisión inválidos). <b>La edición está bloqueada</b> para no sobrescribirlo. Contactá a soporte antes de continuar.', 'error');
        render(); return;
      }
      this.version = sv; this.verified = true;
      const conflictRec = rd(this.conflictKey), pend = rd(this.dirtyKey);
      const showCloud = () => { data = cloudOk || fresh(); };
      const conflictUI = () => this.setMessage('⚠ Este navegador tiene cambios sin subir y la nube fue actualizada en otro lugar. No los mezclamos y <b>tu copia local se conserva aparte</b>. La edición está bloqueada hasta que elijas qué versión usar.', 'error', '<div class="stack">' + BTN_EXPORT_PENDING + BTN_USE_CLOUD + '</div>');
      if (conflictRec && conflictRec.state) {
        this.conflict = true; this.conflictOwnsData = false; this.conflictBase = baseOf(conflictRec); this.conflictServer = sv;
        showCloud(); conflictUI();
      } else if (pend && pend.state) {
        const pstate = okState(pend.state);
        let base = baseOf(pend);
        // El envío en curso al cerrar la página sí llegó al servidor: la base efectiva de lo pendiente es la revisión actual.
        if (pstate && cloudOk && pend.sent && base === pend.sent.expected && sv > base && FS.hash(cloudOk) === pend.sent.hash) base = sv;
        if (pstate && base === sv) {
          // Mismo punto de partida que la nube: recuperamos lo pendiente y lo reenviamos.
          data = pstate; this.ready = true; this.queue(data);
        } else if (pstate && cloudOk && FS.sameState(cloudOk, pstate)) {
          rm(this.dirtyKey); showCloud(); // el envío anterior sí llegó al servidor
          this.setMessage('● <b>Sincronizado en la nube.</b> Recuperamos tus rutinas y entrenamientos.');
        } else {
          const saved = wr(this.conflictKey, { v: 2, baseVersion: base, serverVersion: sv, state: pend.state, at: new Date().toISOString() });
          if (saved) rm(this.dirtyKey);
          this.conflict = true; this.conflictOwnsData = false; this.conflictBase = base; this.conflictServer = sv;
          showCloud(); conflictUI();
        }
      } else {
        showCloud();
        if (!row) this.setMessage('● <b>Cuenta nueva.</b> Todavía no hay entrenamientos en la nube. Si usabas FORMA antes, importá el respaldo JSON desde Perfil; así evitás perder tus registros previos.');
        else this.setMessage('● <b>Sincronizado en la nube.</b> Recuperamos tus rutinas y entrenamientos.');
      }
      this.ready = true;
      this.cache(data);
      this.writeMeta();
      render();
    },

    /* Sin conexión al iniciar: se recuperan estado, revisión y pendientes juntos; no se envía nada hasta reconciliar. */
    loadOffline(err) {
      console.error('[FORMA] No se pudo leer la nube:', err);
      const pend = rd(this.dirtyKey), pstate = pend && okState(pend.state), cached = okState(rd(this.cacheKey)), meta = rd(this.metaKey);
      this.verified = false;
      if (rd(this.conflictKey)) {
        this.conflict = true; this.conflictOwnsData = false; data = cached || fresh(); this.ready = true;
        this.setMessage('⚠ Hay una copia local en conflicto pendiente de resolver y no hay conexión. La edición está bloqueada. Exportá la copia en conflicto.', 'error', '<div class="stack">' + BTN_EXPORT_PENDING + '</div>');
      } else if (pstate) {
        data = pstate; this.version = baseOf(pend); this.ready = true; this.queue(data);
        this.showWarning('⚠ No pudimos contactar Supabase. Se recuperaron tus cambios pendientes y se enviarán al volver la conexión, tras comprobar que la nube no cambió.');
      } else if (cached) {
        data = cached; this.version = meta ? FS.parseRevision(meta.version) : null; this.ready = true;
        this.showWarning('⚠ No pudimos contactar Supabase. Se cargó la copia local de esta cuenta. Los cambios quedarán pendientes hasta recuperar la conexión.');
      } else {
        data = fresh(); this.ready = false;
        this.setMessage('No se pudo cargar tu cuenta. Intentá actualizar la página. La edición está bloqueada hasta recuperar la conexión.', 'error');
      }
      render();
    },

    exportPending() {
      try {
        const p = rd(this.conflictKey) || rd(this.dirtyKey);
        const st = p && okState(p.state);
        if (!st) { alert('No se encontró una copia pendiente'); return; }
        const blob = new Blob([JSON.stringify(st, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'forma-cambios-pendientes.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } catch (e) { alert('No se pudo exportar el respaldo local'); }
    }
  };
  function safeError(e) { return String(e?.message || 'error desconocido').slice(0, 130).replace(/[<>]/g, ''); }
  window.formaCloud = C;
  const canSync = () => C.user && C.ready && !C.conflict && !C.blocked && !C.suspended;
  window.addEventListener('online', () => { if (canSync()) C.flush(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && canSync()) C.flush(); });
  C.initialize();
})();

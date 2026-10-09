/* FORMA 3.3 — Sincronización Supabase para la versión de prueba.
   El estado de cada usuario se guarda como un documento JSON con revisión atómica.
   Nunca agregues una secret key o service_role al navegador. */
(function () {
  'use strict';
  const cfg = window.FORMA_CONFIG || {};
  const banner = document.getElementById('cloudBanner');
  const accountLink = document.getElementById('accountLink');
  const gate = document.getElementById('cloudGate');
  const label = document.getElementById('accountDetail');
  const configured = Boolean(cfg.supabaseUrl && cfg.supabasePublishableKey && window.supabase?.createClient);
  const C = {
    client: null, user: null, ready: false, cacheKey: null, version: 0,
    pending: null, timer: 0, sending: null, conflict: false,
    setMessage(message, type = 'normal', actions = '') {
      if (!banner) return;
      banner.className = 'cloud-message' + (type === 'warning' ? ' warning' : type === 'error' ? ' error' : '');
      // message is only from fixed app text; dynamic email is placed with textContent elsewhere.
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
      if (!this.cacheKey) return;
      try { localStorage.setItem(this.cacheKey, JSON.stringify(snapshot)); }
      catch (e) { this.showWarning('El navegador bloquea el respaldo local. Exportá tus registros desde Perfil.'); }
    },
    queue(snapshot) {
      if (!this.user || !this.ready || this.conflict) return;
      this.pending = JSON.parse(JSON.stringify(snapshot));
      this.cache(this.pending);
      try {
        localStorage.setItem(this.dirtyKey, JSON.stringify({version: this.version, state: this.pending}));
      } catch (e) { /* Aún puede guardarse en la nube */ }
      this.setMessage('◷ <b>Cambios pendientes.</b> Guardado local realizado; sincronizando con tu cuenta…');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 800);
    },
    async flush() {
      if (!this.user || !this.ready || this.conflict) return false;
      clearTimeout(this.timer);
      if (this.sending) {
        await this.sending;
        if (!this.pending) return !this.conflict;
      }
      if (!this.pending) return true;
      this.sending = (async () => {
        while (this.pending && !this.conflict) {
          const snapshot = this.pending;
          this.pending = null;
          try {
            const {data: newVersion, error} = await this.client.rpc('forma_save_state', {
              p_payload: snapshot, p_expected_version: this.version
            });
            if (error) throw error;
            if (!Number.isSafeInteger(Number(newVersion))) throw Error('El servidor devolvió una revisión inválida');
            this.version = Number(newVersion);
            if (this.pending) {
              try {localStorage.setItem(this.dirtyKey,JSON.stringify({version:this.version,state:this.pending}));} catch(e){}
            } else {
              // Sólo quitamos el pendiente cuando se confirmó en el servidor.
              try {localStorage.removeItem(this.dirtyKey);} catch(e){}
              this.setMessage('● <b>Sincronizado en la nube.</b> Tus datos están vinculados a tu cuenta FORMA.');
            }
          } catch (err) {
            if (!this.pending) this.pending = snapshot;
            if (/VERSION_CONFLICT|STATE_CONFLICT/i.test(err.message || '')) {
              this.conflict = true;
              this.setMessage('⚠ Hay cambios más recientes en otro dispositivo. No los sobreescribimos. Exportá tus registros locales y recargá desde la nube.', 'error', '<div class="stack"><button class="btn small secondary" onclick="exportData()">↓ Exportar mi copia</button><button class="btn small secondary" onclick="window.formaCloud.discardAndReload()">Recuperar versión en nube</button></div>');
            } else {
              this.setMessage('⚠ <b>Sin conexión o error de guardado.</b> Tus cambios están pendientes en este dispositivo. No cierres sin exportar un respaldo.', 'warning', '<div class="stack"><button class="btn small secondary" onclick="window.formaCloud.flush()">↻ Reintentar</button><button class="btn small secondary" onclick="exportData()">↓ Exportar respaldo</button></div>');
            }
            return false;
          }
        }
        return !this.conflict && !this.pending;
      })();
      const result = await this.sending;
      this.sending = null;
      return result;
    },
    async discardAndReload() {
      if (!confirm('¿Descartar los cambios pendientes de ESTE dispositivo? Exportá un respaldo primero. Después se abrirá la versión guardada en la nube.')) return;
      try {localStorage.removeItem(this.dirtyKey);} catch(e){}
      location.reload();
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
        const {data:sessionData,error:sessionError} = await this.client.auth.getSession();
        if (sessionError) throw sessionError;
        const session = sessionData?.session;
        if (!session?.user) {
          this.setMessage('● <b>Estás en modo invitado.</b> Tus registros permanecen en este navegador. <a href="auth.html" style="color:#efd5a1;text-decoration:underline">Creá una cuenta o iniciá sesión</a> para sincronizarlos.', 'warning');
          this.updateUI();
          return;
        }
        this.user = session.user;
        this.cacheKey = 'forma_cloud_cache_' + session.user.id;
        this.dirtyKey = 'forma_cloud_pending_' + session.user.id;
        const {data:row,error} = await this.client.from('forma_user_state')
          .select('state,version').eq('user_id', session.user.id).maybeSingle();
        if (error) throw error;
        this.version = Number(row?.version || 0);
        let pending = null;
        try {pending=JSON.parse(localStorage.getItem(this.dirtyKey)||'null');} catch(e){}
        // Nunca mezclamos silenciosamente los datos de invitado con los datos de la cuenta.
        if (pending && pending.version === this.version && validState(pending.state)) {
          data = pending.state;
          this.ready = true;
          this.cache(data);
          this.queue(data);
        } else if (pending && pending.version !== this.version) {
          this.conflict = true;
          data = validState(row?.state) ? row.state : fresh();
          this.setMessage('⚠ Este navegador tiene cambios sin subir y la nube fue actualizada en otro lugar. No los mezclamos. Exportá la copia local antes de descartarla.', 'error', '<div class="stack"><button class="btn small secondary" onclick="window.formaCloud.exportPending()">↓ Exportar pendientes</button><button class="btn small secondary" onclick="window.formaCloud.discardAndReload()">Usar datos en nube</button></div>');
        } else {
          data = validState(row?.state) ? row.state : fresh();
          if (!row) {
            this.setMessage('● <b>Cuenta nueva.</b> Todavía no hay entrenamientos en la nube. Si usabas FORMA antes, importá el respaldo JSON desde Perfil; así evitás perder tus registros previos.');
          } else {
            this.setMessage('● <b>Sincronizado en la nube.</b> Recuperamos tus rutinas y entrenamientos.');
          }
        }
        this.ready = true;
        this.cache(data);
        render();
        this.updateUI();
      } catch(err) {
        console.error('[FORMA] No pudo iniciar sincronización:',err);
        // Nunca mostramos datos de otra cuenta si falla la verificación.
        if (this.user) {
          let cached=null;
          try{cached=JSON.parse(localStorage.getItem(this.cacheKey)||'null');}catch(e){}
          if (validState(cached)) {
            data=cached;this.ready=true;
            render();
            this.showWarning('⚠ No pudimos contactar Supabase. Se cargó la copia local de esta cuenta. Los cambios quedarán pendientes hasta recuperar la conexión.');
          } else {
            data=fresh();this.ready=false;
            render();
            this.setMessage('No se pudo cargar tu cuenta. Intentá actualizar la página. No edites registros hasta recuperar la conexión.', 'error');
          }
        } else {
          this.showWarning('No se pudo verificar Supabase: ' + safeError(err) + '. La demostración permanece en modo local.');
        }
      } finally {this.busy(false);this.updateUI();}
    },
    exportPending() {
      try {
        const p = JSON.parse(localStorage.getItem(this.dirtyKey)||'null');
        if (!validState(p?.state)) {alert('No se encontró un respaldo pendiente');return;}
        const blob=new Blob([JSON.stringify(p.state,null,2)],{type:'application/json'});
        const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='forma-cambios-pendientes.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
      } catch(e){alert('No se pudo exportar el respaldo local');}
    }
  };
  function validState(v){return !!v && typeof v==='object' && !Array.isArray(v) && Array.isArray(v.routine) && v.routine.length>0 && Array.isArray(v.history) && Array.isArray(v.weight) && v.drafts && typeof v.drafts==='object' && !Array.isArray(v.drafts);}
  function safeError(e){return String(e?.message||'error desconocido').slice(0,130).replace(/[<>]/g,'');}
  window.formaCloud=C;
  window.addEventListener('online',()=>{if(C.user&&C.ready&&!C.conflict)C.flush()});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&C.user&&C.ready&&!C.conflict)C.flush()});
  C.initialize();
})();

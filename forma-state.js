/* FORMA 3.7.1 — Validación única del estado de la app.
   La usan app.html (carga local, importación, finalizar sesión) y cloud.js (datos de la nube y pendientes).
   Dos modos:
   - strict:true  → respaldos importados y datos nuevos: tipos, rangos y límites exactos.
   - strict:false → datos que YA existen (navegador / nube): se exige la estructura que la app necesita
     para no fallar, pero no se descartan registros históricos por rangos que versiones anteriores permitían. */
(function (root) {
  'use strict';
  const LIM = Object.freeze({
    name: 60, goal: 60, dayName: 80, short: 20, exName: 90, reps: 35, rest: 35,
    routines: 20, exercises: 30, sets: 12, history: 5000, entries: 400, weight: 5000,
    kgMax: 1000, repsMax: 100, bodyMin: 20, bodyMax: 400, draftField: 12, legacyKgMax: 1e6
  });
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
  const isNum = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
  const isInt = (v, a, b) => typeof v === 'number' && Number.isInteger(v) && v >= a && v <= b;
  const isDate = v => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
  const clone = v => JSON.parse(JSON.stringify(v));

  function checkDraftField(v) {
    if (typeof v === 'number') v = Number.isFinite(v) ? String(v) : null;
    if (typeof v !== 'string' || v.length > LIM.draftField || !/^[0-9eE.+\-]*$/.test(v)) return null;
    return v;
  }
  function checkDrafts(drafts, routine, strict, err, repaired) {
    const out = {};
    for (const k of Object.keys(drafts)) {
      const d = drafts[k];
      let good = /^\d{1,2}$/.test(k) && +k < routine.length && Array.isArray(d) && d.length <= LIM.exercises;
      const norm = [];
      if (good) {
        for (const sets of d) {
          if (!Array.isArray(sets) || sets.length > LIM.sets) { good = false; break; }
          const ns = [];
          for (const s of sets) {
            const kg = isObj(s) ? checkDraftField(s.kg) : null, reps = isObj(s) ? checkDraftField(s.reps) : null;
            if (kg === null || reps === null || typeof s.done !== 'boolean') { good = false; break; }
            ns.push({ kg, reps, done: s.done });
          }
          if (!good) break;
          norm.push(ns);
        }
      }
      if (good) out[k] = norm;
      else if (strict) err('drafts["' + String(k).slice(0, 10) + '"] tiene una estructura inválida');
      else repaired.push('borrador ' + String(k).slice(0, 10) + ' descartado (se regenera vacío)');
    }
    return out;
  }

  /* Devuelve {ok, errors, repaired, value}. value solo existe si ok. */
  function check(obj, opts) {
    const strict = !!(opts && opts.strict), errors = [], repaired = [];
    const err = m => { if (errors.length < 12) errors.push(m); };
    if (!isObj(obj)) return { ok: false, errors: ['el contenido no es un objeto'], repaired, value: null };
    const out = {};

    if (obj.name === undefined && !strict) out.name = '';
    else if (isStr(obj.name, 0, LIM.name)) out.name = obj.name; else err('name debe ser texto de hasta ' + LIM.name + ' caracteres');
    if (obj.goal === undefined && !strict) out.goal = 'Recomposición corporal';
    else if (isStr(obj.goal, 0, LIM.goal)) out.goal = obj.goal; else err('goal debe ser texto de hasta ' + LIM.goal + ' caracteres');

    // Rutina
    let routine = [];
    if (!Array.isArray(obj.routine) || obj.routine.length < 1 || obj.routine.length > LIM.routines) err('routine debe tener entre 1 y ' + LIM.routines + ' días');
    else {
      routine = obj.routine.map((d, i) => {
        if (!isObj(d)) { err('routine[' + i + '] no es un objeto'); return null; }
        if (!isStr(d.name, 1, LIM.dayName)) err('routine[' + i + '].name inválido');
        const short = d.short === undefined && !strict && typeof d.name === 'string' ? d.name.slice(0, LIM.short) : d.short;
        if (!isStr(short, 0, LIM.short)) err('routine[' + i + '].short inválido');
        if (!Array.isArray(d.ex) || d.ex.length < 1 || d.ex.length > LIM.exercises) { err('routine[' + i + '].ex debe tener entre 1 y ' + LIM.exercises + ' ejercicios'); return null; }
        const ex = d.ex.map((e, j) => {
          const ok = Array.isArray(e) && e.length === 4 && isStr(e[0], 1, LIM.exName) && isInt(e[1], 1, LIM.sets) && isStr(e[2], 1, LIM.reps) && isStr(e[3], 1, LIM.rest);
          if (!ok) { err('routine[' + i + '].ex[' + j + '] inválido (nombre, series 1–' + LIM.sets + ', reps, descanso)'); return null; }
          return [e[0], e[1], e[2], e[3]];
        });
        return { name: d.name, short, ex };
      });
    }

    // Historial
    const ids = new Set();
    let history = [];
    if (!Array.isArray(obj.history) || obj.history.length > LIM.history) err('history debe ser una lista de hasta ' + LIM.history + ' sesiones');
    else {
      history = obj.history.map((h, i) => {
        if (!isObj(h)) { err('history[' + i + '] no es un objeto'); return null; }
        if (!(Number.isSafeInteger(h.id) && h.id >= 0)) err('history[' + i + '].id debe ser un entero seguro');
        else if (strict && ids.has(h.id)) err('history[' + i + '].id duplicado');
        else ids.add(h.id);
        if (!isDate(h.date)) err('history[' + i + '].date no es una fecha válida');
        if (h.day !== undefined && !isInt(h.day, 0, LIM.routines - 1)) err('history[' + i + '].day inválido');
        if (h.name !== undefined && !isStr(h.name, 0, LIM.dayName)) err('history[' + i + '].name inválido');
        if (!Array.isArray(h.entries) || h.entries.length > LIM.entries || (strict && h.entries.length < 1)) { err('history[' + i + '].entries inválido'); return null; }
        const entries = h.entries.map((e, j) => {
          const where = 'history[' + i + '].entries[' + j + ']';
          if (!isObj(e) || !isStr(e.exercise, 1, LIM.exName)) { err(where + '.exercise inválido'); return null; }
          const kgOk = strict ? isNum(e.kg, 0, LIM.kgMax) : isNum(e.kg, 0, LIM.legacyKgMax);
          const repsOk = strict ? isInt(e.reps, 1, LIM.repsMax) : isNum(e.reps, 0.0001, LIM.repsMax);
          if (!kgOk) err(where + '.kg fuera de rango (0–' + LIM.kgMax + ')');
          if (!repsOk) err(where + '.reps debe ser entero 1–' + LIM.repsMax);
          if (e.set !== undefined && !isInt(e.set, 1, LIM.sets)) err(where + '.set inválido');
          const ne = { exercise: e.exercise, kg: e.kg, reps: e.reps };
          if (e.set !== undefined) ne.set = e.set;
          return ne;
        });
        const nh = { id: h.id, date: h.date, entries };
        if (h.day !== undefined) nh.day = h.day;
        if (h.name !== undefined) nh.name = h.name;
        return nh;
      });
    }

    // Peso corporal
    let weight = [];
    if (obj.weight === undefined && !strict) { weight = []; repaired.push('weight ausente'); }
    else if (!Array.isArray(obj.weight) || obj.weight.length > LIM.weight) err('weight debe ser una lista de hasta ' + LIM.weight + ' mediciones');
    else weight = obj.weight.map((w, i) => {
      if (!isObj(w) || !isDate(w.date) || !isNum(w.kg, LIM.bodyMin, LIM.bodyMax)) { err('weight[' + i + '] inválido (fecha y kg ' + LIM.bodyMin + '–' + LIM.bodyMax + ')'); return null; }
      return { date: w.date, kg: w.kg };
    });

    // Borradores
    let drafts = {};
    if (obj.drafts === undefined && !strict) { repaired.push('drafts ausente'); }
    else if (!isObj(obj.drafts)) err('drafts debe ser un objeto');
    else if (routine.length) drafts = checkDrafts(obj.drafts, routine, strict, err, repaired);

    // Resto
    let active = 0;
    if (obj.active !== undefined) {
      if (isInt(obj.active, 0, Math.max(0, routine.length - 1))) active = obj.active;
      else if (strict) err('active fuera de la rutina');
      else repaired.push('active fuera de rango (se usa 0)');
    }
    if (obj.trialUsed !== undefined && typeof obj.trialUsed !== 'boolean') err('trialUsed debe ser verdadero/falso');

    if (errors.length) return { ok: false, errors, repaired, value: null };
    Object.assign(out, { routine, history, drafts, weight, active });
    if (typeof obj.trialUsed === 'boolean') out.trialUsed = obj.trialUsed;
    return { ok: true, errors, repaired, value: out };
  }

  /* Revisión devuelta por el servidor: entero seguro ≥ 0 (número o texto numérico). null/boolean/'' → inválida. */
  function parseRevision(v) {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
    if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v);
    return null;
  }
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  const sameState = (a, b) => stable(a) === stable(b);
  /* Huella corta (longitud + dos hashes de 32 bits) para reconocer un estado sin guardarlo dos veces. */
  function hash(v) {
    const s = stable(v);
    let h1 = 0x811c9dc5, h2 = 5381;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = (Math.imul(h2, 33) + c) >>> 0;
    }
    return s.length + ':' + h1.toString(16) + ':' + h2.toString(16);
  }

  /* Serie de un borrador → {status:'empty'|'incomplete'|'invalid'|'ok', kg, reps, reason} */
  function entryFromDraft(s) {
    const kgS = String(s && s.kg != null ? s.kg : '').trim(), repsS = String(s && s.reps != null ? s.reps : '').trim();
    if (kgS === '' && repsS === '') return { status: 'empty' };
    if (kgS === '' || repsS === '') return { status: 'incomplete' };
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(kgS) || +kgS > LIM.kgMax) return { status: 'invalid', reason: 'kg debe estar entre 0 y ' + LIM.kgMax };
    if (!/^\d{1,3}$/.test(repsS) || +repsS < 1 || +repsS > LIM.repsMax) return { status: 'invalid', reason: 'las repeticiones deben ser un número entero entre 1 y ' + LIM.repsMax };
    return { status: 'ok', kg: +kgS, reps: +repsS };
  }
  const fmt = v => { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0'; };
  const safeId = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

  const api = { LIM, check, parseRevision, sameState, hash, entryFromDraft, fmt, safeId, clone };
  root.FormaState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* FORMA · Generador de rutinas personalizado.
   Módulo puro (sin DOM, sin red): sirve en el navegador y en pruebas de Node.
   - screen(): filtro de seguridad previo. Si algo es dudoso NO se genera rutina.
   - plan(): generador determinista (hoy es el "motor"; la IA real se conecta por `remote`).
   - validate(): TODA rutina (venga de código o de una IA) pasa por acá antes de mostrarse.
   Es orientación general de entrenamiento, no asesoría profesional ni prescripción individual. */
(function (root) {
  'use strict';

  const GOALS = {
    musculo:  { label: 'Ganar músculo',     reps: '8–12',  rest: '90 s–2 min', sets: [3, 3, 4] },
    fuerza:   { label: 'Ganar fuerza',      reps: '5–8',   rest: '2–3 min',    sets: [3, 3, 4] },
    grasa:    { label: 'Perder grasa',      reps: '10–15', rest: '60–90 s',    sets: [2, 3, 3] },
    salud:    { label: 'Salud y constancia', reps: '10–15', rest: '60–90 s',    sets: [2, 2, 3] }
  };
  const LEVELS = ['principiante', 'intermedio', 'avanzado'];
  const EQUIP = ['gimnasio', 'mancuernas', 'casa'];
  const HEALTH = {
    lesion:   'Tengo una lesión o dolor al entrenar',
    cardio:   'Me indicaron limitar el esfuerzo o tengo un problema cardíaco',
    embarazo: 'Estoy embarazada o en posparto reciente',
    condicion:'Tengo una condición médica o tomo medicación que afecta el ejercicio',
    mareos:   'Siento mareos o dolor en el pecho al hacer esfuerzo'
  };
  const PER_DAY = [[30, 4], [45, 5], [60, 6], [90, 8]];
  const LIMITS = { minAge: 18, maxAge: 99, minDays: 2, maxDays: 6, minPerDay: 3, maxSets: 5 };

  const SLOTS = {
    cuerpo: ['Cuádriceps', 'Pecho', 'Espalda', 'Isquiotibiales', 'Hombros', 'Core', 'Bíceps', 'Tríceps'],
    torso:  ['Pecho', 'Espalda', 'Hombros', 'Espalda', 'Pecho', 'Bíceps', 'Tríceps'],
    pierna: ['Cuádriceps', 'Isquiotibiales', 'Glúteos', 'Cuádriceps', 'Gemelos', 'Core', 'Isquiotibiales'],
    empuje: ['Pecho', 'Hombros', 'Pecho', 'Tríceps', 'Hombros', 'Tríceps'],
    tiron:  ['Espalda', 'Espalda', 'Hombros', 'Bíceps', 'Bíceps', 'Core']
  };
  const TITLES = { cuerpo: 'Cuerpo completo', torso: 'Torso', pierna: 'Piernas', empuje: 'Empuje', tiron: 'Tirón' };
  const SPLITS = {
    2: ['cuerpo', 'cuerpo'], 3: ['cuerpo', 'cuerpo', 'cuerpo'],
    4: ['torso', 'pierna', 'torso', 'pierna'],
    5: ['empuje', 'tiron', 'pierna', 'torso', 'pierna'],
    6: ['empuje', 'tiron', 'pierna', 'empuje', 'tiron', 'pierna']
  };

  const isInt = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;

  /* ---------- 1. Filtro de seguridad ---------- */
  function screen(a) {
    const reasons = [];
    if (!a || typeof a !== 'object') return { ok: false, reasons: ['Faltan datos.'], notes: [] };
    const age = Number(a.age);
    if (!isInt(age, 1, 120)) reasons.push('Ingresá una edad válida.');
    else if (age < LIMITS.minAge) reasons.push('Este generador es solo para mayores de 18 años. Consultá a un profesional.');
    else if (age > LIMITS.maxAge) reasons.push('Ingresá una edad válida.');
    const h = a.health || {};
    for (const k of Object.keys(HEALTH)) if (h[k]) reasons.push('Marcaste: “' + HEALTH[k] + '”. Antes de entrenar con una rutina general, consultá a un profesional de la salud.');
    const notes = [];
    if (reasons.length === 0 && age >= 60) notes.push('Por tu edad, conviene consultar a tu médico antes de empezar.');
    return { ok: reasons.length === 0, reasons, notes };
  }

  /* ---------- 2. Normalización de respuestas ---------- */
  function normalize(a) {
    const days = Number(a.days), minutes = Number(a.minutes);
    const out = {
      age: Number(a.age),
      goal: GOALS[a.goal] ? a.goal : null,
      level: LEVELS.includes(a.level) ? a.level : null,
      equipment: EQUIP.includes(a.equipment) ? a.equipment : null,
      days: isInt(days, LIMITS.minDays, LIMITS.maxDays) ? days : null,
      minutes: [30, 45, 60, 90].includes(minutes) ? minutes : null,
      health: a.health || {}
    };
    const missing = Object.keys(out).filter(k => out[k] === null);
    return { value: out, missing };
  }

  const equipOk = (equipment, item) => {
    if (equipment === 'gimnasio') return true;
    return /mancuerna|peso corporal|suelo/i.test(item[2]);
  };

  /* ---------- 3. Motor determinista ---------- */
  function plan(answers, lib) {
    const n = normalize(answers);
    if (n.missing.length) throw new Error('Faltan respuestas: ' + n.missing.join(', '));
    const a = n.value, g = GOALS[a.goal], li = LEVELS.indexOf(a.level);
    const perDay = PER_DAY.find(p => p[0] === a.minutes)[1];
    const pool = lib.filter(e => equipOk(a.equipment, e));
    const kinds = SPLITS[a.days], seen = {};
    const days = kinds.map(kind => {
      const v = seen[kind] = (seen[kind] || 0);
      seen[kind]++;
      const used = new Set(), ex = [];
      for (const group of SLOTS[kind]) {
        if (ex.length >= perDay) break;
        const cands = pool.filter(e => e[1] === group && !used.has(e[0]));
        if (!cands.length) continue;
        const pick = cands[v % cands.length];
        used.add(pick[0]);
        ex.push([pick[0], group === 'Core' || group === 'Gemelos' ? Math.min(g.sets[li], 3) : g.sets[li],
                 group === 'Core' ? '30–45 s' : (group === 'Gemelos' ? '12–20' : g.reps), g.rest]);
      }
      const letter = 'ABC'[v] || String(v + 1);
      const title = TITLES[kind] + (kinds.filter(k => k === kind).length > 1 ? ' ' + letter : '');
      return { name: title, short: title.slice(0, 20), ex };
    });
    return { goal: GOALS[a.goal].label, days };
  }

  /* ---------- 4. Validación (obligatoria para cualquier origen) ---------- */
  function validate(candidate, lib, answers) {
    const errors = [];
    const names = new Set(lib.map(e => e[0]));
    const n = normalize(answers || {});
    if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.days)) return { ok: false, errors: ['La rutina no tiene el formato esperado.'] };
    if (n.missing.length === 0 && candidate.days.length !== n.value.days) errors.push('Cantidad de días distinta a la pedida.');
    if (!isInt(candidate.days.length, LIMITS.minDays, LIMITS.maxDays)) errors.push('Cantidad de días fuera de rango.');
    const maxPer = n.missing.length === 0 ? PER_DAY.find(p => p[0] === n.value.minutes)[1] : 8;
    candidate.days.forEach((d, i) => {
      const tag = 'Día ' + (i + 1) + ': ';
      if (!d || typeof d.name !== 'string' || !d.name.trim() || d.name.length > 80) errors.push(tag + 'nombre inválido.');
      if (!Array.isArray(d.ex) || d.ex.length < LIMITS.minPerDay || d.ex.length > maxPer) { errors.push(tag + 'cantidad de ejercicios fuera de rango.'); return; }
      const dup = new Set();
      d.ex.forEach(e => {
        if (!Array.isArray(e) || e.length !== 4) { errors.push(tag + 'ejercicio mal formado.'); return; }
        if (!names.has(e[0])) errors.push(tag + '“' + String(e[0]).slice(0, 40) + '” no está en la biblioteca.');
        if (dup.has(e[0])) errors.push(tag + 'ejercicio repetido.'); dup.add(e[0]);
        if (!isInt(e[1], 1, LIMITS.maxSets)) errors.push(tag + 'series fuera de rango.');
        if (typeof e[2] !== 'string' || !/^\d{1,3}([–-]\d{1,3})?( s)?$/.test(e[2])) errors.push(tag + 'repeticiones con formato inválido.');
        if (typeof e[3] !== 'string' || e[3].length < 1 || e[3].length > 35) errors.push(tag + 'descanso inválido.');
      });
    });
    return { ok: errors.length === 0, errors };
  }

  /* ---------- 5. Orquestación: filtro → (IA remota | motor local) → validación ---------- */
  async function generate(answers, lib, opts) {
    const s = screen(answers);
    if (!s.ok) return { ok: false, blocked: true, reasons: s.reasons };
    let candidate = null, source = 'local';
    if (opts && typeof opts.remote === 'function') {
      try { candidate = await opts.remote(answers, lib); source = 'ia'; } catch (e) { candidate = null; }
      if (candidate && !validate(candidate, lib, answers).ok) candidate = null;
    }
    if (!candidate) { candidate = plan(answers, lib); source = 'local'; }
    const v = validate(candidate, lib, answers);
    if (!v.ok) return { ok: false, blocked: false, reasons: ['No pudimos armar una rutina segura con esas opciones. Probá cambiar equipamiento o tiempo.'], errors: v.errors };
    return { ok: true, source, notes: s.notes, plan: candidate };
  }

  /* Texto para la IA real (se usa del lado del servidor). Solo ejercicios de la biblioteca. */
  function buildPrompt(answers, lib) {
    const n = normalize(answers).value;
    return 'Armá una rutina de entrenamiento general (no médica) en JSON válido, sin texto adicional.\n' +
      'Perfil: objetivo=' + GOALS[n.goal].label + '; nivel=' + n.level + '; equipamiento=' + n.equipment +
      '; días por semana=' + n.days + '; minutos por sesión=' + n.minutes + '.\n' +
      'Formato: {"goal":string,"days":[{"name":string,"short":string,"ex":[[nombre,series,repeticiones,descanso]]}]}.\n' +
      'Usá EXACTAMENTE estos nombres de ejercicio y ningún otro: ' + lib.map(e => e[0]).join('; ') + '.\n' +
      'Máximo ' + PER_DAY.find(p => p[0] === n.minutes)[1] + ' ejercicios por día, sin repetir ejercicios dentro del mismo día, series entre 1 y 5.';
  }

  root.FormaGen = { GOALS, LEVELS, EQUIP, HEALTH, LIMITS, screen, normalize, plan, validate, generate, buildPrompt };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.FormaGen;
})(typeof window !== 'undefined' ? window : globalThis);

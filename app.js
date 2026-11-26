const STORAGE_KEY = 'mare_pwa_state_v1';
const DEFAULT_FIREBASE_URL = 'https://mare-duo-default-rtdb.firebaseio.com';

function cloneDefaultState() {
  return JSON.parse(JSON.stringify({
    onboarded: false,
    role: 'primary',
    settings: {
      goal: 'know_body',
      contraceptive: 'none',
      reminder: '',
      discreetMode: 'default',
      pinHash: null,
      defaultCycleLength: 28,
      defaultPeriodLength: 5
    },
    duo: {
      firebaseUrl: DEFAULT_FIREBASE_URL,
      roomId: null,
      roomSecret: null,
      lastSyncedAt: null,
      paused: false,
      permissions: { phase: true, libido: true, symptoms: true },
      signal: null,
      signalDate: null,
      careItems: [
        'Massagem nos pés ou costas',
        'Água / chá / algo leve',
        'Companhia tranquila sem pressão',
        'Tempo sozinha(o)'
      ],
      activeCareItems: [
        'Massagem nos pés ou costas',
        'Companhia tranquila sem pressão'
      ],
      mutualCare: [],
      plans: []
    },
    partnerSnapshot: null,
    entries: {}
  }));
}

function reportRuntimeError(message) {
  try {
    console.error('[Maré]', message);
    const box = document.getElementById('runtime-error-box');
    const msgEl = document.getElementById('runtime-error-msg');
    if (box && msgEl) {
      msgEl.textContent = String(message);
      box.style.display = 'block';
    }
  } catch (_) {}
}

window.addEventListener('error', (e) => reportRuntimeError(e.message || 'Erro de execução'));
window.addEventListener('unhandledrejection', (e) => reportRuntimeError(e.reason?.message || e.reason || 'Erro assíncrono'));

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaultState();
    const parsed = JSON.parse(raw);
    const base = cloneDefaultState();
    return {
      ...base,
      ...parsed,
      role: parsed && parsed.role === 'partner' ? 'partner' : 'primary',
      settings: { ...base.settings, ...(parsed && parsed.settings ? parsed.settings : {}) },
      duo: {
        ...base.duo,
        ...(parsed && parsed.duo ? parsed.duo : {}),
        firebaseUrl: (parsed && parsed.duo && parsed.duo.firebaseUrl) || DEFAULT_FIREBASE_URL,
        permissions: {
          ...base.duo.permissions,
          ...(parsed && parsed.duo && parsed.duo.permissions ? parsed.duo.permissions : {})
        }
      },
      entries: parsed && typeof parsed.entries === 'object' && parsed.entries !== null ? parsed.entries : {}
    };
  } catch (e) {
    return cloneDefaultState();
  }
}

let state = loadState();
let activeDate = toISODate(new Date());
let calCursor = new Date();
let selectedCalDate = activeDate;
let deferredInstallPrompt = null;
let pinBuffer = '';
let partnerPollTimer = null;

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    reportRuntimeError('Erro ao salvar no localStorage: ' + (e.message || e));
  }
}

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseISODate(str) {
  if (!str || typeof str !== 'string') return new Date();
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

function diffDays(a, b) {
  return Math.round(
    (new Date(b.getFullYear(), b.getMonth(), b.getDate()) -
      new Date(a.getFullYear(), a.getMonth(), a.getDate())) /
      86400000
  );
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2300);
}

/* =========================================================================
   MOTOR FISIOLÓGICO DO CICLO (ACOG / FIGO) + PROJEÇÃO MULTICICLOS
   ========================================================================= */
function getCycleMetrics() {
  const flowDates = Object.keys(state.entries || {})
    .filter((d) => state.entries[d] && ['light', 'medium', 'heavy'].includes(state.entries[d].flow))
    .sort();

  const cycles = [];
  let currentBlock = [];
  for (let i = 0; i < flowDates.length; i++) {
    if (i === 0 || diffDays(parseISODate(flowDates[i - 1]), parseISODate(flowDates[i])) > 2) {
      if (currentBlock.length) cycles.push(currentBlock);
      currentBlock = [flowDates[i]];
    } else {
      currentBlock.push(flowDates[i]);
    }
  }
  if (currentBlock.length) cycles.push(currentBlock);

  const periodStarts = cycles.map((b) => b[0]);

  let avgCycle = Number(state.settings.defaultCycleLength) || 28;
  if (periodStarts.length >= 2) {
    const lengths = [];
    for (let i = 1; i < periodStarts.length; i++) {
      const len = diffDays(parseISODate(periodStarts[i - 1]), parseISODate(periodStarts[i]));
      if (len >= 18 && len <= 60) lengths.push(len);
    }
    if (lengths.length > 0) {
      const recent = lengths.slice(-4);
      avgCycle = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
    }
  }

  let avgPeriodLen = Number(state.settings.defaultPeriodLength) || 5;
  if (cycles.length > 0) {
    const periodLengths = cycles
      .map((b) => diffDays(parseISODate(b[0]), parseISODate(b[b.length - 1])) + 1)
      .filter((l) => l >= 2 && l <= 10);
    if (periodLengths.length > 0) {
      const recentP = periodLengths.slice(-3);
      avgPeriodLen = Math.round(recentP.reduce((a, b) => a + b, 0) / recentP.length);
    }
  }

  return { periodStarts, avgCycle, avgPeriodLen };
}

function getCycleAnalysis(targetDateStr = toISODate(new Date()), cachedMetrics = null) {
  const targetDate = parseISODate(targetDateStr);
  const { periodStarts, avgCycle, avgPeriodLen } = cachedMetrics || getCycleMetrics();
  const isHormonalSuppressed = ['pill', 'ring', 'patch', 'implant', 'hormonal_iud'].includes(
    state.settings.contraceptive
  );

  const pastOrCurrentStarts = periodStarts.filter((d) => d <= targetDateStr);
  const anchorStr =
    pastOrCurrentStarts.length > 0
      ? pastOrCurrentStarts[pastOrCurrentStarts.length - 1]
      : periodStarts[0] || targetDateStr;
  const anchorDate = parseISODate(anchorStr);
  const totalDaysFromAnchor = diffDays(anchorDate, targetDate);

  let cycleOffsetIndex = 0;
  let cycleStartDate = anchorDate;
  let cycleDay = 1;

  if (totalDaysFromAnchor >= 0) {
    cycleOffsetIndex = Math.floor(totalDaysFromAnchor / avgCycle);
    cycleStartDate = addDays(anchorDate, cycleOffsetIndex * avgCycle);
    cycleDay = (totalDaysFromAnchor % avgCycle) + 1;
  } else {
    cycleOffsetIndex = Math.floor(totalDaysFromAnchor / avgCycle);
    cycleStartDate = addDays(anchorDate, cycleOffsetIndex * avgCycle);
    cycleDay = diffDays(cycleStartDate, targetDate) + 1;
  }

  const isPredictedCycle = cycleOffsetIndex !== 0 || pastOrCurrentStarts.length === 0;
  const entry = state.entries[targetDateStr];
  const hasLoggedPeriod = !!(entry && ['light', 'medium', 'heavy'].includes(entry.flow));
  const hasLoggedSpotting = !!(entry && entry.flow === 'spotting');

  const lutealLength = 14;
  const ovulationDay = Math.max(avgPeriodLen + 2, avgCycle - lutealLength);
  const fertileStartDay = Math.max(avgPeriodLen + 1, ovulationDay - 5);
  const fertileEndDay = ovulationDay;

  let phaseKey = 'follicular';
  let phaseName = 'Fase Folicular';
  let phaseColor = '#f4a261';
  let phaseDesc =
    'Estrogênio em elevação gradual; tendência de melhora na disposição, lubrificação e clareza mental.';
  let isOvulationDay = false;

  if (isHormonalSuppressed) {
    if (hasLoggedPeriod || cycleDay <= avgPeriodLen) {
      phaseKey = 'menstrual';
      phaseName = 'Pausa / Sangramento de Privação';
      phaseColor = '#e11d48';
      phaseDesc =
        'Sangramento causado pela queda dos hormônios sintéticos do método contraceptivo.';
    } else {
      phaseKey = 'follicular';
      phaseName = 'Fase Estável (Método Hormonal)';
      phaseColor = '#f4a261';
      phaseDesc =
        'Hormônios sintéticos mantêm níveis constantes e suprimem o pico ovulatório natural.';
    }
  } else if (hasLoggedPeriod || cycleDay <= avgPeriodLen) {
    phaseKey = 'menstrual';
    phaseName = isPredictedCycle && !hasLoggedPeriod ? 'Menstruação Prevista' : 'Fase Menstrual';
    phaseColor = '#e11d48';
    phaseDesc =
      'Descamação endometrial pela queda de progesterona e estrogênio. Período natural de menor energia física.';
  } else if (cycleDay < fertileStartDay) {
    phaseKey = 'follicular';
    phaseName = 'Fase Folicular';
    phaseColor = '#f4a261';
    phaseDesc =
      'Maturação folicular e estrogênio em ascensão. Favorece disposição, humor estável e retomada do desejo.';
  } else if (cycleDay <= fertileEndDay) {
    phaseKey = 'ovulatory';
    isOvulationDay = cycleDay === ovulationDay;
    phaseName = isOvulationDay ? 'Dia Estimado da Ovulação' : 'Janela Fértil (Fase Ovulatória)';
    phaseColor = '#e07a5f';
    phaseDesc = isOvulationDay
      ? 'Pico de LH e estrogênio com liberação do óvulo. Ápice fisiológico de fertilidade e libido.'
      : 'Alta probabilidade fértil (sobrevida espermática de até 5 dias + pico estrogênico).';
  } else {
    phaseKey = 'luteal';
    phaseName = 'Fase Lútea';
    phaseColor = '#c084fc';
    phaseDesc =
      'Predomínio de progesterona (~14 dias até o próximo ciclo). Pode trazer introspecção ou sensibilidade pré-menstrual.';
  }

  const nextPeriodDate = addDays(cycleStartDate, avgCycle);
  const fertileStartStr = toISODate(addDays(cycleStartDate, fertileStartDay - 1));
  const fertileEndStr = toISODate(addDays(cycleStartDate, fertileEndDay - 1));
  const ovulationStr = toISODate(addDays(cycleStartDate, ovulationDay - 1));

  let nextPhaseLabel = '';
  if (!isHormonalSuppressed) {
    if (cycleDay <= avgPeriodLen) {
      nextPhaseLabel = `Fase Folicular em ${avgPeriodLen - cycleDay + 1}d`;
    } else if (cycleDay < fertileStartDay) {
      nextPhaseLabel = `Janela Fértil em ${fertileStartDay - cycleDay}d`;
    } else if (cycleDay <= fertileEndDay) {
      nextPhaseLabel = `Fase Lútea em ${fertileEndDay - cycleDay + 1}d`;
    } else {
      nextPhaseLabel = `Próx. Menstruação em ${Math.max(1, avgCycle - cycleDay + 1)}d`;
    }
  } else {
    nextPhaseLabel = `Próx. ciclo em ${Math.max(1, avgCycle - cycleDay + 1)}d`;
  }

  return {
    cycleDay,
    avgCycle,
    avgPeriodLen,
    phaseKey,
    phaseName,
    phaseColor,
    phaseDesc,
    isHormonalSuppressed,
    isPredictedCycle,
    hasLoggedPeriod,
    hasLoggedSpotting,
    isOvulationDay,
    nextPeriodStr: toISODate(nextPeriodDate),
    daysUntilNextPeriod: diffDays(targetDate, nextPeriodDate),
    fertileStartStr,
    fertileEndStr,
    ovulationStr,
    nextPhaseLabel,
    periodStarts
  };
}

/* =========================================================================
   CRIPTOGRAFIA PONTA A PONTA (AES-GCM) & FIREBASE REALTIME DATABASE
   ========================================================================= */
function normalizeFirebaseUrl(rawUrl) {
  return (rawUrl || '').trim().replace(/\/+$/, '');
}

function randomToken(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(len);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

function parsePairCode(codeStr) {
  const clean = (codeStr || '').trim().toUpperCase();
  const match = clean.match(/^MARE-([A-Z0-9]{4,8})-([A-Z0-9]{8,24})$/);
  if (!match) return null;
  return { roomId: match[1], secret: match[2], fullCode: clean };
}

async function deriveDuoCryptoKey(secret, roomId) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, [
    'deriveKey'
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode('mare_duo_salt_' + roomId),
      iterations: 60000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptDuoPayload(obj, secret, roomId) {
  if (!window.crypto || !crypto.subtle) {
    throw new Error('Criptografia WebCrypto requer HTTPS.');
  }
  const key = await deriveDuoCryptoKey(secret, roomId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(obj));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(cipherBuf))),
    updatedAt: Date.now()
  };
}

async function decryptDuoPayload(record, secret, roomId) {
  if (!record || !record.iv || !record.ciphertext) return null;
  const key = await deriveDuoCryptoKey(secret, roomId);
  const iv = Uint8Array.from(atob(record.iv), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(record.ciphertext), (c) => c.charCodeAt(0));
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

function buildDuoSnapshot() {
  const todayStr = toISODate(new Date());
  const metrics = getCycleMetrics();
  const analysis = getCycleAnalysis(todayStr, metrics);
  const todayEntry = state.entries[todayStr] || { libido: 0, flow: 'none', tags: [] };
  const todayTags = Array.isArray(todayEntry.tags) ? todayEntry.tags : [];
  const perms = state.duo.permissions;

  if (state.duo.paused) {
    return { paused: true, generatedDate: todayStr, updatedAt: Date.now() };
  }

  const allowedSymptomMap = {
    cramps: 'Cólicas',
    breast_tenderness: 'Seios sensíveis',
    bloating: 'Inchaço',
    headache: 'Dor de cabeça',
    high_energy: 'Alta energia',
    fatigue: 'Fadiga',
    anxiety: 'Ansiedade',
    irritability: 'Irritabilidade',
    good_mood: 'Disposição'
  };

  const visibleSymptoms = perms.symptoms
    ? todayTags.filter((t) => allowedSymptomMap[t]).map((t) => allowedSymptomMap[t])
    : [];

  const forecast14 = [];
  const baseDate = parseISODate(todayStr);
  for (let i = 0; i < 14; i++) {
    const d = addDays(baseDate, i);
    const dStr = toISODate(d);
    const a = getCycleAnalysis(dStr, metrics);
    forecast14.push({
      date: dStr,
      dayNum: d.getDate(),
      phaseKey: perms.phase ? a.phaseKey : 'neutral',
      phaseName: perms.phase ? a.phaseName : 'Reservado',
      phaseColor: perms.phase ? a.phaseColor : '#b8a6b9',
      isOvulationDay: perms.phase ? a.isOvulationDay : false
    });
  }

  return {
    paused: false,
    generatedDate: todayStr,
    updatedAt: Date.now(),
    permissions: { ...perms },
    cycle: perms.phase
      ? {
          cycleDay: analysis.cycleDay,
          avgCycle: analysis.avgCycle,
          phaseKey: analysis.phaseKey,
          phaseName: analysis.phaseName,
          phaseColor: analysis.phaseColor,
          nextPhaseLabel: analysis.nextPhaseLabel
        }
      : null,
    libido: perms.libido && todayEntry.libido > 0 ? todayEntry.libido : null,
    symptoms: visibleSymptoms,
    signal: state.duo.signalDate === todayStr ? state.duo.signal : null,
    signalDate: state.duo.signalDate,
    activeCareItems: [...state.duo.activeCareItems],
    mutualCare: [...state.duo.mutualCare],
    plans: state.duo.plans.map((p) => ({
      id: p.id,
      date: p.date,
      title: p.title,
      phaseName: perms.phase ? getCycleAnalysis(p.date, metrics).phaseName : ''
    })),
    forecast14
  };
}

async function pushDuoToFirebase(silent = false) {
  if (state.role !== 'primary') return;
  const fbUrl = normalizeFirebaseUrl(state.duo.firebaseUrl || DEFAULT_FIREBASE_URL);
  if (!fbUrl || !state.duo.roomId || !state.duo.roomSecret) return;

  const badge = document.getElementById('duo-sync-badge');
  if (badge) badge.textContent = 'Enviando...';

  try {
    const snapshot = buildDuoSnapshot();
    const encrypted = await encryptDuoPayload(snapshot, state.duo.roomSecret, state.duo.roomId);
    const res = await fetch(`${fbUrl}/duo_rooms/${state.duo.roomId}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(encrypted)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.duo.lastSyncedAt = Date.now();
    persistState();
    updateDuoSyncStatusUI();
    if (!silent) showToast('Sincronizado com o Firebase (E2EE)');
  } catch (err) {
    if (badge) badge.textContent = 'Erro sync';
    if (!silent) showToast('Erro ao sincronizar: verifique as regras do Firebase');
  }
}

async function pullDuoFromFirebase(silent = false) {
  if (state.role !== 'partner') return;
  const fbUrl = normalizeFirebaseUrl(state.duo.firebaseUrl || DEFAULT_FIREBASE_URL);
  if (!fbUrl || !state.duo.roomId || !state.duo.roomSecret) return;

  const badge = document.getElementById('duo-sync-badge');
  if (badge) badge.textContent = 'Buscando...';

  try {
    const res = await fetch(`${fbUrl}/duo_rooms/${state.duo.roomId}.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const record = await res.json();
    if (!record) {
      state.partnerSnapshot = null;
      persistState();
      renderDuoView();
      if (!silent) showToast('Sala vazia ou revogada pela usuária principal');
      return;
    }
    const decrypted = await decryptDuoPayload(record, state.duo.roomSecret, state.duo.roomId);
    state.partnerSnapshot = decrypted;
    state.duo.lastSyncedAt = Date.now();
    persistState();
    renderDuoView();
    if (!silent) showToast('Painel Duo atualizado');
  } catch (err) {
    if (badge) badge.textContent = 'Erro leitura';
    if (!silent) showToast('Falha ao ler/descriptografar dados do Firebase');
  }
}

async function deleteDuoFromFirebase() {
  const fbUrl = normalizeFirebaseUrl(state.duo.firebaseUrl || DEFAULT_FIREBASE_URL);
  if (fbUrl && state.duo.roomId) {
    try {
      await fetch(`${fbUrl}/duo_rooms/${state.duo.roomId}.json`, { method: 'DELETE' });
    } catch (_) {}
  }
  state.duo.roomId = null;
  state.duo.roomSecret = null;
  state.duo.lastSyncedAt = null;
  persistState();
  renderDuoView();
  showToast('Sala revogada e apagada da nuvem');
}

function updateDuoSyncStatusUI() {
  const isPartner = state.role === 'partner';
  const hasRoom = !!(state.duo.roomId && state.duo.roomSecret);
  const fbUrl = normalizeFirebaseUrl(state.duo.firebaseUrl || DEFAULT_FIREBASE_URL);

  document.body.classList.toggle('partner-mode', isPartner);
  document.querySelectorAll('.primary-only').forEach((el) => {
    el.style.display = isPartner ? 'none' : '';
  });

  document.getElementById('duo-primary-sync-box').style.display = isPartner ? 'none' : 'block';
  document.getElementById('duo-partner-sync-box').style.display = isPartner ? 'block' : 'none';

  const fbInput = document.getElementById('duo-fb-url');
  if (fbInput && !fbInput.value && fbUrl) fbInput.value = fbUrl;

  const unpairedBox = document.getElementById('duo-unpaired-actions');
  const pairedBox = document.getElementById('duo-paired-actions');
  if (unpairedBox && pairedBox) {
    unpairedBox.style.display = hasRoom ? 'none' : 'block';
    pairedBox.style.display = hasRoom ? 'block' : 'none';
  }

  if (hasRoom) {
    document.getElementById('duo-pair-code-display').textContent = `MARE-${state.duo.roomId}-${state.duo.roomSecret}`;
  }

  const badge = document.getElementById('duo-sync-badge');
  const statusText = document.getElementById('duo-sync-status');

  if (!fbUrl || !hasRoom) {
    badge.className = 'badge';
    badge.textContent = 'Local';
    statusText.textContent = 'Gere um código ou link para parear 2 celulares';
  } else {
    badge.className = 'badge live';
    badge.textContent = 'E2EE Ativo';
    const timeStr = state.duo.lastSyncedAt
      ? new Date(state.duo.lastSyncedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : 'aguardando';
    statusText.textContent = isPartner
      ? `Sincronizado com o celular principal (última leitura: ${timeStr})`
      : `Sala ${state.duo.roomId} ativa • Último envio: ${timeStr}`;
  }
}

/* =========================================================================
   RENDERIZAÇÃO DAS VIEWS
   ========================================================================= */
function renderTodayView() {
  if (state.role === 'partner') return;
  const analysis = getCycleAnalysis(activeDate);
  const isToday = activeDate === toISODate(new Date());

  document.getElementById('checkin-date-label').textContent = isToday
    ? 'Hoje'
    : parseISODate(activeDate).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });

  document.getElementById('hero-cycle-day').textContent = `Dia ${analysis.cycleDay}`;
  document.getElementById('hero-cycle-total').textContent = `de ~${analysis.avgCycle} dias`;

  const ring = document.getElementById('cycle-progress-ring');
  const pct = Math.min(1, analysis.cycleDay / analysis.avgCycle);
  ring.style.strokeDashoffset = 289 - 289 * pct;
  ring.style.stroke = analysis.phaseColor;

  const badge = document.getElementById('hero-phase-badge');
  badge.textContent =
    state.settings.discreetMode === 'discreet' ? `Etapa ${analysis.cycleDay}` : analysis.phaseName;
  badge.style.color = analysis.phaseColor;
  badge.style.background = `${analysis.phaseColor}29`;

  document.getElementById('hero-phase-desc').textContent =
    state.settings.discreetMode === 'discreet'
      ? 'Acompanhamento diário de bem-estar e equilíbrio.'
      : analysis.phaseDesc;

  const fertilePill = !analysis.isHormonalSuppressed
    ? `<span class="pred-pill">Janela fértil: ${parseISODate(analysis.fertileStartStr).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} – ${parseISODate(analysis.fertileEndStr).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>`
    : `<span class="pred-pill">Ovulação suprimida pelo método</span>`;

  document.getElementById('hero-predictions').innerHTML = `<span class="pred-pill">${analysis.nextPhaseLabel}</span>${fertilePill}`;

  const contraBanner = document.getElementById('contraceptive-banner');
  if (state.settings.contraceptive !== 'none' || state.settings.reminder) {
    contraBanner.style.display = 'block';
    const methodNames = {
      pill: 'Pílula',
      hormonal_iud: 'DIU Hormonal',
      copper_iud: 'DIU Cobre',
      ring: 'Anel',
      patch: 'Adesivo',
      implant: 'Implante',
      none: ''
    };
    const mText = methodNames[state.settings.contraceptive]
      ? `Método: <strong>${methodNames[state.settings.contraceptive]}</strong>`
      : '';
    const rText = state.settings.reminder ? ` • Lembrete: ${state.settings.reminder}` : '';
    contraBanner.innerHTML = `${mText}${rText}`;
  } else {
    contraBanner.style.display = 'none';
  }

  const entry = state.entries[activeDate] || { libido: 0, flow: 'none', tags: [] };
  const tags = Array.isArray(entry.tags) ? entry.tags : [];

  document.querySelectorAll('#libido-scale .libido-btn').forEach((btn) => {
    btn.classList.toggle('selected', Number(btn.dataset.val) === entry.libido);
  });

  document.querySelectorAll('#flow-chips .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.val === (entry.flow || 'none'));
  });

  document.querySelectorAll('#sex-chips .chip, #symptom-chips .chip, #factor-chips .chip').forEach((chip) => {
    chip.classList.toggle('active', tags.includes(chip.dataset.tag));
  });

  document.getElementById('checkin-status-badge').textContent = state.entries[activeDate]
    ? 'Registrado ✓'
    : '~15 seg';
}

async function saveDailyEntry() {
  const selectedLibidoBtn = document.querySelector('#libido-scale .libido-btn.selected');
  const libido = selectedLibidoBtn ? Number(selectedLibidoBtn.dataset.val) : 0;
  const selectedFlowChip = document.querySelector('#flow-chips .chip.active');
  const flow = selectedFlowChip ? selectedFlowChip.dataset.val : 'none';
  const tags = Array.from(
    document.querySelectorAll('#sex-chips .chip.active, #symptom-chips .chip.active, #factor-chips .chip.active')
  ).map((c) => c.dataset.tag);

  state.entries[activeDate] = { libido, flow, tags, updatedAt: Date.now() };
  persistState();
  renderAll();
  showToast('Registro salvo localmente');
  await pushDuoToFirebase(true);
}

function renderDuoView() {
  updateDuoSyncStatusUI();

  const isPartner = state.role === 'partner';
  const snapshot = isPartner ? state.partnerSnapshot : buildDuoSnapshot();
  const isPaused = isPartner ? !!(snapshot && snapshot.paused) : !!state.duo.paused;

  document.getElementById('duo-paused-card').style.display = isPaused ? 'block' : 'none';
  document.getElementById('duo-active-content').style.display = isPaused ? 'none' : 'block';

  const pauseBtn = document.getElementById('duo-pause-btn');
  if (pauseBtn) pauseBtn.textContent = isPaused ? 'Reativar envio' : 'Pausar envio';

  if (isPaused) return;

  if (isPartner && !snapshot) {
    document.getElementById('duo-climate-title').textContent = 'Aguardando primeira sincronização';
    document.getElementById('duo-climate-desc').textContent =
      'Toque em "Atualizar Agora" acima ou aguarde o envio da usuária principal.';
    document.getElementById('duo-shared-details').innerHTML = '';
    document.getElementById('duo-empathy-tip').textContent =
      'Assim que os dados forem enviados, o clima do dia e o guia de empatia aparecerão aqui.';
    document.getElementById('duo-forecast-strip').innerHTML = '';
    document.getElementById('care-menu-chips').innerHTML = '';
    document.getElementById('duo-plans-list').innerHTML = '';
    return;
  }

  const todayStr = toISODate(new Date());
  const perms = snapshot.permissions || { phase: true, libido: true, symptoms: true };

  if (!isPartner) {
    document.getElementById('perm-phase').checked = state.duo.permissions.phase;
    document.getElementById('perm-libido').checked = state.duo.permissions.libido;
    document.getElementById('perm-symptoms').checked = state.duo.permissions.symptoms;
  }

  const phaseKey = snapshot.cycle ? snapshot.cycle.phaseKey : 'follicular';
  const phaseName = snapshot.cycle ? snapshot.cycle.phaseName : '';
  const libidoVal = snapshot.libido || 0;
  const symptoms = Array.isArray(snapshot.symptoms) ? snapshot.symptoms : [];

  let climateTitle = 'Maré Calma';
  let climateDesc = 'Dia de ritmo equilibrado e conversa leve.';
  let empathyTip = 'Aproveite a estabilidade do dia para conexão simples, escuta e presença.';

  if (phaseKey === 'ovulatory' || libidoVal >= 4) {
    climateTitle = 'Maré Alta';
    climateDesc = 'Energia, abertura e desejo mais presentes hoje.';
    empathyTip =
      'A disposição e o interesse costumam estar mais altos. Bom momento para um encontro ou conexão a dois sem pressão.';
  } else if (phaseKey === 'menstrual' || symptoms.includes('Cólicas') || symptoms.includes('Fadiga')) {
    climateTitle = 'Maré Baixa';
    climateDesc = 'Possível recolhimento, cansaço ou sensibilidade física hoje.';
    empathyTip =
      'Pode haver fluxo, cólica ou fadiga. Perguntar de forma aberta o que ajuda hoje costuma funcionar melhor do que adivinhar.';
  } else if (phaseKey === 'luteal' || symptoms.includes('Ansiedade') || symptoms.includes('Irritabilidade')) {
    climateTitle = 'Maré de Afeto & Cuidado';
    climateDesc = 'Fase em que o corpo e o humor podem pedir mais acolhimento e previsibilidade.';
    empathyTip =
      'Oscilações de energia e sensibilidade são comuns. Aliviar tarefas pendentes e manter um clima acolhedor faz diferença.';
  }

  const activeSignal = snapshot.signalDate === todayStr ? snapshot.signal : null;
  if (activeSignal === 'in_the_mood') climateTitle = 'Maré Alta • Sinal: No Clima';
  else if (activeSignal === 'affection_only') climateTitle = 'Maré de Afeto • Carinho sem Sexo';
  else if (activeSignal === 'need_space') climateTitle = 'Maré Baixa • Espaço Hoje';

  document.getElementById('duo-climate-title').textContent = perms.phase ? climateTitle : 'Clima Compartilhado';
  document.getElementById('duo-climate-desc').textContent = perms.phase
    ? `${climateDesc} (${phaseName})`
    : 'Detalhes da fase ocultos por escolha de privacidade.';

  const details = [];
  if (perms.libido && libidoVal > 0) {
    const libidoLabels = { 1: 'Nula', 2: 'Baixa', 3: 'Média', 4: 'Alta', 5: 'Intensa' };
    details.push(`Termômetro de desejo: <strong>${libidoLabels[libidoVal]} (${libidoVal}/5)</strong>`);
  }
  if (perms.symptoms && symptoms.length > 0) {
    details.push(`Marcadores liberados: <strong>${symptoms.join(', ')}</strong>`);
  }
  document.getElementById('duo-shared-details').innerHTML = details.length
    ? details.join(' • ')
    : '<span style="color:var(--text-muted);">Nenhum detalhe adicional liberado para hoje.</span>';

  document.getElementById('duo-empathy-tip').textContent = empathyTip;

  document.getElementById('silent-signals-caption').textContent = isPartner
    ? 'Sinal enviado hoje pela usuária principal (somente leitura):'
    : 'Sinalize seu tom de proximidade hoje com leveza, sem cobrança de resposta imediata:';

  document.querySelectorAll('#silent-signals .signal-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.signal === activeSignal);
  });

  const forecastContainer = document.getElementById('duo-forecast-strip');
  const forecast = Array.isArray(snapshot.forecast14) ? snapshot.forecast14 : [];
  forecastContainer.innerHTML = forecast
    .map(
      (f) => `
      <div class="forecast-cell" style="border-color:${f.isOvulationDay ? f.phaseColor : 'transparent'}; background:${f.phaseColor}22;" title="${f.phaseName}">
        <div style="font-weight:700; color:var(--text);">${f.dayNum}</div>
        <div style="width:14px; height:3px; border-radius:99px; background:${f.phaseColor}; margin:3px auto 0;"></div>
      </div>
    `
    )
    .join('');

  const careContainer = document.getElementById('care-menu-chips');
  careContainer.innerHTML = '';
  const careList = isPartner ? snapshot.activeCareItems || [] : state.duo.careItems;
  if (isPartner && !careList.length) {
    careContainer.innerHTML = `<span style="font-size:0.78rem; color:var(--text-muted);">Nenhum item selecionado no momento.</span>`;
  } else {
    careList.forEach((item) => {
      const chip = document.createElement('span');
      const isActive = isPartner ? true : state.duo.activeCareItems.includes(item);
      chip.className = 'chip' + (isActive ? ' active' : '');
      if (!isPartner) chip.dataset.careItem = item;
      chip.textContent = item;
      careContainer.appendChild(chip);
    });
  }

  if (!isPartner) {
    const planDateInput = document.getElementById('duo-plan-date');
    if (planDateInput && !planDateInput.value) planDateInput.value = todayStr;
  }

  const plansList = document.getElementById('duo-plans-list');
  const plans = snapshot.plans || [];
  if (!plans.length) {
    plansList.innerHTML = `<p style="font-size:0.78rem; color:var(--text-muted); margin-top:8px;">Nenhum plano adicionado ainda.</p>`;
  } else {
    plansList.innerHTML = plans
      .map((p) => {
        const dateFmt = parseISODate(p.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const removeBtn = !isPartner
          ? `<button type="button" class="btn-secondary" style="padding:5px 9px; font-size:0.74rem;" data-remove-plan="${p.id}">×</button>`
          : '';
        return `
          <div class="plan-item">
            <div>
              <strong>${dateFmt} — ${p.title}</strong>
              ${p.phaseName ? `<div style="font-size:0.72rem; color:var(--text-muted);">Previsão do dia: ${p.phaseName}</div>` : ''}
            </div>
            ${removeBtn}
          </div>
        `;
      })
      .join('');
  }

  const mutualList = snapshot.mutualCare || [];
  document.querySelectorAll('#mutual-care-chips .chip').forEach((ch) => {
    ch.classList.toggle('active', mutualList.includes(ch.dataset.m));
  });
}

function renderCalendar() {
  if (state.role === 'partner') return;
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  const monthName = calCursor.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  document.getElementById('cal-month-title').textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);

  const firstDayWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = toISODate(new Date());
  const metrics = getCycleMetrics();

  const container = document.getElementById('cal-days');
  container.innerHTML = '';

  for (let i = 0; i < firstDayWeekday; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    container.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = toISODate(new Date(year, month, d));
    const entry = state.entries[dateStr];
    const entryTags = entry && Array.isArray(entry.tags) ? entry.tags : [];
    const hasPlan = state.duo.plans.some((p) => p.date === dateStr);
    const dayAnalysis = getCycleAnalysis(dateStr, metrics);

    const cell = document.createElement('div');
    cell.className = 'cal-day';
    cell.dataset.date = dateStr;
    if (dateStr === todayStr) cell.classList.add('today');
    if (dateStr === selectedCalDate) cell.classList.add('selected');

    if (dayAnalysis.hasLoggedPeriod || dayAnalysis.hasLoggedSpotting) {
      cell.classList.add('phase-menstrual');
    } else if (dayAnalysis.phaseKey === 'menstrual') {
      cell.classList.add('phase-menstrual-pred');
    } else if (dayAnalysis.phaseKey === 'ovulatory') {
      cell.classList.add(dayAnalysis.isOvulationDay ? 'phase-ovulation-peak' : 'phase-ovulatory');
    } else if (dayAnalysis.phaseKey === 'luteal') {
      cell.classList.add('phase-luteal');
    } else {
      cell.classList.add('phase-follicular');
    }

    const dotsHtml = [];
    if (entry?.libido > 0) dotsHtml.push(`<i class="dot" style="background:#f4a261" title="Libido"></i>`);
    if (entryTags.length > 0) dotsHtml.push(`<i class="dot" style="background:#faf5f7" title="Sintomas/Tags"></i>`);
    if (hasPlan) dotsHtml.push(`<i class="dot" style="background:#f59e0b" title="Plano Duo"></i>`);

    cell.innerHTML = `
      <span class="cal-day-num">${d}</span>
      <div class="cal-dots">${dotsHtml.join('')}</div>
      <span class="cal-phase-bar" style="background:${dayAnalysis.phaseColor};"></span>
    `;
    container.appendChild(cell);
  }

  renderSelectedDayDetail(selectedCalDate);
}

function renderSelectedDayDetail(dateStr) {
  const dateLabel = parseISODate(dateStr).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long'
  });
  document.getElementById('selected-day-heading').textContent = dateLabel;

  const entry = state.entries[dateStr];
  const dayAnalysis = getCycleAnalysis(dateStr);
  const dayPlans = state.duo.plans.filter((p) => p.date === dateStr).map((p) => p.title);
  const planLine = dayPlans.length ? `<br>Plano do casal: <strong>${dayPlans.join(', ')}</strong>` : '';

  const statusTag = dayAnalysis.hasLoggedPeriod
    ? 'Registro confirmado'
    : dayAnalysis.isPredictedCycle
      ? 'Projeção fisiológica'
      : 'Ciclo atual';

  const phaseBadgeHtml = `<span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:0.75rem; font-weight:700; background:${dayAnalysis.phaseColor}29; color:${dayAnalysis.phaseColor};">${dayAnalysis.phaseName}</span>`;

  if (!entry) {
    document.getElementById('selected-day-summary').innerHTML =
      `${phaseBadgeHtml} <span style="font-size:0.75rem;">(${statusTag} • Dia ${dayAnalysis.cycleDay} de ~${dayAnalysis.avgCycle})</span><br>
       <span style="display:block; margin-top:4px;">${dayAnalysis.phaseDesc}</span>
       <span style="display:block; margin-top:4px; color:var(--text);">Próxima transição: <strong>${dayAnalysis.nextPhaseLabel}</strong></span>${planLine}`;
    return;
  }

  const entryTags = Array.isArray(entry.tags) ? entry.tags : [];
  const flowLabels = { none: 'Sem fluxo', spotting: 'Escape', light: 'Leve', medium: 'Moderado', heavy: 'Intenso' };
  document.getElementById('selected-day-summary').innerHTML =
    `${phaseBadgeHtml} <span style="font-size:0.75rem;">(Dia ${dayAnalysis.cycleDay} do ciclo)</span><br>
     Fluxo: <strong>${flowLabels[entry.flow] || 'Sem fluxo'}</strong> • Libido: <strong>${entry.libido ? `${entry.libido}/5` : 'Não informado'}</strong><br>
     ${entryTags.length ? `${entryTags.length} marcador(es) registrado(s)` : 'Sem sintomas adicionais'} • ${dayAnalysis.nextPhaseLabel}${planLine}`;
}

function renderInsightsView() {
  if (state.role === 'partner') return;
  const sortedDates = Object.keys(state.entries || {}).sort().slice(-14);
  const chartContainer = document.getElementById('libido-chart-container');

  if (!sortedDates.length) {
    chartContainer.innerHTML = `<p style="font-size:0.84rem; color:var(--text-muted); padding:16px 0;">Faça seu primeiro check-in diário na aba "Hoje" para visualizar o gráfico de correlação entre ciclo e libido.</p>`;
  } else {
    const width = Math.max(320, sortedDates.length * 36);
    const height = 150;
    const padLeft = 24;
    const plotH = height - 40;
    const stepX = (width - padLeft - 16) / Math.max(1, sortedDates.length - 1);

    let bars = '';
    let points = [];
    let labels = '';

    sortedDates.forEach((d, i) => {
      const entry = state.entries[d] || {};
      const analysis = getCycleAnalysis(d);
      const x = sortedDates.length === 1 ? width / 2 : padLeft + i * stepX;
      bars += `<rect x="${x - 10}" y="12" width="20" height="${plotH}" rx="4" fill="${analysis.phaseColor}" opacity="0.22" />`;
      if (entry.libido > 0) {
        const y = 12 + plotH - ((entry.libido - 1) / 4) * (plotH - 12);
        points.push({ x, y });
      }
      labels += `<text x="${x}" y="${height - 6}" fill="#b8a6b9" font-size="9" text-anchor="middle">${d.slice(8, 10)}/${d.slice(5, 7)}</text>`;
    });

    const polyline = points.length
      ? `<polyline fill="none" stroke="#e07a5f" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" points="${points.map((p) => `${p.x},${p.y}`).join(' ')}" />`
      : '';
    const dots = points
      .map((p) => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="#e07a5f" stroke="#161018" stroke-width="1.5" />`)
      .join('');

    chartContainer.innerHTML = `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <line x1="${padLeft}" y1="12" x2="${width - 10}" y2="12" stroke="#433249" stroke-dasharray="3"/>
        <line x1="${padLeft}" y1="${12 + plotH / 2}" x2="${width - 10}" y2="${12 + plotH / 2}" stroke="#433249" stroke-dasharray="3"/>
        <line x1="${padLeft}" y1="${12 + plotH}" x2="${width - 10}" y2="${12 + plotH}" stroke="#433249"/>
        <text x="8" y="16" fill="#b8a6b9" font-size="9">5</text>
        <text x="8" y="${16 + plotH / 2}" fill="#b8a6b9" font-size="9">3</text>
        <text x="8" y="${12 + plotH}" fill="#b8a6b9" font-size="9">1</text>
        ${bars}${polyline}${dots}${labels}
      </svg>
    `;
  }

  const allEntries = Object.entries(state.entries || {});
  const libidoEntries = allEntries.filter(([, e]) => e && e.libido > 0);
  const avgLibido = libidoEntries.length
    ? (libidoEntries.reduce((acc, [, e]) => acc + e.libido, 0) / libidoEntries.length).toFixed(1)
    : '—';
  const stressLowLibido = libidoEntries.filter(
    ([, e]) => e.libido <= 2 && Array.isArray(e.tags) && e.tags.includes('high_stress')
  ).length;
  const painCount = allEntries.filter(
    ([, e]) => e && Array.isArray(e.tags) && e.tags.includes('pain')
  ).length;

  const cards = [];
  if (['pill', 'ring', 'patch', 'implant', 'hormonal_iud'].includes(state.settings.contraceptive)) {
    cards.push(
      `<p>• <strong>Influência Contraceptiva:</strong> Métodos hormonais reduzem a flutuação natural de estrogênio e testosterona livre, o que pode estabilizar o humor e modular os picos de desejo.</p>`
    );
  } else {
    cards.push(
      `<p>• <strong>Ondas Hormonais Naturais:</strong> A fase lútea dura em média ~14 dias antes da menstruação; o pico de estrogênio próximo à ovulação favorece lubrificação e desejo.</p>`
    );
  }
  if (stressLowLibido > 0) {
    cards.push(
      `<p>• <strong>Padrão Detectado (Estresse × Desejo):</strong> Em ${stressLowLibido} registro(s) com libido baixa, você também marcou <em>estresse alto</em>.</p>`
    );
  }
  if (painCount > 0) {
    cards.push(
      `<p>• <strong>Alerta de Conforto Íntimo:</strong> Dor ou desconforto registrado em ${painCount} ocasião(ões). Considere levar este relatório para avaliação profissional.</p>`
    );
  }
  document.getElementById('educational-insights').innerHTML = cards.join('');

  const analysis = getCycleAnalysis();
  document.getElementById('stats-summary').innerHTML = `
    <div style="background:var(--bg-elevated); padding:12px; border-radius:12px;"><div style="font-size:0.74rem; color:var(--text-muted);">Ciclo Médio</div><div style="font-size:1.25rem; font-weight:800;">${analysis.avgCycle} dias</div></div>
    <div style="background:var(--bg-elevated); padding:12px; border-radius:12px;"><div style="font-size:0.74rem; color:var(--text-muted);">Libido Média</div><div style="font-size:1.25rem; font-weight:800;">${avgLibido} / 5</div></div>
    <div style="background:var(--bg-elevated); padding:12px; border-radius:12px;"><div style="font-size:0.74rem; color:var(--text-muted);">Dias Registrados</div><div style="font-size:1.25rem; font-weight:800;">${allEntries.length}</div></div>
    <div style="background:var(--bg-elevated); padding:12px; border-radius:12px;"><div style="font-size:0.74rem; color:var(--text-muted);">Menstruação Média</div><div style="font-size:1.25rem; font-weight:800;">${analysis.avgPeriodLen} dias</div></div>
  `;
}

function renderSettingsView() {
  if (state.role === 'partner') return;
  document.getElementById('set-goal').value = state.settings.goal;
  document.getElementById('set-contraceptive').value = state.settings.contraceptive;
  document.getElementById('set-cycle-len').value = state.settings.defaultCycleLength || 28;
  document.getElementById('set-period-len').value = state.settings.defaultPeriodLength || 5;
  document.getElementById('set-reminder').value = state.settings.reminder || '';
  document.getElementById('set-discreet').value = state.settings.discreetMode || 'default';

  const notes = {
    none: 'Algoritmo operando em modo fisiológico completo (fase lútea fixa de ~14 dias antes da próxima menstruação, janela fértil de 6 dias).',
    pill: 'Algoritmo adaptado: sangramentos na pausa são classificados como sangramento de privação, sem janela fértil.',
    hormonal_iud: 'Algoritmo adaptado: supressão ovulatória parcial/total considerada; escapes são comuns.',
    copper_iud: 'Algoritmo adaptado: ciclo hormonal natural mantido, com possível aumento de fluxo menstrual.',
    ring: 'Algoritmo adaptado: níveis hormonais contínuos por 21 dias e sangramento de privação na pausa.',
    patch: 'Algoritmo adaptado: liberação transdérmica contínua sem pico ovulatório natural.',
    implant: 'Algoritmo adaptado: progestagênio contínuo; ovulação suprimida e padrão de sangramento irregular.'
  };
  document.getElementById('contraceptive-info-box').textContent = notes[state.settings.contraceptive] || '';
  applyDiscreetMode();
}

function applyDiscreetMode() {
  const isPartner = state.role === 'partner';
  const isDiscreet = !isPartner && state.settings.discreetMode === 'discreet';
  document.getElementById('app-display-name').textContent = isPartner ? 'Maré Duo' : isDiscreet ? 'Notas' : 'Maré';
  document.getElementById('app-subtitle').textContent = isPartner
    ? 'Modo Parceiro(a) • E2EE'
    : isDiscreet
      ? 'Bem-estar diário'
      : 'Ondas hormonais & libido';
  document.title = isDiscreet ? 'Notas Diárias' : 'Maré — Ciclo, Libido & Bem-Estar Íntimo';
  document.getElementById('quick-lock-btn').style.display = !isPartner && state.settings.pinHash ? 'inline-flex' : 'none';
}

/* =========================================================================
   PIN DE BLOQUEIO & BACKUP CRIPTOGRAFADO LOCAL
   ========================================================================= */
async function sha256(text) {
  if (window.crypto && crypto.subtle) {
    const data = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'fallback_' + (h >>> 0).toString(16);
}

function lockAppNow() {
  if (!state.settings.pinHash) return;
  pinBuffer = '';
  updatePinDots();
  document.getElementById('lock-error').textContent = '';
  const lockEl = document.getElementById('lock-screen');
  lockEl.style.display = 'flex';
  lockEl.classList.add('active');
}

function initKeypad() {
  const keypad = document.getElementById('keypad');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  keypad.innerHTML = '';
  keys.forEach((k) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'key-btn';
    btn.textContent = k;
    if (!k) btn.style.visibility = 'hidden';
    else btn.dataset.pinKey = k;
    keypad.appendChild(btn);
  });
}

function updatePinDots() {
  document.querySelectorAll('#pin-dots .pin-dot').forEach((dot, idx) => {
    dot.classList.toggle('filled', idx < pinBuffer.length);
  });
}

async function deriveKey(passphrase, salt) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey'
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function exportEncryptedBackup() {
  if (!window.crypto || !crypto.subtle) {
    showToast('Backup criptografado requer HTTPS');
    return;
  }
  const pass = document.getElementById('backup-passphrase').value;
  if (!pass || pass.length < 4) {
    showToast('Defina uma senha para proteger o backup');
    return;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(state))
  );
  const payload = {
    app: 'mare-e2ee-backup',
    version: 1,
    salt: Array.from(salt),
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(ciphertext))
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mare-backup-${toISODate(new Date())}.mare`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup criptografado baixado');
}

async function importEncryptedBackup(event) {
  const file = event.target.files && event.target.files[0];
  const pass = document.getElementById('backup-passphrase').value;
  if (!file || !pass) {
    showToast('Informe a senha antes de selecionar o arquivo');
    return;
  }
  try {
    const payload = JSON.parse(await file.text());
    const key = await deriveKey(pass, new Uint8Array(payload.salt));
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(payload.iv) },
      key,
      new Uint8Array(payload.data)
    );
    state = JSON.parse(new TextDecoder().decode(decrypted));
    persistState();
    renderAll();
    showToast('Backup restaurado com sucesso');
  } catch (e) {
    showToast('Falha ao descriptografar: senha ou arquivo inválido');
  }
}

/* =========================================================================
   NAVEGAÇÃO, DELEGAÇÃO DE EVENTOS & INICIALIZAÇÃO
   ========================================================================= */
function switchView(viewName) {
  if (state.role === 'partner') viewName = 'duo';
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const target = document.getElementById(`view-${viewName}`);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === viewName);
  });

  const renderers = {
    today: renderTodayView,
    duo: renderDuoView,
    calendar: renderCalendar,
    insights: renderInsightsView,
    settings: renderSettingsView
  };
  if (renderers[viewName]) renderers[viewName]();
}

function renderAll() {
  if (state.role === 'partner') {
    applyDiscreetMode();
    switchView('duo');
    return;
  }
  const steps = [
    ['applyDiscreetMode', applyDiscreetMode],
    ['renderTodayView', renderTodayView],
    ['renderDuoView', renderDuoView],
    ['renderCalendar', renderCalendar],
    ['renderInsightsView', renderInsightsView],
    ['renderSettingsView', renderSettingsView]
  ];
  for (const [name, fn] of steps) {
    try {
      fn();
    } catch (err) {
      reportRuntimeError(`Falha em ${name}: ${err && err.message ? err.message : err}`);
    }
  }
}

function checkInviteHash() {
  try {
    const hash = window.location.hash || '';
    if (!hash.startsWith('#pair=')) return false;
    const raw = decodeURIComponent(hash.slice(6));
    const data = JSON.parse(atob(raw));
    const parsed = parsePairCode(data.code || '');
    if (!parsed) return false;

    state.onboarded = true;
    state.role = 'partner';
    state.duo.firebaseUrl = normalizeFirebaseUrl(data.fb || DEFAULT_FIREBASE_URL);
    state.duo.roomId = parsed.roomId;
    state.duo.roomSecret = parsed.secret;
    persistState();

    history.replaceState(null, '', window.location.pathname + window.location.search);
    return true;
  } catch (e) {
    return false;
  }
}

function startPartnerAutoPoll() {
  if (partnerPollTimer) clearInterval(partnerPollTimer);
  if (state.role === 'partner') {
    pullDuoFromFirebase(true);
    partnerPollTimer = setInterval(() => pullDuoFromFirebase(true), 20000);
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button, .chip, .cal-day');
  if (!target) return;

  if (target.matches('.nav-item[data-view]')) {
    switchView(target.dataset.view);
    return;
  }

  if (target.matches('#libido-scale .libido-btn')) {
    const already = target.classList.contains('selected');
    document.querySelectorAll('#libido-scale .libido-btn').forEach((b) => b.classList.remove('selected'));
    if (!already) target.classList.add('selected');
    return;
  }

  if (target.matches('#flow-chips .chip')) {
    document.querySelectorAll('#flow-chips .chip').forEach((c) => c.classList.remove('active'));
    target.classList.add('active');
    return;
  }

  if (target.matches('#sex-chips .chip, #symptom-chips .chip, #factor-chips .chip')) {
    target.classList.toggle('active');
    return;
  }

  if (target.matches('#silent-signals .signal-btn')) {
    if (state.role === 'partner') {
      showToast('Somente a usuária principal altera o sinal do dia');
      return;
    }
    const signalKey = target.dataset.signal;
    const todayStr = toISODate(new Date());
    if (state.duo.signal === signalKey && state.duo.signalDate === todayStr) {
      state.duo.signal = null;
      state.duo.signalDate = null;
    } else {
      state.duo.signal = signalKey;
      state.duo.signalDate = todayStr;
    }
    persistState();
    renderDuoView();
    showToast('Sinal silencioso atualizado');
    await pushDuoToFirebase(true);
    return;
  }

  if (target.dataset.careItem) {
    if (state.role === 'partner') return;
    const item = target.dataset.careItem;
    const idx = state.duo.activeCareItems.indexOf(item);
    if (idx >= 0) state.duo.activeCareItems.splice(idx, 1);
    else state.duo.activeCareItems.push(item);
    persistState();
    renderDuoView();
    await pushDuoToFirebase(true);
    return;
  }

  if (target.matches('#mutual-care-chips .chip')) {
    if (state.role === 'partner') {
      showToast('Item do checklist visualizado');
      return;
    }
    const m = target.dataset.m;
    const idx = state.duo.mutualCare.indexOf(m);
    if (idx >= 0) state.duo.mutualCare.splice(idx, 1);
    else state.duo.mutualCare.push(m);
    persistState();
    renderDuoView();
    await pushDuoToFirebase(true);
    return;
  }

  if (target.dataset.removePlan) {
    if (state.role === 'partner') return;
    state.duo.plans = state.duo.plans.filter((p) => p.id !== target.dataset.removePlan);
    persistState();
    renderDuoView();
    await pushDuoToFirebase(true);
    return;
  }

  if (target.matches('.cal-day[data-date]')) {
    selectedCalDate = target.dataset.date;
    renderCalendar();
    return;
  }

  if (target.dataset.pinKey) {
    const k = target.dataset.pinKey;
    if (k === '⌫') {
      pinBuffer = pinBuffer.slice(0, -1);
      updatePinDots();
    } else if (pinBuffer.length < 4) {
      pinBuffer += k;
      updatePinDots();
      if (pinBuffer.length === 4) {
        const hashed = await sha256(pinBuffer);
        if (hashed === state.settings.pinHash) {
          const lockEl = document.getElementById('lock-screen');
          lockEl.classList.remove('active');
          lockEl.style.display = 'none';
          pinBuffer = '';
          updatePinDots();
        } else {
          document.getElementById('lock-error').textContent = 'PIN incorreto. Tente novamente.';
          pinBuffer = '';
          setTimeout(updatePinDots, 300);
        }
      }
    }
    return;
  }

  const action = target.dataset.action;
  if (!action) return;

  if (action === 'finish-onboarding') {
    const lastPeriodStr = document.getElementById('ob-last-period').value || toISODate(new Date());
    const cycleLen = Math.min(60, Math.max(18, Number(document.getElementById('ob-cycle-len').value) || 28));
    const periodLen = Math.min(10, Math.max(2, Number(document.getElementById('ob-period-len').value) || 5));

    state.onboarded = true;
    state.role = 'primary';
    state.settings.defaultCycleLength = cycleLen;
    state.settings.defaultPeriodLength = periodLen;
    state.settings.goal = document.getElementById('ob-goal').value;
    state.settings.contraceptive = document.getElementById('ob-contraceptive').value;

    const startD = parseISODate(lastPeriodStr);
    const todayStr = toISODate(new Date());
    for (let i = 0; i < periodLen; i++) {
      const dStr = toISODate(addDays(startD, i));
      if (dStr <= todayStr && !state.entries[dStr]) {
        state.entries[dStr] = { libido: 0, flow: 'medium', tags: [] };
      }
    }

    persistState();
    const obScreen = document.getElementById('onboarding-screen');
    obScreen.classList.remove('active');
    obScreen.style.display = 'none';
    renderAll();
    showToast('Maré configurada localmente');
  } else if (action === 'connect-partner-onboarding') {
    const fbUrl = normalizeFirebaseUrl(document.getElementById('ob-fb-url').value || DEFAULT_FIREBASE_URL);
    const parsed = parsePairCode(document.getElementById('ob-pair-code').value);
    if (!parsed) {
      showToast('Informe um código MARE-XXXX-YYYYYYYYYYYY válido');
      return;
    }
    state.onboarded = true;
    state.role = 'partner';
    state.duo.firebaseUrl = fbUrl;
    state.duo.roomId = parsed.roomId;
    state.duo.roomSecret = parsed.secret;
    persistState();

    const obScreen = document.getElementById('onboarding-screen');
    obScreen.classList.remove('active');
    obScreen.style.display = 'none';
    renderAll();
    startPartnerAutoPoll();
  } else if (action === 'save-entry') {
    await saveDailyEntry();
  } else if (action === 'save-fb-url') {
    const url = normalizeFirebaseUrl(document.getElementById('duo-fb-url').value);
    if (!url.startsWith('https://')) {
      showToast('Use uma URL https:// válida do Firebase');
      return;
    }
    state.duo.firebaseUrl = url;
    persistState();
    updateDuoSyncStatusUI();
    showToast('URL do Firebase salva');
  } else if (action === 'generate-pair-room') {
    const fbUrl = normalizeFirebaseUrl(
      document.getElementById('duo-fb-url').value || state.duo.firebaseUrl || DEFAULT_FIREBASE_URL
    );
    state.duo.firebaseUrl = fbUrl;
    state.duo.roomId = randomToken(6);
    state.duo.roomSecret = randomToken(16);
    state.duo.paused = false;
    persistState();
    renderDuoView();
    await pushDuoToFirebase(false);
  } else if (action === 'copy-pair-link') {
    const fbUrl = normalizeFirebaseUrl(state.duo.firebaseUrl || DEFAULT_FIREBASE_URL);
    const code = `MARE-${state.duo.roomId}-${state.duo.roomSecret}`;
    const token = btoa(JSON.stringify({ fb: fbUrl, code }));
    const baseUrl = window.location.origin + window.location.pathname;
    const inviteUrl = `${baseUrl}#pair=${encodeURIComponent(token)}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      showToast('Link de convite Duo copiado!');
    } catch (_) {
      prompt('Copie o link de convite Duo:', inviteUrl);
    }
  } else if (action === 'sync-now') {
    if (state.role === 'partner') await pullDuoFromFirebase(false);
    else await pushDuoToFirebase(false);
  } else if (action === 'revoke-pair-room') {
    await deleteDuoFromFirebase();
  } else if (action === 'disconnect-partner') {
    if (partnerPollTimer) clearInterval(partnerPollTimer);
    state = cloneDefaultState();
    persistState();
    location.reload();
  } else if (action === 'toggle-duo-pause') {
    if (state.role === 'partner') return;
    state.duo.paused = !state.duo.paused;
    persistState();
    renderDuoView();
    showToast(state.duo.paused ? 'Visão Duo pausada' : 'Visão Duo reativada');
    await pushDuoToFirebase(true);
  } else if (action === 'add-care-item') {
    if (state.role === 'partner') return;
    const input = document.getElementById('new-care-item');
    const val = input.value.trim();
    if (!val) return;
    if (!state.duo.careItems.includes(val)) state.duo.careItems.push(val);
    if (!state.duo.activeCareItems.includes(val)) state.duo.activeCareItems.push(val);
    input.value = '';
    persistState();
    renderDuoView();
    showToast('Cuidado adicionado');
    await pushDuoToFirebase(true);
  } else if (action === 'add-duo-plan') {
    if (state.role === 'partner') return;
    const dateVal = document.getElementById('duo-plan-date').value;
    const titleVal = document.getElementById('duo-plan-title').value.trim();
    if (!dateVal || !titleVal) {
      showToast('Preencha data e descrição do plano');
      return;
    }
    state.duo.plans.push({ id: String(Date.now()), date: dateVal, title: titleVal });
    state.duo.plans.sort((a, b) => a.date.localeCompare(b.date));
    document.getElementById('duo-plan-title').value = '';
    persistState();
    renderDuoView();
    showToast('Plano salvo');
    await pushDuoToFirebase(true);
  } else if (action === 'prev-month') {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
    renderCalendar();
  } else if (action === 'next-month') {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
    renderCalendar();
  } else if (action === 'edit-selected-day') {
    activeDate = selectedCalDate;
    switchView('today');
  } else if (action === 'export-pdf') {
    document.getElementById('print-meta').textContent =
      `Gerado localmente em ${new Date().toLocaleDateString('pt-BR')} • Ciclo médio: ${getCycleAnalysis().avgCycle} dias • Registros: ${Object.keys(state.entries || {}).length}`;
    window.print();
  } else if (action === 'save-pin') {
    const val = document.getElementById('set-pin').value.trim();
    if (!/^\d{4}$/.test(val)) {
      showToast('Digite exatamente 4 números');
      return;
    }
    state.settings.pinHash = await sha256(val);
    persistState();
    document.getElementById('set-pin').value = '';
    applyDiscreetMode();
    showToast('Bloqueio por PIN ativado');
  } else if (action === 'remove-pin') {
    state.settings.pinHash = null;
    persistState();
    applyDiscreetMode();
    showToast('Bloqueio por PIN removido');
  } else if (action === 'lock-now') {
    lockAppNow();
  } else if (action === 'export-backup') {
    await exportEncryptedBackup();
  } else if (action === 'wipe-data') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    state = cloneDefaultState();
    location.reload();
  } else if (action === 'reload-page') {
    location.reload();
  }
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (!target) return;

  if (target.id === 'ob-role') {
    const isPartnerRole = target.value === 'partner';
    document.getElementById('ob-primary-fields').style.display = isPartnerRole ? 'none' : 'block';
    document.getElementById('ob-partner-fields').style.display = isPartnerRole ? 'block' : 'none';
  } else if (target.dataset.syncSettings === 'true') {
    state.settings.goal = document.getElementById('set-goal').value;
    state.settings.contraceptive = document.getElementById('set-contraceptive').value;
    state.settings.defaultCycleLength = Math.min(
      60,
      Math.max(18, Number(document.getElementById('set-cycle-len').value) || 28)
    );
    state.settings.defaultPeriodLength = Math.min(
      10,
      Math.max(2, Number(document.getElementById('set-period-len').value) || 5)
    );
    state.settings.reminder = document.getElementById('set-reminder').value.trim();
    state.settings.discreetMode = document.getElementById('set-discreet').value;
    persistState();
    renderAll();
    showToast('Preferências atualizadas');
    await pushDuoToFirebase(true);
  } else if (target.id === 'perm-phase' || target.id === 'perm-libido' || target.id === 'perm-symptoms') {
    state.duo.permissions.phase = document.getElementById('perm-phase').checked;
    state.duo.permissions.libido = document.getElementById('perm-libido').checked;
    state.duo.permissions.symptoms = document.getElementById('perm-symptoms').checked;
    persistState();
    renderDuoView();
    showToast('Permissões Duo atualizadas');
    await pushDuoToFirebase(true);
  } else if (target.id === 'import-backup-file') {
    await importEncryptedBackup(event);
  }
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const installBtn = document.getElementById('install-btn');
  if (!installBtn) return;
  installBtn.style.display = 'inline-flex';
  installBtn.onclick = async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') installBtn.style.display = 'none';
    deferredInstallPrompt = null;
  };
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        reg.update().catch(() => {});
      })
      .catch(() => {});
  });
}

(function init() {
  initKeypad();
  checkInviteHash();

  const obDate = document.getElementById('ob-last-period');
  if (obDate && !obDate.value) obDate.value = toISODate(new Date());

  const obScreen = document.getElementById('onboarding-screen');
  if (!state || !state.onboarded) {
    if (obScreen) {
      obScreen.style.display = 'flex';
      obScreen.classList.add('active');
    }
  } else if (obScreen) {
    obScreen.classList.remove('active');
    obScreen.style.display = 'none';
  }

  if (state && state.role === 'primary' && state.settings && state.settings.pinHash) {
    lockAppNow();
  }

  renderAll();

  if (state.role === 'partner') {
    startPartnerAutoPoll();
  } else if (state.duo.roomId && state.duo.roomSecret && state.duo.firebaseUrl) {
    pushDuoToFirebase(true);
  }
})();
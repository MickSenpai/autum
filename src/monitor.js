// src/monitor.js
// Revisa la bandeja cada cierto tiempo, avisa de tickets nuevos sin grupo y
// los recuerda por Telegram hasta que confirmes "Enterado".
const fs = require('fs');
const { abrirContexto, cargarCookies, guardarSesion } = require('./browser');
const { enviarTelegram, tg, chatId } = require('./notify');
const {
  APP_URL, BANDEJA_URL, AUTH_FILE, STATE_FILE,
  INTERVALO_MS, REMINDER_MIN, ERROR_COOLDOWN_MS, SESION_COOLDOWN_MS,
  AUSENCIAS_PARA_CERRAR, HEADLESS,
} = require('./config');

const RECORDATORIO_MS = REMINDER_MIN * 60 * 1000;
const RE_ID = /^\d{5,7}$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let columnasLogueadas = false;

/* ---------- Estado (data/state.json) ---------- */

function loadState() {
  const base = { seen: [], pending: {}, offset: 0, lastErrorAlert: 0 };
  try { return { ...base, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  catch { return base; }
}

function saveState(state) {
  state.seen = state.seen.slice(-500);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

/* ---------- Telegram: avisos, recordatorios y confirmaciones ---------- */

const teclado = id => ({
  inline_keyboard: [[{ text: '✅ Enterado', callback_data: `ack:${id}` }]],
});

async function borrarMensaje(messageId) {
  if (!messageId) return;
  await tg('deleteMessage', { chat_id: chatId(), message_id: messageId }).catch(() => {});
}

async function avisarTicket(state, id) {
  const msgId = await enviarTelegram(
    `🎫 Ticket nuevo sin grupo: #${id}\n${BANDEJA_URL}\n\nTe lo recordaré cada ${REMINDER_MIN} min hasta que confirmes.`,
    { reply_markup: teclado(id) }
  );
  // Solo si Telegram aceptó el mensaje lo damos por visto y pendiente
  state.seen.push(id);
  state.pending[id] = {
    desde: Date.now(), ultimoAviso: Date.now(), avisos: 1, msgId, msgRec: null, ausente: 0,
  };
  saveState(state);
}

async function confirmar(state, id, textoFinal) {
  const p = state.pending[id];
  if (!p) return false;
  delete state.pending[id];
  saveState(state);
  await borrarMensaje(p.msgRec);
  await tg('editMessageText', {
    chat_id: chatId(),
    message_id: p.msgId,
    text: textoFinal,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
  return true;
}

async function enviarRecordatorios(state) {
  const ahora = Date.now();
  for (const id of Object.keys(state.pending)) {
    const p = state.pending[id];
    if (!p || ahora - p.ultimoAviso < RECORDATORIO_MS) continue;

    const mins = Math.round((ahora - p.desde) / 60000);
    const nuevo = await enviarTelegram(
      `🔔 Recordatorio #${p.avisos}: el ticket #${id} sigue sin grupo y sin confirmar (hace ${mins} min).\n${BANDEJA_URL}`,
      { reply_markup: teclado(id) }
    );

    // Si lo confirmaste mientras se enviaba, borramos el recordatorio recién mandado
    if (!state.pending[id]) { await borrarMensaje(nuevo); continue; }

    await borrarMensaje(p.msgRec);
    p.msgRec = nuevo;
    p.ultimoAviso = ahora;
    p.avisos++;
    saveState(state);
  }
}

async function bucleRecordatorios(state) {
  while (true) {
    await sleep(15000);
    try { await enviarRecordatorios(state); }
    catch (e) { console.error('Recordatorios:', e.message); }
  }
}

async function procesarUpdate(state, u, permitido) {
  const cb = u.callback_query;
  if (cb) {
    if (String(cb.message?.chat?.id) !== permitido) return; // ignorar chats ajenos
    const [accion, id] = (cb.data || '').split(':');
    if (accion === 'ack') {
      const ok = await confirmar(state, id, `✅ Ticket #${id}: enterado.`);
      await tg('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: ok ? 'Enterado ✅' : 'Ya estaba confirmado',
      }).catch(() => {});
    }
    return;
  }

  const m = u.message;
  if (!m || String(m.chat?.id) !== permitido) return;
  const texto = (m.text || '').trim().toLowerCase();

  if (texto.startsWith('/enterado')) {
    const ids = Object.keys(state.pending);
    for (const id of ids) await confirmar(state, id, `✅ Ticket #${id}: enterado.`);
    await enviarTelegram(
      ids.length ? `✅ Confirmados: ${ids.map(i => '#' + i).join(', ')}` : 'No hay tickets pendientes.'
    );
  } else if (texto.startsWith('/pendientes')) {
    const ids = Object.keys(state.pending);
    await enviarTelegram(
      ids.length ? `⏳ Pendientes: ${ids.map(i => '#' + i).join(', ')}` : 'No hay tickets pendientes.'
    );
  }
}

// Long polling: recibe los botones y comandos casi al instante
async function escucharTelegram(state) {
  const permitido = String(chatId());
  while (true) {
    try {
      const updates = await tg('getUpdates', {
        offset: state.offset,
        timeout: 25,
        allowed_updates: ['callback_query', 'message'],
      });
      for (const u of updates) {
        state.offset = u.update_id + 1;
        await procesarUpdate(state, u, permitido).catch(e => console.error('Update:', e.message));
      }
      if (updates.length) saveState(state);
    } catch (e) {
      console.error('Telegram getUpdates:', e.message);
      await sleep(5000);
    }
  }
}

async function alertarFallo(state, motivo) {
  console.error(motivo);
  if (Date.now() - state.lastErrorAlert < ERROR_COOLDOWN_MS) return;
  try {
    await enviarTelegram(`⚠️ Autum:\n${motivo}`);
    state.lastErrorAlert = Date.now();
    saveState(state);
  } catch (e) {
    console.error('No pude avisar por Telegram:', e.message);
  }
}

/* ---------- Lectura de la bandeja ---------- */

// Devuelve 'EXPIRADA' o { sinGrupo: [ids], asignados: Set(ids) }
async function revisar(page) {
  await page.goto(BANDEJA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (!page.url().startsWith(APP_URL)) return 'EXPIRADA';

  await page.waitForSelector('table tbody tr td', { timeout: 20000 });
  await page.waitForTimeout(1500);

  // Solo filas que no contengan otras filas, con sus celdas directas
  const rows = await page.$$eval('table tbody tr', trs =>
    trs
      .filter(tr => !tr.querySelector('tr'))
      .map(tr => [...tr.children].map(td => td.innerText.trim()))
      .filter(r => r.length > 0)
  );

  // Columna ID = la que más filas con formato de ID tiene
  const maxCols = Math.max(0, ...rows.map(r => r.length));
  let iId = -1;
  let mejor = 0;
  for (let c = 0; c < maxCols; c++) {
    const n = rows.filter(r => RE_ID.test(r[c] || '')).length;
    if (n > mejor) { mejor = n; iId = c; }
  }
  if (iId < 0) {
    throw new Error(`No encontré la columna ID (${rows.length} filas, ${maxCols} columnas máx.)`);
  }

  const iGroup = iId + 1; // Group va justo después de ID
  if (iGroup >= maxCols) {
    throw new Error(`No hay columna Group después de ID (ID=${iId}, columnas máx.=${maxCols})`);
  }

  if (!columnasLogueadas) {
    console.log(`Filas: ${rows.length} | Columna ID=${iId}, Group=${iGroup}`);
    columnasLogueadas = true;
  }

  const sinGrupo = [];
  const asignados = new Set();
  for (const r of rows) {
    if (r.length <= iGroup || !RE_ID.test(r[iId])) continue;
    const grupo = r[iGroup];
    if (grupo === '-') sinGrupo.push(r[iId]);
    else if (grupo !== '') asignados.add(r[iId]);
  }
  return { sinGrupo, asignados };
}

/* ---------- Programa principal ---------- */

async function main() {
  const state = loadState();
  let context = null;
  let page = null;
  let sesionMuertaDesde = 0;
  let ultimoAvisoSesion = 0;
  let fallosSeguidos = 0;

  const abrir = async () => {
    context = await abrirContexto({ headless: HEADLESS, fueraDePantalla: !HEADLESS });
    await cargarCookies(context);
    page = context.pages()[0] || await context.newPage();
  };

  const cerrar = async () => {
    if (context) await context.close().catch(() => {});
    process.exit();
  };
  process.on('SIGINT', cerrar);
  process.on('SIGTERM', cerrar);

  await abrir();

  const npend = Object.keys(state.pending).length;
  await enviarTelegram(
    `✅ Autum iniciado${npend ? ` (${npend} ticket(s) pendiente(s) de confirmar)` : ''}`
  ).catch(() => {});
  console.log(
    `Autum iniciado (headless=${HEADLESS}). Revisando cada ${INTERVALO_MS / 1000}s, recordatorios cada ${REMINDER_MIN} min.`
  );

  // Estos dos bucles corren en paralelo y siguen vivos aunque la sesión expire
  escucharTelegram(state);
  bucleRecordatorios(state);

  while (true) {
    try {
      // Sesión expirada: esperamos a que corras "npm run auth" (auth.json más nuevo)
      if (!context) {
        const mod = fs.existsSync(AUTH_FILE) ? fs.statSync(AUTH_FILE).mtimeMs : 0;
        if (mod > sesionMuertaDesde) {
          await abrir();
          console.log('Sesión renovada, reanudando.');
        } else {
          if (Date.now() - ultimoAvisoSesion > SESION_COOLDOWN_MS) {
            await enviarTelegram(
              '⚠️ Autum está ciego: sesión expirada. Ejecuta "npm run auth" (se reanuda solo).'
            ).catch(() => {});
            ultimoAvisoSesion = Date.now();
          }
          await sleep(INTERVALO_MS);
          continue;
        }
      }

      const resultado = await revisar(page);

      if (resultado === 'EXPIRADA') {
        console.error(`Sesión expirada (${page.url()})`);
        await context.close().catch(() => {});
        context = null;
        page = null;
        sesionMuertaDesde = Date.now();
        await enviarTelegram(
          '⚠️ Sesión expirada. Ejecuta "npm run auth"; Autum se reanuda solo al guardar la sesión nueva.'
        ).catch(() => {});
        ultimoAvisoSesion = Date.now();
        await sleep(INTERVALO_MS);
        continue;
      }

      fallosSeguidos = 0;
      await guardarSesion(context).catch(() => {});

      // Pendientes que ya no requieren recordatorio
      for (const id of Object.keys(state.pending)) {
        if (resultado.asignados.has(id)) {
          await confirmar(state, id, `✅ Ticket #${id}: ya tiene grupo asignado, dejo de recordarlo.`);
        } else if (!resultado.sinGrupo.includes(id)) {
          const p = state.pending[id];
          p.ausente = (p.ausente || 0) + 1;
          if (p.ausente >= AUSENCIAS_PARA_CERRAR) {
            await confirmar(state, id, `✅ Ticket #${id}: ya no aparece en la bandeja, dejo de recordarlo.`);
          }
        } else {
          state.pending[id].ausente = 0;
        }
      }
      saveState(state);

      // Tickets nuevos
      const nuevos = resultado.sinGrupo.filter(id => !state.seen.includes(id));
      for (const id of nuevos) {
        await avisarTicket(state, id);
        console.log(`[${new Date().toLocaleTimeString()}] AVISADO #${id}`);
      }
      if (!nuevos.length) {
        console.log(
          `[${new Date().toLocaleTimeString()}] sin novedades (pendientes: ${Object.keys(state.pending).length})`
        );
      }
    } catch (err) {
      fallosSeguidos++;
      console.error(`[${new Date().toLocaleTimeString()}] error (${fallosSeguidos}):`, err.message);
      if (fallosSeguidos >= 3) {
        await alertarFallo(state, `3 errores seguidos. Último: ${err.message}`);
      }
    }

    await sleep(INTERVALO_MS);
  }
}

main();

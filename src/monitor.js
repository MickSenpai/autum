// src/monitor.js
// Revisa la bandeja cada cierto tiempo, avisa de tickets nuevos sin grupo y
// los recuerda por Telegram hasta que los tomes ("Tomar") o confirmes "Enterado".
const fs = require('fs');
const { abrirContexto, cargarCookies, guardarSesion } = require('./browser');
const { enviarTelegram, tg, chatId } = require('./notify');
const {
  SDP_BASE_URL, APP_URL, BANDEJA_URL, AUTH_FILE, STATE_FILE,
  INTERVALO_MS, REMINDER_MIN, ERROR_COOLDOWN_MS, SESION_COOLDOWN_MS,
  AUSENCIAS_PARA_CERRAR, HEADLESS, VISTA_NOMBRE, VISTA_ID,
} = require('./config');

const RECORDATORIO_MS = REMINDER_MIN * 60 * 1000;
const RE_ID = /^\d{1,10}$/;
const FILAS_POR_PAGINA = 100;
const MAX_PAGINAS = 10;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let vistaLogueada = false;
let vistaResuelta = null; // { id, nombre } de la vista vigilada, una vez localizada

// Sesión viva del navegador, compartida con el pick up que se dispara desde Telegram
let contextoActual = null;
let cabecerasApi = null; // cabeceras (token CSRF incluido) que usa la propia página contra /api/v3
const tomando = new Set(); // evita dobles pulsaciones del botón "Tomar"

const hora = () => new Date().toLocaleTimeString();

/* ---------- Estado (data/state.json) ---------- */

function loadState() {
  const base = { seen: [], pending: {}, offset: 0, lastErrorAlert: 0 };
  try { return { ...base, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  catch { return base; }
}

function saveState(state) {
  state.seen = state.seen.slice(-500);
  // Escritura atómica: un corte a mitad de escritura no deja el estado corrupto
  // (un state.json ilegible haría re-avisar todos los tickets sin grupo)
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

/* ---------- Telegram: avisos, recordatorios y confirmaciones ---------- */

const teclado = id => ({
  inline_keyboard: [[
    { text: '🙋 Tomar', callback_data: `pick:${id}` },
    { text: '✅ Enterado', callback_data: `ack:${id}` },
  ]],
});

// Compatibilidad con state.json antiguo (msgRec único)
const recordatoriosDe = p => [...(p.msgsRec || []), ...(p.msgRec ? [p.msgRec] : [])];

async function borrarMensaje(messageId) {
  if (!messageId) return;
  await tg('deleteMessage', { chat_id: chatId(), message_id: messageId }).catch(() => {});
}

async function avisarTicket(state, id, rowId) {
  const msgId = await enviarTelegram(
    `🎫 Ticket nuevo sin grupo: #${id}\n${BANDEJA_URL}\n\nTe lo recordaré cada ${REMINDER_MIN} min hasta que lo tomes o confirmes.`,
    { reply_markup: teclado(id) }
  );
  // Solo si Telegram aceptó el mensaje lo damos por visto y pendiente
  state.seen.push(id);
  state.pending[id] = {
    desde: Date.now(), ultimoAviso: Date.now(), avisos: 1, msgId, msgsRec: [], ausente: 0, rowId,
  };
  saveState(state);
}

async function confirmar(state, id, textoFinal) {
  const p = state.pending[id];
  if (!p) return false;
  delete state.pending[id];
  saveState(state);
  // Al confirmar se limpian todos los recordatorios acumulados
  for (const m of recordatoriosDe(p)) await borrarMensaje(m);
  console.log(`[${hora()}] cerrado #${id}: ${textoFinal}`);
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

    // No borramos el recordatorio anterior: cada uno queda visible y notifica
    p.msgsRec = [...recordatoriosDe(p), nuevo];
    delete p.msgRec;
    p.ultimoAviso = ahora;
    p.avisos++;
    saveState(state);
    console.log(`[${hora()}] recordatorio #${p.avisos - 1} de #${id}`);
  }
}

/* ---------- Pick up vía la API interna de ServiceDesk ---------- */

// Engancha la sesión del navegador para que el pick up pueda usarla
function conectarSesion(context, page) {
  page.on('request', r => {
    if (r.url().startsWith(`${SDP_BASE_URL}/api/v3/`) && r.headers()['x-zcsrf-token']) {
      cabecerasApi = r.headers();
    }
  });
  contextoActual = context;
}

function desconectarSesion() {
  contextoActual = null;
  cabecerasApi = null;
}

async function apiSdp(metodo, ruta) {
  if (!contextoActual) {
    throw new Error('no hay sesión activa de ServiceDesk (¿expiró? ejecuta "npm run auth")');
  }
  if (!cabecerasApi) {
    throw new Error('todavía no he terminado de cargar la bandeja; vuelve a intentarlo en un minuto');
  }
  const headers = {};
  for (const k of ['accept', 'x-zcsrf-token', 'x-sdpod-appid', 'x-requested-with']) {
    if (cabecerasApi[k]) headers[k] = cabecerasApi[k];
  }
  const res = await contextoActual.request.fetch(`${SDP_BASE_URL}/api/v3${ruta}`, {
    method: metodo, headers, timeout: 20000,
  });
  const data = await res.json().catch(() => null);

  // Con la sesión caducada ServiceDesk redirige al login (HTML) en vez de responder JSON
  const fueraDeSdp = !res.url().startsWith(`${SDP_BASE_URL}/`);
  if (res.status() === 401 || fueraDeSdp || (res.ok() && (data === null || typeof data !== 'object'))) {
    throw new Error('ServiceDesk no respondió como API (¿sesión expirada?); ejecuta "npm run auth"');
  }

  const rs = [].concat((data && data.response_status) || [])[0] || {};
  if (!res.ok() || rs.status_code !== 2000) {
    const detalle = (rs.messages || []).map(m => m.message).filter(Boolean).join('; ');
    throw new Error(`ServiceDesk respondió ${res.status()} ${detalle || rs.status || ''}`.trim());
  }
  return data;
}

// Asigna el ticket al usuario de la sesión. Devuelve el texto final para Telegram; lanza Error si falla.
async function tomarTicket(state, id) {
  const p = state.pending[id];
  if (!p) return null;
  if (!p.rowId) throw new Error('aún no tengo el ID interno del ticket; vuelve a intentarlo en un minuto');

  // No le quitamos el ticket a quien ya lo tenga
  const antes = (await apiSdp('GET', `/requests/${p.rowId}`)).request || {};
  if (String(antes.display_id) !== String(id)) throw new Error('el ID interno no corresponde a este ticket');
  if (antes.technician && antes.technician.name) {
    return `ℹ️ Ticket #${id}: ya estaba asignado a ${antes.technician.name}, no lo toqué.`;
  }

  // Un error del PUT puede ser ambiguo (timeout, respuesta con otro formato): lo que manda
  // es cómo quedó el ticket, así que siempre lo volvemos a consultar.
  let errorPut = null;
  try { await apiSdp('PUT', `/requests/${p.rowId}/_pickup`); }
  catch (e) { errorPut = e; }

  let despues;
  try { despues = (await apiSdp('GET', `/requests/${p.rowId}`)).request || {}; }
  catch (e) { throw errorPut || e; }

  const tecnico = despues.technician && despues.technician.name;
  if (!tecnico) {
    throw errorPut || new Error('ServiceDesk aceptó el pick up pero el ticket sigue sin técnico; revísalo a mano');
  }
  if (errorPut) {
    return `ℹ️ Ticket #${id}: quedó asignado a ${tecnico}, aunque el pick up devolvió un error (${errorPut.message}). Compruébalo.`;
  }
  return `🙋 Ticket #${id}: tomado, asignado a ${tecnico}.`;
}

async function manejarTomar(state, cb, id) {
  if (!state.pending[id] || tomando.has(id)) {
    await tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: tomando.has(id) ? 'Ya lo estoy tomando…' : 'Ese ticket ya no está pendiente',
    }).catch(() => {});
    return;
  }
  tomando.add(id);
  await tg('answerCallbackQuery', { callback_query_id: cb.id, text: `Tomando #${id}…` }).catch(() => {});
  try {
    const texto = await tomarTicket(state, id);
    if (texto) await confirmar(state, id, texto);
  } catch (e) {
    console.error(`[${hora()}] pick up #${id} falló:`, e.message);
    // El ticket sigue pendiente: los recordatorios continúan y el botón se puede volver a pulsar
    await enviarTelegram(`❌ No pude tomar el ticket #${id}: ${e.message}\n${BANDEJA_URL}`).catch(() => {});
  } finally {
    tomando.delete(id);
  }
}

async function bucleRecordatorios(state) {
  while (true) {
    await sleep(5000);
    try { await enviarRecordatorios(state); }
    catch (e) { console.error('Recordatorios:', e.message); }
  }
}

async function procesarUpdate(state, u, permitido) {
  const cb = u.callback_query;
  if (cb) {
    if (String(cb.message?.chat?.id) !== permitido) return; // ignorar chats ajenos
    const [accion, id] = (cb.data || '').split(':');
    if (accion === 'pick' && RE_ID.test(id || '')) {
      await manejarTomar(state, cb, id);
    } else if (accion === 'ack') {
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

// La vista que se vigila es siempre la misma (por defecto "Unassigned Requests"), sin importar
// cuál tengas seleccionada en tu navegador: ServiceDesk guarda esa selección en tu cuenta, así
// que leer "lo que muestre la página" haría que Autum cambiara de lista sin avisar.
async function resolverVista(page, vistaNombre, vistaId) {
  if (vistaId) return { id: vistaId, nombre: vistaNombre || `id ${vistaId}` };
  if (vistaResuelta && vistaResuelta.nombre === vistaNombre) return vistaResuelta;

  // Los accesos rápidos de la bandeja traen el nombre y el ID de cada vista
  await page.waitForSelector('li.sdp-filter-li', { timeout: 20000 });
  const vistas = await page.$$eval('li.sdp-filter-li', ls =>
    ls.map(l => ({ nombre: (l.getAttribute('title') || l.innerText || '').trim(), id: l.getAttribute('data-id') }))
  );
  const v = vistas.find(x =>
    x.nombre.toLowerCase() === vistaNombre.toLowerCase() && /^\d+$/.test(x.id || '')
  );
  if (!v) {
    throw new Error(
      `No encontré la vista "${vistaNombre}" entre los accesos rápidos de la bandeja ` +
      `(${vistas.map(x => x.nombre).join(', ') || 'ninguno'}). Añádela allí o define SDP_VIEW_ID en el .env`
    );
  }
  vistaResuelta = { id: v.id, nombre: vistaNombre };
  return vistaResuelta;
}

// Devuelve 'EXPIRADA' o { sinGrupo: [ids], asignados: Set(ids), internos: { id: idInterno } }
async function revisar(page, { vistaNombre = VISTA_NOMBRE, vistaId = VISTA_ID } = {}) {
  // Cargar la bandeja mantiene viva la sesión, detecta si expiró y renueva las cabeceras de la API
  await page.goto(BANDEJA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (!page.url().startsWith(APP_URL)) return 'EXPIRADA';

  const vista = await resolverVista(page, vistaNombre, vistaId);
  for (let i = 0; i < 80 && !cabecerasApi; i++) await page.waitForTimeout(250);

  // Los tickets se piden a la API con el ID de la vista: no depende del orden de las columnas,
  // ni de la paginación de la tabla, ni de que la lista esté vacía.
  const tickets = [];
  let hayMas = true;
  for (let pagina = 0; hayMas && pagina < MAX_PAGINAS; pagina++) {
    const entrada = {
      list_info: {
        row_count: FILAS_POR_PAGINA,
        start_index: pagina * FILAS_POR_PAGINA + 1,
        fields_required: ['display_id', 'group', 'technician'],
        filter_by: { id: vista.id },
        sort_field: 'created_time',
        sort_order: 'desc',
      },
    };
    const data = await apiSdp('GET', `/requests?input_data=${encodeURIComponent(JSON.stringify(entrada))}`);
    if (!Array.isArray(data.requests)) throw new Error('ServiceDesk no devolvió la lista de tickets');
    tickets.push(...data.requests);
    hayMas = !!(data.list_info && data.list_info.has_more_rows);
  }

  if (!vistaLogueada || hayMas) {
    console.log(
      `Vista "${vista.nombre}" (${vista.id}): ${tickets.length} tickets` +
      (hayMas ? ` (hay más; solo se revisan los ${tickets.length} más recientes)` : '')
    );
    vistaLogueada = true;
  }

  const sinGrupo = [];
  const asignados = new Set();
  const internos = {}; // ID visible -> ID interno, necesario para el pick up
  for (const t of tickets) {
    const id = String(t.display_id || '');
    if (!RE_ID.test(id)) continue;
    if (/^\d+$/.test(String(t.id || ''))) internos[id] = String(t.id);
    if (t.group && (t.group.name || t.group.id)) asignados.add(id);
    else sinGrupo.push(id);
  }
  return { sinGrupo, asignados, internos };
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
    conectarSesion(context, page);
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
        desconectarSesion();
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
        // Pendientes de versiones anteriores no traen el ID interno: lo completamos aquí
        if (!state.pending[id].rowId && resultado.internos[id]) state.pending[id].rowId = resultado.internos[id];
        if (resultado.asignados.has(id)) {
          await confirmar(state, id, `✅ Ticket #${id}: ya tiene grupo asignado, dejo de recordarlo.`);
        } else if (!resultado.sinGrupo.includes(id)) {
          const p = state.pending[id];
          p.ausente = (p.ausente || 0) + 1;
          console.log(`#${id} ya no aparece en la vista (${p.ausente}/${AUSENCIAS_PARA_CERRAR})`);
          if (p.ausente >= AUSENCIAS_PARA_CERRAR) {
            await confirmar(state, id, `✅ Ticket #${id}: ya no aparece en la vista (alguien lo tomó o se cerró), dejo de recordarlo.`);
          }
        } else {
          state.pending[id].ausente = 0;
        }
      }
      saveState(state);

      // Tickets nuevos
      const nuevos = resultado.sinGrupo.filter(id => !state.seen.includes(id));
      for (const id of nuevos) {
        await avisarTicket(state, id, resultado.internos[id]);
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

if (require.main === module) {
  main();
}

// Exportado para las pruebas (test/); al ejecutar "npm start" no se usa
module.exports = {
  loadState, saveState, avisarTicket, confirmar, enviarRecordatorios,
  apiSdp, tomarTicket, manejarTomar, procesarUpdate, revisar,
  conectarSesion, desconectarSesion,
  _setSesion(context, cabeceras) { contextoActual = context; cabecerasApi = cabeceras; vistaResuelta = null; },
};

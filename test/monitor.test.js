// test/monitor.test.js
// Pruebas sin red: Telegram y ServiceDesk están simulados y el estado va a una carpeta temporal.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Debe ir antes de cargar src/: dotenv no pisa variables ya definidas
process.env.AUTUM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autum-test-'));
process.env.SDP_BASE_URL = 'https://sdp.example.test';
process.env.TELEGRAM_BOT_TOKEN = 'TOKEN_DE_PRUEBA';
process.env.TELEGRAM_CHAT_ID = '111';
process.env.REMINDER_MINUTES = '1';

const SDP = process.env.SDP_BASE_URL;
const CHAT = process.env.TELEGRAM_CHAT_ID;

/* ---------- Telegram simulado ---------- */

let telegram = []; // { metodo, cuerpo }
let siguienteMsg = 1000;
let telegramFalla = () => false;

global.fetch = async (url, opciones) => {
  const u = String(url);
  assert.ok(u.startsWith('https://api.telegram.org/botTOKEN_DE_PRUEBA/'), `fetch inesperado: ${u}`);
  const metodo = u.split('/').pop();
  const cuerpo = JSON.parse(opciones.body);
  telegram.push({ metodo, cuerpo });
  if (telegramFalla(metodo)) {
    return { ok: false, status: 500, json: async () => ({ ok: false, description: 'caído' }) };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: siguienteMsg++ } }) };
};

const enviados = metodo => telegram.filter(t => t.metodo === metodo).map(t => t.cuerpo);

/* ---------- ServiceDesk simulado ---------- */

const respuesta = (status, cuerpo, url) => ({
  ok: () => status >= 200 && status < 300,
  status: () => status,
  url: () => url,
  json: async () => {
    if (typeof cuerpo === 'string') throw new Error('no es JSON');
    return cuerpo;
  },
});

const OK = { status_code: 2000, status: 'success' };
const ticketJson = (displayId, tecnico) => ({
  request: { display_id: displayId, technician: tecnico ? { name: tecnico } : null },
  response_status: OK,
});

// manejador(metodo, ruta, n) -> { status, cuerpo, url? }
function sdpFalso(manejador) {
  const llamadas = [];
  return {
    llamadas,
    request: {
      fetch: async (url, { method, headers }) => {
        const ruta = url.replace(`${SDP}/api/v3`, '');
        llamadas.push({ method, ruta, headers });
        const r = await manejador(method, ruta, llamadas.length);
        return respuesta(r.status, r.cuerpo, r.url || url);
      },
    },
  };
}

const CABECERAS = {
  accept: 'application/vnd.manageengine.v3+json',
  'x-zcsrf-token': 'sdpcsparam=abc',
  'x-sdpod-appid': '1',
  'x-requested-with': 'XMLHttpRequest',
  cookie: 'no-debe-reenviarse',
};

const m = require('../src/monitor');
const { STATE_FILE } = require('../src/config');

const pendiente = extra => ({
  desde: Date.now(), ultimoAviso: Date.now(), avisos: 1, msgId: 500, msgsRec: [501, 502], ausente: 0,
  rowId: '9001', ...extra,
});
const estado = pending => ({ seen: Object.keys(pending), pending, offset: 0, lastErrorAlert: 0 });
const boton = (data, chat = CHAT) => ({
  update_id: 1,
  callback_query: { id: 'cb1', data, message: { chat: { id: Number(chat) } } },
});

beforeEach(() => {
  telegram = [];
  telegramFalla = () => false;
  m._setSesion(null, null);
});

/* ---------- Pick up ---------- */

test('Tomar: ticket libre -> hace el PUT, verifica y cierra el pendiente', async () => {
  const sdp = sdpFalso((metodo, ruta, n) => {
    if (metodo === 'PUT') return { status: 200, cuerpo: { response_status: OK } };
    return { status: 200, cuerpo: ticketJson('104900', n === 1 ? null : 'Ana Técnica') };
  });
  m._setSesion(sdp, CABECERAS);
  const st = estado({ 104900: pendiente() });

  await m.procesarUpdate(st, boton('pick:104900'), CHAT);

  assert.deepEqual(sdp.llamadas.map(l => `${l.method} ${l.ruta}`), [
    'GET /requests/9001', 'PUT /requests/9001/_pickup', 'GET /requests/9001',
  ]);
  assert.equal(sdp.llamadas[1].headers['x-zcsrf-token'], 'sdpcsparam=abc');
  assert.equal(sdp.llamadas[1].headers.cookie, undefined, 'solo se reenvían las cabeceras de la API');
  assert.deepEqual(st.pending, {});
  assert.match(enviados('editMessageText')[0].text, /tomado, asignado a Ana Técnica/);
  assert.deepEqual(enviados('deleteMessage').map(c => c.message_id), [501, 502]);
  assert.deepEqual(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).pending, {});
});

test('Tomar: si ya tiene técnico no hace el PUT y deja de recordarlo', async () => {
  const sdp = sdpFalso(() => ({ status: 200, cuerpo: ticketJson('104900', 'Otro Técnico') }));
  m._setSesion(sdp, CABECERAS);
  const st = estado({ 104900: pendiente() });

  await m.procesarUpdate(st, boton('pick:104900'), CHAT);

  assert.deepEqual(sdp.llamadas.map(l => l.method), ['GET']);
  assert.deepEqual(st.pending, {});
  assert.match(enviados('editMessageText')[0].text, /ya estaba asignado a Otro Técnico, no lo toqué/);
});

test('Tomar: ServiceDesk rechaza el pick up -> avisa del error y el ticket sigue pendiente', async () => {
  const sdp = sdpFalso(metodo => metodo === 'PUT'
    ? { status: 403, cuerpo: { response_status: { status_code: 4000, status: 'failed', messages: [{ message: 'Sin permiso' }] } } }
    : { status: 200, cuerpo: ticketJson('104900', null) });
  m._setSesion(sdp, CABECERAS);
  const st = estado({ 104900: pendiente() });

  await m.procesarUpdate(st, boton('pick:104900'), CHAT);

  assert.ok(st.pending['104900'], 'debe seguir pendiente');
  const avisos = enviados('sendMessage');
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].text, /No pude tomar el ticket #104900: ServiceDesk respondió 403 Sin permiso/);
  assert.equal(enviados('editMessageText').length, 0);
  assert.equal(enviados('deleteMessage').length, 0);
});

test('Tomar: el PUT da error pero el ticket quedó asignado -> se cierra avisando de la duda', async () => {
  const sdp = sdpFalso((metodo, ruta, n) => {
    if (metodo === 'PUT') throw new Error('Timeout 20000ms exceeded');
    return { status: 200, cuerpo: ticketJson('104900', n === 1 ? null : 'Ana Técnica') };
  });
  m._setSesion(sdp, CABECERAS);
  const st = estado({ 104900: pendiente() });

  await m.procesarUpdate(st, boton('pick:104900'), CHAT);

  assert.deepEqual(st.pending, {});
  assert.match(enviados('editMessageText')[0].text, /quedó asignado a Ana Técnica.*Timeout/);
});

test('Tomar: el PUT responde bien pero el ticket sigue sin técnico -> error, sigue pendiente', async () => {
  const sdp = sdpFalso(metodo => metodo === 'PUT'
    ? { status: 200, cuerpo: { response_status: OK } }
    : { status: 200, cuerpo: ticketJson('104900', null) });
  m._setSesion(sdp, CABECERAS);
  const st = estado({ 104900: pendiente() });

  await m.procesarUpdate(st, boton('pick:104900'), CHAT);

  assert.ok(st.pending['104900']);
  assert.match(enviados('sendMessage')[0].text, /sigue sin técnico/);
});

test('Tomar: sesión expirada (redirige al login con HTML) -> mensaje claro, sin PUT', async () => {
  const sdp = sdpFalso(() => ({ status: 200, cuerpo: '<html>login</html>', url: 'https://accounts.zoho.example/signin' }));
  m._setSesion(sdp, CABECERAS);
  const st = estado({ 104900: pendiente() });

  await m.procesarUpdate(st, boton('pick:104900'), CHAT);

  assert.deepEqual(sdp.llamadas.map(l => l.method), ['GET']);
  assert.ok(st.pending['104900']);
  assert.match(enviados('sendMessage')[0].text, /sesión expirada/);
});

test('Tomar: sin navegador activo o sin cabeceras aún -> error explicativo', async () => {
  const st = estado({ 104900: pendiente() });
  await assert.rejects(m.tomarTicket(st, '104900'), /no hay sesión activa/);
  m._setSesion(sdpFalso(() => ({ status: 200, cuerpo: {} })), null);
  await assert.rejects(m.tomarTicket(st, '104900'), /todavía no he terminado de cargar/);
});

test('Tomar: sin ID interno, o si el ID interno es de otro ticket, no toca nada', async () => {
  const sdp = sdpFalso(() => ({ status: 200, cuerpo: ticketJson('999999', null) }));
  m._setSesion(sdp, CABECERAS);

  const sinRow = estado({ 104900: pendiente({ rowId: undefined }) });
  await assert.rejects(m.tomarTicket(sinRow, '104900'), /aún no tengo el ID interno/);
  assert.equal(sdp.llamadas.length, 0);

  const otro = estado({ 104900: pendiente() });
  await assert.rejects(m.tomarTicket(otro, '104900'), /no corresponde a este ticket/);
  assert.deepEqual(sdp.llamadas.map(l => l.method), ['GET']);
});

test('Tomar: ticket que ya no está pendiente -> solo responde al botón', async () => {
  const sdp = sdpFalso(() => ({ status: 200, cuerpo: ticketJson('104900', null) }));
  m._setSesion(sdp, CABECERAS);
  const st = estado({});

  await m.procesarUpdate(st, boton('pick:104900'), CHAT);

  assert.equal(sdp.llamadas.length, 0);
  assert.match(enviados('answerCallbackQuery')[0].text, /ya no está pendiente/);
});

test('Tomar: datos de botón manipulados no llegan a ServiceDesk', async () => {
  const sdp = sdpFalso(() => ({ status: 200, cuerpo: ticketJson('104900', null) }));
  m._setSesion(sdp, CABECERAS);
  const st = estado({ 104900: pendiente() });

  await m.procesarUpdate(st, boton('pick:../../admin'), CHAT);
  await m.procesarUpdate(st, boton('pick:'), CHAT);

  assert.equal(sdp.llamadas.length, 0);
  assert.ok(st.pending['104900']);
});

/* ---------- Botones y comandos ---------- */

test('Se ignoran botones y comandos de otros chats', async () => {
  const sdp = sdpFalso(() => ({ status: 200, cuerpo: ticketJson('104900', null) }));
  m._setSesion(sdp, CABECERAS);
  const st = estado({ 104900: pendiente() });

  await m.procesarUpdate(st, boton('pick:104900', '222'), CHAT);
  await m.procesarUpdate(st, boton('ack:104900', '222'), CHAT);
  await m.procesarUpdate(st, { update_id: 2, message: { chat: { id: 222 }, text: '/enterado' } }, CHAT);

  assert.equal(sdp.llamadas.length, 0);
  assert.equal(telegram.length, 0);
  assert.ok(st.pending['104900']);
});

test('Enterado: cierra el pendiente y borra los recordatorios (incluido el formato antiguo)', async () => {
  const st = estado({ 104900: pendiente({ msgsRec: [501], msgRec: 777 }) });

  await m.procesarUpdate(st, boton('ack:104900'), CHAT);

  assert.deepEqual(st.pending, {});
  assert.deepEqual(enviados('deleteMessage').map(c => c.message_id), [501, 777]);
  assert.match(enviados('answerCallbackQuery')[0].text, /Enterado/);
});

test('/enterado y /pendientes', async () => {
  const st = estado({ 104900: pendiente(), 104901: pendiente({ msgId: 600, msgsRec: [] }) });

  await m.procesarUpdate(st, { update_id: 1, message: { chat: { id: 111 }, text: '/pendientes' } }, CHAT);
  assert.match(enviados('sendMessage')[0].text, /Pendientes: #104900, #104901/);

  await m.procesarUpdate(st, { update_id: 2, message: { chat: { id: 111 }, text: '/enterado' } }, CHAT);
  assert.deepEqual(st.pending, {});
  assert.match(enviados('sendMessage')[1].text, /Confirmados: #104900, #104901/);
});

/* ---------- Avisos y recordatorios ---------- */

test('Aviso nuevo: lleva los dos botones y guarda el ID interno', async () => {
  const st = estado({});
  await m.avisarTicket(st, '104900', '9001');

  const msg = enviados('sendMessage')[0];
  assert.deepEqual(msg.reply_markup.inline_keyboard[0].map(b => b.callback_data), ['pick:104900', 'ack:104900']);
  assert.equal(st.pending['104900'].rowId, '9001');
  assert.ok(st.seen.includes('104900'));
});

test('Aviso nuevo: si Telegram falla no se marca como visto (se reintenta en la siguiente revisión)', async () => {
  telegramFalla = () => true;
  const st = estado({});
  await assert.rejects(m.avisarTicket(st, '104900', '9001'));
  assert.deepEqual(st.seen, []);
  assert.deepEqual(st.pending, {});
});

test('Recordatorios: solo los vencidos, y se acumulan sin borrar los anteriores', async () => {
  const hace = min => Date.now() - min * 60000;
  const st = estado({
    104900: pendiente({ ultimoAviso: hace(2), msgsRec: [501] }),
    104901: pendiente({ ultimoAviso: hace(0.2), msgsRec: [] }),
  });

  await m.enviarRecordatorios(st);

  const msgs = enviados('sendMessage');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /Recordatorio #1: el ticket #104900/);
  assert.equal(st.pending['104900'].msgsRec.length, 2);
  assert.equal(st.pending['104900'].avisos, 2);
  assert.equal(enviados('deleteMessage').length, 0);
  assert.deepEqual(st.pending['104901'].msgsRec, []);
});

/* ---------- Estado ---------- */

test('Estado: se guarda sin dejar temporales y un archivo corrupto no rompe el arranque', () => {
  const st = estado({ 104900: pendiente() });
  st.seen = Array.from({ length: 600 }, (_, i) => String(100000 + i));
  m.saveState(st);

  assert.equal(fs.existsSync(`${STATE_FILE}.tmp`), false);
  const leido = m.loadState();
  assert.equal(leido.seen.length, 500);
  assert.ok(leido.pending['104900']);

  fs.writeFileSync(STATE_FILE, '{"seen":["1');
  assert.deepEqual(m.loadState(), { seen: [], pending: {}, offset: 0, lastErrorAlert: 0 });
});

/* ---------- Lectura de la bandeja ---------- */

const ACCESOS = [
  { nombre: 'Unassigned Requests', id: '7005' },
  { nombre: 'My Pending Requests', id: '7026' },
  { nombre: 'Service Desk L1', id: 'tech_group_filter-Service Desk L1' },
];

const paginaFalsa = (accesos = ACCESOS, url = `${SDP}/app/itdesk/ui/requests`) => ({
  goto: async () => {},
  url: () => url,
  waitForSelector: async () => {},
  waitForTimeout: async () => {},
  $$eval: async () => accesos,
});

const tk = (id, displayId, grupo) => ({ id, display_id: displayId, group: grupo ? { name: grupo } : null, technician: null });

// Devuelve un ServiceDesk simulado que sirve la lista paginada y anota los filtros pedidos
function sdpLista(tickets) {
  const pedidos = [];
  const sdp = sdpFalso((metodo, ruta) => {
    const entrada = JSON.parse(decodeURIComponent(ruta.split('input_data=')[1])).list_info;
    pedidos.push(entrada);
    const desde = entrada.start_index - 1;
    const trozo = tickets.slice(desde, desde + entrada.row_count);
    return {
      status: 200,
      cuerpo: { requests: trozo, response_status: [OK], list_info: { has_more_rows: desde + trozo.length < tickets.length } },
    };
  });
  return { sdp, pedidos };
}

test('Vista: pide siempre "Unassigned Requests" por su ID y separa sin grupo de asignados', async () => {
  const { sdp, pedidos } = sdpLista([
    tk('9001', '104900', null),
    tk('9002', '104901', 'Service Desk L1'),
    tk('9003', 104902, null),            // display_id numérico
    tk(null, '104903', null),            // sin ID interno: se avisa, pero no se podrá tomar
    tk('9005', '', null),                // sin ID visible: se ignora
  ]);
  m._setSesion(sdp, CABECERAS);

  const r = await m.revisar(paginaFalsa());

  assert.deepEqual(pedidos[0].filter_by, { id: '7005' });
  assert.equal(sdp.llamadas[0].method, 'GET');
  assert.deepEqual(r.sinGrupo, ['104900', '104902', '104903']);
  assert.deepEqual([...r.asignados], ['104901']);
  assert.deepEqual(r.internos, { 104900: '9001', 104901: '9002', 104902: '9003' });
});

test('Vista: una vista vacía no es un error', async () => {
  const { sdp } = sdpLista([]);
  m._setSesion(sdp, CABECERAS);
  const r = await m.revisar(paginaFalsa());
  assert.deepEqual(r, { sinGrupo: [], asignados: new Set(), internos: {} });
});

test('Vista: recorre todas las páginas', async () => {
  const muchos = Array.from({ length: 230 }, (_, i) => tk(String(9000 + i), String(100000 + i), i % 2 ? 'G' : null));
  const { sdp, pedidos } = sdpLista(muchos);
  m._setSesion(sdp, CABECERAS);

  const r = await m.revisar(paginaFalsa());

  assert.deepEqual(pedidos.map(p => p.start_index), [1, 101, 201]);
  assert.equal(r.sinGrupo.length + r.asignados.size, 230);
});

test('Vista: SDP_VIEW_ID tiene prioridad y no necesita los accesos rápidos', async () => {
  const { sdp, pedidos } = sdpLista([tk('9001', '104900', null)]);
  m._setSesion(sdp, CABECERAS);
  await m.revisar(paginaFalsa([]), { vistaNombre: 'Unassigned Requests', vistaId: '4242' });
  assert.deepEqual(pedidos[0].filter_by, { id: '4242' });
});

test('Vista: si no encuentra la vista falla con un mensaje claro y no pide tickets', async () => {
  const { sdp } = sdpLista([tk('9001', '104900', null)]);
  m._setSesion(sdp, CABECERAS);
  await assert.rejects(
    m.revisar(paginaFalsa(), { vistaNombre: 'Vista Que No Existe', vistaId: '' }),
    /No encontré la vista "Vista Que No Existe".*Unassigned Requests.*SDP_VIEW_ID/
  );
  // Un acceso rápido de grupo (ID no numérico) no vale como vista
  await assert.rejects(m.revisar(paginaFalsa(), { vistaNombre: 'Service Desk L1', vistaId: '' }), /No encontré la vista/);
  assert.equal(sdp.llamadas.length, 0);
});

test('Vista: sesión expirada, y errores de la API que no deben pasar por "sin tickets"', async () => {
  m._setSesion(sdpLista([]).sdp, CABECERAS);
  assert.equal(await m.revisar(paginaFalsa(ACCESOS, 'https://accounts.zoho.example/signin')), 'EXPIRADA');

  m._setSesion(sdpFalso(() => ({ status: 200, cuerpo: { response_status: [OK] } })), CABECERAS);
  await assert.rejects(m.revisar(paginaFalsa()), /no devolvió la lista/);

  m._setSesion(sdpFalso(() => ({ status: 500, cuerpo: { response_status: { status_code: 5000, status: 'failed' } } })), CABECERAS);
  await assert.rejects(m.revisar(paginaFalsa()), /respondió 500/);
});

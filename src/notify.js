// src/notify.js
// Comunicación con la Bot API de Telegram.
require('./config'); // asegura que el .env esté cargado

function credenciales() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en el .env');
  }
  return { token, chatId };
}

const chatId = () => credenciales().chatId;

// Llamada genérica a la Bot API (sendMessage, getUpdates, deleteMessage, ...)
async function tg(metodo, cuerpo = {}) {
  const { token } = credenciales();
  const res = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${metodo}: ${res.status} ${data.description || ''}`);
  }
  return data.result;
}

// Envía un mensaje a tu chat y devuelve su message_id
async function enviarTelegram(texto, opciones = {}) {
  const r = await tg('sendMessage', {
    chat_id: chatId(),
    text: texto,
    disable_web_page_preview: true,
    ...opciones,
  });
  return r.message_id;
}

module.exports = { enviarTelegram, tg, chatId };

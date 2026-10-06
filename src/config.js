// src/config.js
// Carga el .env y centraliza rutas y constantes para todo el proyecto.
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const SDP_BASE_URL = (process.env.SDP_BASE_URL || '').trim().replace(/\/+$/, '');
if (!/^https:\/\/.+/.test(SDP_BASE_URL)) {
  throw new Error(
    'Falta SDP_BASE_URL en el .env (ej. https://tu-empresa.sdpondemand.manageengine.com)'
  );
}

// Todo lo que contiene sesión o estado vive en data/ (ignorado por Git)
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const numero = (valor, porDefecto) => {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
};

module.exports = {
  SDP_BASE_URL,
  APP_URL: `${SDP_BASE_URL}/app/`,
  BANDEJA_URL: `${SDP_BASE_URL}/app/itdesk/ui/requests`,

  PERFIL_DIR: path.join(DATA_DIR, 'perfil'),
  AUTH_FILE: path.join(DATA_DIR, 'auth.json'),
  STATE_FILE: path.join(DATA_DIR, 'state.json'),

  INTERVALO_MS: numero(process.env.POLL_SECONDS, 60) * 1000,
  REMINDER_MIN: numero(process.env.REMINDER_MINUTES, 2),
  ERROR_COOLDOWN_MS: 60 * 60 * 1000,   // avisos de error: máximo 1 por hora
  SESION_COOLDOWN_MS: 10 * 60 * 1000,  // aviso de sesión expirada: cada 10 min
  AUSENCIAS_PARA_CERRAR: 3,            // revisiones sin ver un ticket pendiente antes de cerrarlo

  // Por defecto NO es headless: Zoho rechaza la sesión en modo sin ventana.
  HEADLESS: process.env.HEADLESS === 'true',
};

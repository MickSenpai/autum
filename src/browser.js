// src/browser.js
// Manejo del navegador (Playwright) y de la sesión guardada.
const fs = require('fs');
const { chromium } = require('playwright');
const { PERFIL_DIR, AUTH_FILE } = require('./config');

async function abrirContexto({ headless, fueraDePantalla = false }) {
  const args = ['--disable-blink-features=AutomationControlled'];
  if (fueraDePantalla) {
    // Ventana real, pero colocada fuera del área visible del monitor
    args.push('--window-position=-2400,-2400', '--window-size=1366,768');
  }

  const opciones = {
    headless,
    viewport: { width: 1366, height: 768 },
    args,
  };

  try {
    return await chromium.launchPersistentContext(PERFIL_DIR, { ...opciones, channel: 'chromium' });
  } catch (e) {
    console.error('channel "chromium" no disponible, usando modo por defecto:', e.message.split('\n')[0]);
    return await chromium.launchPersistentContext(PERFIL_DIR, opciones);
  }
}

// Las cookies de sesión (sin expiración) no sobreviven al cerrar un perfil
// persistente, así que se reinyectan desde auth.json.
async function cargarCookies(context) {
  if (!fs.existsSync(AUTH_FILE)) return;
  try {
    const { cookies } = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (cookies && cookies.length) await context.addCookies(cookies);
  } catch (e) {
    console.error('No pude leer auth.json:', e.message);
  }
}

async function guardarSesion(context) {
  await context.storageState({ path: AUTH_FILE });
}

module.exports = { abrirContexto, cargarCookies, guardarSesion };

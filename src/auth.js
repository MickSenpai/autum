// src/auth.js
// Abre una ventana para iniciar sesión a mano y guarda la sesión.
const { abrirContexto, guardarSesion } = require('./browser');
const { BANDEJA_URL } = require('./config');

async function atraparSesion() {
  console.log('Abriendo navegador... Inicia sesión manualmente (tienes 5 minutos).');

  let context;
  try {
    context = await abrirContexto({ headless: false });
    const page = context.pages()[0] || await context.newPage();

    await page.goto(BANDEJA_URL, { waitUntil: 'domcontentloaded' });
    console.log('Esperando a que llegues a la bandeja de tickets...');

    await page.waitForURL(`${BANDEJA_URL}*`, { timeout: 300000 });
    await page.waitForSelector('table tbody tr td', { timeout: 60000 });
    await page.waitForTimeout(2000);

    await guardarSesion(context);
    console.log('¡Listo! Sesión guardada (perfil + auth.json).');
  } catch (e) {
    console.error('No se detectó la bandeja a tiempo. Intenta de nuevo.');
    console.error('Detalle:', e.message);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
  }
}

atraparSesion();

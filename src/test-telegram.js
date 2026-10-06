// src/test-telegram.js
// Envía un mensaje de prueba para verificar el token y el chat ID.
const { enviarTelegram } = require('./notify');

enviarTelegram('Prueba ✅ Autum está conectado a Telegram')
  .then(() => console.log('Mensaje enviado. Revisa tu Telegram.'))
  .catch(e => {
    console.error('Falló el envío:', e.message);
    process.exitCode = 1;
  });

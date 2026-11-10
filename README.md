# Autum

**Automated Ticket Utility Manager.** Monitor de tickets sin asignar para **ManageEngine ServiceDesk Plus Cloud**. Cuando entra un ticket nuevo sin grupo, te avisa por **Telegram**, te deja **tomarlo (pick up) con un botón** y te lo **sigue recordando hasta que lo tomes o confirmes "Enterado"**, para que ninguno se pierda, ni siquiera de madrugada.

> Proyecto independiente, sin relación con ManageEngine, Zoho ni Telegram. Úsalo solo si tu organización permite este tipo de automatización sobre su mesa de ayuda.

## La idea

En una mesa de ayuda, un ticket sin grupo asignado es un ticket que nadie ha visto. Las notificaciones normales se pierden fácilmente: llegan una vez, se silencian o se entierran en el correo.

Autum resuelve eso con cuatro piezas:

1. **Detectar**: un navegador (Playwright) revisa cada minuto, con tu propia sesión, una vista fija de la bandeja (por defecto *Unassigned Requests*).
2. **Avisar**: si en esa vista hay un ticket sin grupo, manda un mensaje a Telegram con los botones **🙋 Tomar** y **✅ Enterado**.
3. **Insistir**: repite el aviso cada pocos minutos hasta que pulses un botón. Se detiene solo si el ticket recibe grupo o desaparece de la vista.
4. **Tomar**: con **🙋 Tomar**, Autum hace el pick up del ticket a tu nombre sin que abras ServiceDesk.

```mermaid
flowchart LR
  A["Vista Unassigned Requests"] -->|"Playwright, cada 60 s"| B{"Ticket sin grupo"}
  B -->|"nuevo"| C["Aviso en Telegram con botones Tomar y Enterado"]
  C --> D["Recordatorios cada N min"]
  D -->|"Tomar"| F["Pick up a tu nombre"]
  F --> E["Cerrado"]
  D -->|"Enterado o /enterado"| E
  D -->|"recibe grupo o desaparece"| E
```

## Requisitos

- Node.js 18 o superior
- Una cuenta con acceso a la bandeja de solicitudes de ServiceDesk Plus Cloud
- Un bot de Telegram (créalo con [@BotFather](https://t.me/BotFather))
- Un equipo que se mantenga encendido y sin suspender mientras corre

## Instalación

```bash
git clone https://github.com/<tu-usuario>/autum.git
cd autum
npm install
npm run setup        # descarga el Chromium de Playwright
cp .env.example .env # en Windows PowerShell: Copy-Item .env.example .env
```

Edita `.env` con tus datos:

| Variable | Descripción |
|---|---|
| `SDP_BASE_URL` | URL de tu ServiceDesk Plus, sin barra final |
| `TELEGRAM_BOT_TOKEN` | Token que te da @BotFather |
| `TELEGRAM_CHAT_ID` | Tu chat ID numérico |
| `POLL_SECONDS` | (opcional) Cada cuánto revisar la bandeja. Por defecto 60 |
| `REMINDER_MINUTES` | (opcional) Cada cuánto repetir el recordatorio. Por defecto 2 |
| `SDP_VIEW_NAME` | (opcional) Vista de la bandeja que se vigila. Por defecto `Unassigned Requests`. Debe estar entre los accesos rápidos de la bandeja |
| `SDP_VIEW_ID` | (opcional) ID numérico de la vista. Si lo defines, tiene prioridad y no hace falta que esté en los accesos rápidos |
| `HEADLESS` | (opcional) `false` por defecto. Ver [Notas](#notas-y-limitaciones) |

### Obtener tu chat ID

1. Escríbele cualquier mensaje a tu bot.
2. Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` en el navegador.
3. Busca `"chat":{"id": 123456789, ...}`. Ese número es tu `TELEGRAM_CHAT_ID`.

## Uso

```bash
npm run test:telegram   # verifica que el token y el chat ID funcionen
npm run auth            # abre el navegador: inicia sesión a mano (una vez)
npm start               # arranca el monitor
npm test                # pruebas automatizadas (sin red: Telegram y ServiceDesk simulados)
```

La primera vez, Autum avisará de **todos** los tickets de la vista que ya estén sin grupo. Después solo avisa los nuevos.

Autum vigila siempre la misma vista, aunque en tu navegador tengas otra seleccionada.

### Comandos de Telegram

| Acción | Efecto |
|---|---|
| Botón **🙋 Tomar** | Hace el pick up del ticket a nombre de la sesión guardada y detiene sus recordatorios |
| Botón **✅ Enterado** | Confirma ese ticket y detiene sus recordatorios, sin tocarlo en ServiceDesk |
| `/enterado` | Confirma todos los pendientes |
| `/pendientes` | Lista los tickets pendientes de confirmar |

Solo se atienden mensajes y botones del chat configurado en `TELEGRAM_CHAT_ID`.

### Cómo funciona "Tomar"

1. Autum consulta el ticket. Si ya tiene técnico, no lo toca y te dice a quién está asignado.
2. Si está libre, hace el pick up (la misma operación que el botón *Pick Up* de la web) y vuelve a consultar el ticket para confirmar que quedó asignado.
3. Si algo falla, te llega un mensaje con el motivo y el ticket **sigue pendiente**: los recordatorios continúan y puedes volver a pulsar el botón.

El pick up solo asigna el técnico; el campo *Group* no se modifica.

### Si la sesión expira

Autum te avisa por Telegram, cierra el navegador y **sigue recordándote los pendientes**. Ejecuta `npm run auth` en otra terminal y el monitor se reanuda solo al detectar la sesión nueva.

### Arrancar con Windows

En el Programador de tareas crea una tarea con el desencadenador **"Al iniciar sesión"** que ejecute `npm start` en la carpeta del proyecto. Debe correr con tu usuario con sesión iniciada, porque el navegador necesita escritorio.

## Estructura

```
autum/
├── src/
│   ├── config.js          # Carga el .env, rutas y constantes
│   ├── browser.js         # Navegador Playwright y sesión guardada
│   ├── auth.js            # Inicio de sesión manual y captura de sesión
│   ├── monitor.js         # Bucle principal, recordatorios, pick up y Telegram
│   ├── notify.js          # Cliente de la Bot API de Telegram
│   └── test-telegram.js   # Mensaje de prueba
├── test/
│   └── monitor.test.js    # Pruebas automatizadas (npm test)
├── data/                  # (se crea solo, ignorado por Git)
│   ├── perfil/            #   perfil del navegador
│   ├── auth.json          #   cookies de la sesión
│   └── state.json         #   tickets vistos y pendientes
├── .env.example
├── .gitignore
├── LICENSE
├── package.json
└── README.md
```

## Cómo funciona por dentro

- **Sesión:** `npm run auth` guarda la sesión de dos formas: en un perfil persistente de Chromium (`data/perfil/`) y en `data/auth.json`. Las cookies de sesión sin fecha de expiración no sobreviven al cerrar el perfil, por eso se reinyectan desde `auth.json` al arrancar.
- **Lectura de la vista:** en cada revisión se carga la bandeja en el navegador (mantiene viva la sesión y detecta si expiró) y los tickets se piden a la API interna (`GET /api/v3/requests`) filtrando por el ID de la vista. Ese ID se obtiene de los accesos rápidos de la bandeja a partir del nombre, o de `SDP_VIEW_ID`. Se revisan hasta 1000 tickets, del más reciente al más antiguo.
- **Tres bucles en paralelo:** revisión de la bandeja (cada `POLL_SECONDS`), recordatorios (cada 5 s comprueba cuáles vencieron) y escucha de Telegram por long polling (los botones responden casi al instante).
- **Recordatorios:** cada recordatorio queda visible en el chat (así cada uno notifica) y todos se borran al tomar o confirmar el ticket.
- **Pick up:** usa la API interna de ServiceDesk (`PUT /api/v3/requests/{id}/_pickup`) con la misma sesión del navegador y las cabeceras que envía la propia página.
- **Estado:** `data/state.json` guarda tickets vistos y pendientes, así que un reinicio no pierde recordatorios.

## Seguridad

- `.env` y `data/` contienen secretos y una sesión que equivale a entrar como tú **sin contraseña ni MFA**. Están en `.gitignore`; no los subas ni los compartas.
- Si el token del bot se filtra, revócalo con `/revoke` en @BotFather.
- Si sospechas que se filtró la sesión, ciérrala desde la configuración de tu cuenta de Zoho.

## Notas y limitaciones

- **Modo con ventana:** Zoho suele rechazar la sesión en navegador headless. Por eso Autum abre una ventana real, pero la coloca fuera del área visible de la pantalla. No la cierres.
- **Solo una instancia a la vez:** Telegram permite un solo consumidor de `getUpdates`. Dos monitores darán error `409`. Si el bot tiene un webhook configurado, quítalo con `deleteWebhook`.
- **No correr `auth` y el monitor a la vez** sin necesidad: comparten el perfil del navegador (con el monitor en estado "sesión expirada" sí es seguro).
- **Depende de la interfaz y de su API interna:** si ManageEngine las cambia, puede requerir ajustes.
- **Si el equipo se apaga o se suspende,** no hay avisos. Los pendientes se conservan y se retoman al volver a iniciar.
- Un ticket que llegue y se asigne en menos de un intervalo de revisión no se detecta.

## Ideas a futuro

- Usar la API v3 con OAuth de ServiceDesk Plus en lugar de scraping (más estable, requiere autorización del administrador)
- Tope de recordatorios u horarios silenciosos
- Escalamiento a llamada telefónica si nadie confirma
- Ejecutarlo como servicio de Windows

## Licencia

[MIT](LICENSE)

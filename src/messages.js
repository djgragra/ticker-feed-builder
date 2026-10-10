// Texts of the alerts (desktop notification and Telegram) in the three app languages.
const M = {
  en: {
    down: (p, f, n, err) => `Feed "${f}" (${p}) failed ${n} times in a row: ${err}`,
    up: (p, f) => `Feed "${f}" (${p}) is working again.`,
    dir: (p, dir) => `Profile "${p}": the output folder is not reachable (${dir}). The ticker files are not being updated.`,
    dirUp: (p) => `Profile "${p}": the output folder is reachable again.`,
    closeHint: 'Still running in the tray. Use the tray menu to quit.',
    paused: 'paused', withProblems: 'with problems', open: 'Open Ticker Feed Builder', runAll: 'Run all profiles now', pause: 'Pause schedules', resume: 'Resume schedules', quit: 'Quit',
    test: 'Test message: Telegram alerts are working.',
    tgIncomplete: 'Telegram is not set up: bot token and at least one chat ID are needed.',
    stale: (p, f, h) => `Feed "${f}" (${p}) has had no new stories for ${h} hours.`,
    staleUp: (p, f) => `Feed "${f}" (${p}) has new stories again.`,
    digestTitle: (when) => `Daily summary, ${when}`,
    digestProfile: (p, ok, total, last) => `${p}: ${ok}/${total} feeds OK${last ? `, last file update ${last}` : ''}`,
    digestProblem: (f, err) => `  ✗ ${f}: ${err}`,
    digestStale: (f, h) => `  ⏸ ${f}: no new stories for ${h} h`,
    digestAllOk: 'Everything is working.',
    digestDisabled: 'disabled',
    update: (v, cur, url) => `A new version of Ticker Feed Builder is available: ${v} (installed: ${cur}). ${url}`,
    emailIncomplete: 'Email is not set up: an SMTP server, a sender and at least one valid recipient are needed.',
    emailFailed: 'Email: ',
    tgFailed: 'Telegram: '
  },
  it: {
    down: (p, f, n, err) => `Feed "${f}" (${p}) fallito ${n} volte di fila: ${err}`,
    up: (p, f) => `Feed "${f}" (${p}) di nuovo funzionante.`,
    dir: (p, dir) => `Profilo "${p}": la cartella di output non è raggiungibile (${dir}). I file del ticker non vengono aggiornati.`,
    dirUp: (p) => `Profilo "${p}": la cartella di output è di nuovo raggiungibile.`,
    closeHint: 'Continua a funzionare nella barra di sistema. Per chiuderlo usa il menu dell\'icona.',
    paused: 'in pausa', withProblems: 'con problemi', open: 'Apri Ticker Feed Builder', runAll: 'Esegui ora tutti i profili', pause: 'Metti in pausa', resume: 'Riprendi', quit: 'Esci',
    test: 'Messaggio di prova: gli avvisi Telegram funzionano.',
    tgIncomplete: 'Telegram non è configurato: servono il token del bot e almeno un chat ID.',
    stale: (p, f, h) => `Il feed "${f}" (${p}) non ha notizie nuove da ${h} ore.`,
    staleUp: (p, f) => `Il feed "${f}" (${p}) ha di nuovo notizie nuove.`,
    digestTitle: (when) => `Riepilogo giornaliero, ${when}`,
    digestProfile: (p, ok, total, last) => `${p}: ${ok}/${total} feed OK${last ? `, ultimo aggiornamento file ${last}` : ''}`,
    digestProblem: (f, err) => `  ✗ ${f}: ${err}`,
    digestStale: (f, h) => `  ⏸ ${f}: nessuna notizia nuova da ${h} h`,
    digestAllOk: 'Tutto funziona.',
    digestDisabled: 'disattivato',
    update: (v, cur, url) => `È disponibile una nuova versione di Ticker Feed Builder: ${v} (installata: ${cur}). ${url}`,
    emailIncomplete: 'L\'email non è configurata: servono un server SMTP, un mittente e almeno un destinatario valido.',
    emailFailed: 'Email: ',
    tgFailed: 'Telegram: '
  },
  es: {
    down: (p, f, n, err) => `Feed "${f}" (${p}) falló ${n} veces seguidas: ${err}`,
    up: (p, f) => `El feed "${f}" (${p}) vuelve a funcionar.`,
    dir: (p, dir) => `Perfil "${p}": la carpeta de salida no es accesible (${dir}). Los archivos del ticker no se actualizan.`,
    dirUp: (p) => `Perfil "${p}": la carpeta de salida vuelve a ser accesible.`,
    closeHint: 'Sigue funcionando en la bandeja. Para salir usa el menú del icono.',
    paused: 'en pausa', withProblems: 'con problemas', open: 'Abrir Ticker Feed Builder', runAll: 'Ejecutar todos los perfiles ahora', pause: 'Pausar', resume: 'Reanudar', quit: 'Salir',
    test: 'Mensaje de prueba: las alertas de Telegram funcionan.',
    tgIncomplete: 'Telegram no está configurado: hacen falta el token del bot y al menos un chat ID.',
    stale: (p, f, h) => `El feed "${f}" (${p}) no tiene noticias nuevas desde hace ${h} horas.`,
    staleUp: (p, f) => `El feed "${f}" (${p}) vuelve a tener noticias nuevas.`,
    digestTitle: (when) => `Resumen diario, ${when}`,
    digestProfile: (p, ok, total, last) => `${p}: ${ok}/${total} feeds OK${last ? `, última actualización de archivos ${last}` : ''}`,
    digestProblem: (f, err) => `  ✗ ${f}: ${err}`,
    digestStale: (f, h) => `  ⏸ ${f}: sin noticias nuevas desde hace ${h} h`,
    digestAllOk: 'Todo funciona.',
    digestDisabled: 'desactivado',
    update: (v, cur, url) => `Hay una nueva versión de Ticker Feed Builder: ${v} (instalada: ${cur}). ${url}`,
    emailIncomplete: 'El correo no está configurado: hacen falta un servidor SMTP, un remitente y al menos un destinatario válido.',
    emailFailed: 'Correo: ',
    tgFailed: 'Telegram: '
  }
};
export const msg = (lang, key, ...args) => {
  const v = (M[lang] || M.en)[key];
  return typeof v === 'function' ? v(...args) : v;
};

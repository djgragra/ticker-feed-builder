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
    tgFailed: 'Telegram: '
  }
};
export const msg = (lang, key, ...args) => {
  const v = (M[lang] || M.en)[key];
  return typeof v === 'function' ? v(...args) : v;
};

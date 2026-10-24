# Manuale di Ticker Feed Builder

Ticker Feed Builder scarica feed RSS a orari stabiliti e trasforma ognuno in righe di testo numerate e immagini JPG per ticker TV e grafiche di playout. Vive nella tray di sistema e gira giorno e notte. È un'app desktop gratuita per Windows, macOS e Linux di OnAir Garage.

## Installazione e primo avvio

Scarica l'installer per il tuo sistema dalla pagina [Releases](https://github.com/djgragra/ticker-feed-builder/releases) e controllalo con `SHA256SUMS.txt`:
`Ticker-Feed-Builder-Setup-<V>.exe` (Windows), `Ticker-Feed-Builder-<V>-arm64.dmg` (Mac con Apple silicon), `Ticker-Feed-Builder-<V>-x64.dmg` (Mac con Intel), `Ticker-Feed-Builder-<V>.AppImage` (Linux).
L'app è gratuita e non ha un certificato Apple o Microsoft, quindi al primo avvio può comparire un avviso.

- **Windows**: avvia l'installer. Se SmartScreen dice «Windows ha protetto il PC», clicca *Ulteriori informazioni* → *Esegui comunque*.
- **macOS**: apri l'immagine disco e trascina l'app in Applicazioni. L'app è firmata ad-hoc, ed è ciò che serve a un Mac Apple silicon per aprirla. Il primo avvio mostra comunque l'avviso «sviluppatore non identificato»: apri *Impostazioni di Sistema → Privacy e sicurezza*, scorri in basso e clicca *Apri comunque* (il clic destro → Apri non esiste più da macOS 15). Se una versione precedente alla 26.10.12 dice che l'app è «danneggiata», esegui una volta nel Terminale: `xattr -cr "/Applications/Ticker Feed Builder.app" && codesign --force --deep -s - "/Applications/Ticker Feed Builder.app"`
- **Linux**: rendi eseguibile l'AppImage (`chmod +x Ticker-Feed-Builder-*.AppImage`) e avviala.

L'app si apre sempre in inglese; scegli Italiano o Español e la scelta viene ricordata. Il tema è scuro per default, con chiaro e di sistema disponibili. L'app viene fornita **senza nessun feed**: aggiungi i tuoi.

## Cosa scrive

Per ogni feed di ogni profilo l'app scrive, nella cartella di output del profilo:

| File | Contenuto |
|---|---|
| `<Nome>_Title.Txt` | un titolo per riga |
| `<Nome>_Description.Txt` | una descrizione per riga, nello stesso ordine |
| `<Nome>/00001.JPG`, `00002.JPG`… | un JPG per notizia, nello stesso ordine |
| `<Nome>_metadata.json` | contatori dell'ultima esecuzione (facoltativo) |

**Garanzia di sincronia**: la notizia N è la riga N dei due file di testo e l'immagine N. Gli a capo e i caratteri invisibili dentro un testo vengono tolti; un titolo o una descrizione vuoti diventano `-` (configurabile); un'immagine mancante o illeggibile diventa l'immagine segnaposto. La struttura predefinita riproduce gli script che alimentavano un ticker dall'Utilità di pianificazione di Windows; altri sistemi di ticker possono richiedere altri nomi, codifiche o dimensioni, ed è per questo che tutto è configurabile.

**Scritture sicure**: ogni file viene scritto con un nome temporaneo e poi rinominato; i file invariati non vengono toccati; se un download fallisce i file precedenti restano com'erano; una cartella di output mancante viene segnalata e mai creata (un disco scollegato non deve diventare una cartella locale); le immagini numerate rimaste da un'esecuzione precedente più lunga vengono tolte. Dopo la scrittura i file vengono riletti: tante righe di titolo e di descrizione quante sono le notizie, ogni immagine un vero JPEG. Un controllo fallito, o un file bloccato da un player, conta come feed fallito.

## Profili e feed

Un **profilo** ha una sola destinazione: la cartella di output, i suoi feed, l'intervallo di controllo, l'immagine segnaposto e il formato di output. Usa più profili se schermi diversi leggono cartelle diverse.

1. Premi **+ Nuovo profilo**, dagli un nome e premi *Crea*.
2. Nella scheda *Feed* premi **+ Aggiungi feed**: dai al feed un *Nome (cartella)* e il suo indirizzo. Un feed può avere utente e password scritti nell'indirizzo (`utente:password@`), che vengono mascherati, con un pulsante a occhio per mostrarli.
3. Premi **Prova** sul feed: l'*Anteprima del feed* mostra le notizie esattamente come verrebbero scritte (*Come sul ticker*), le righe di titolo e di descrizione, e quali immagini ricadrebbero sul segnaposto. Non viene scritto nulla. *Mostra il feed così com'è* lo mostra senza filtri e senza limite.
4. Scegli la cartella di output, l'*Immagine segnaposto* e, in *Pianificazione e opzioni*, ogni quanto controllare.
5. Porta il profilo su **Attivo** («Controlla questo profilo con la pianificazione»). **Esegui ora** lo controlla subito.

I profili sono elencati nella colonna a sinistra; trascinali, usa i pulsanti ▲▼ o Alt + frecce, oppure premi A–Z per l'ordine alfabetico. L'ordine viene salvato e la dashboard lo segue.

## Scegliere e cambiare le notizie

Per ogni feed, in *Opzioni*:

- **Filtri**: tieni solo le notizie con certe parole, o escludine altre (maiuscole e accenti vengono ignorati; solo il titolo, oppure titolo e descrizione); *Togli le notizie con lo stesso titolo*; *Prima le più recenti* (dalla data nel feed). I filtri agiscono prima del limite di notizie. Un profilo può escludere una notizia già usata da un feed precedente.
- **Feed uniti** (*+ Aggiungi feed unito*) mettono in una sola cartella le ultime notizie di più feed, le più recenti per prime e senza doppioni.
- **Modifiche al testo**: sostituisci pezzi di testo (`cerca → sostituisci con`, uno per riga, testo semplice, le maiuscole contano), TUTTO MAIUSCOLO / minuscolo / solo la prima lettera maiuscola, un testo prima e/o dopo il titolo (per esempio `ANSA – `), e limiti propri di titolo e descrizione. Si applicano subito prima dei limiti di lunghezza, in quest'ordine: sostituzioni, maiuscole, testo prima e dopo, limite di lunghezza (con «…» a fine parola). La finestra di prova mostra il risultato.
- **Formato di output** (la scheda *Formato di output*; i valori predefiniti riproducono gli script originali): codifica del testo (UTF-8, UTF-8 con BOM, Windows-1252), fine riga, modelli dei nomi dei file (`{folder}`), numero iniziale, cifre ed estensione delle immagini, qualità JPEG, un ridimensionamento facoltativo (riempi o adatta) e i limiti di lunghezza di titolo e descrizione. Le immagini WebP e AVIF vengono convertite in JPEG (si può disattivare per profilo).

## Pianificazioni e controlli

Un profilo viene controllato in uno di tre modi, scelti in *Pianificazione e opzioni*:

- **ogni N minuti** dopo il controllo precedente;
- **ogni N minuti sull'orologio**, contati dalla mezzanotte (15 = :00 :15 :30 :45; 60 = ogni ora piena);
- **a orari fissi** nei giorni che scegli (un orario = una volta al giorno). A un orario fisso vengono controllati tutti i feed attivi, qualunque sia il loro intervallo; un orario perso mentre l'app era chiusa viene recuperato una volta all'avvio (se *Avvia le pianificazioni all'apertura dell'app* è attivo).

**Fasce orarie** (*+ Aggiungi fascia*): un profilo può essere controllato solo in certe ore e giorni (per esempio 06:00–24:00), e una fascia può avere un intervallo proprio. Fuori dalle fasce non si controlla nulla e i file restano come sono. Sfasa i profili in modo che non partano tutti nello stesso minuto.

**Come funziona un controllo**: l'app chiede prima al server se il feed è cambiato (`ETag` / `Last-Modified`; una risposta «non modificato» significa che non si scarica nulla). Se il server non sa dirlo, il feed viene scaricato e il suo contenuto confrontato con la copia precedente: contenuto uguale significa nessun download di immagini e nessun file toccato. Le immagini vengono scaricate e i file scritti solo quando c'è qualcosa di nuovo; un'immagine fallita viene riprovata al controllo successivo. Come appariva ogni feed viene ricordato tra i riavvii, quindi un feed invariato non viene ricostruito e nessuna immagine viene riscaricata.

## Dashboard

La **Dashboard** (ha un pulsante tutto suo sopra l'elenco dei profili) mostra data e ora, se le pianificazioni sono attive o in pausa (*Metti in pausa* / *Riprendi* in alto), quanti feed sono OK e quanti hanno problemi, un elenco in ordine di tempo dei **prossimi controlli** con il conto alla rovescia, l'ultimo controllo e l'ultimo aggiornamento dei file di ogni profilo e feed, gli avvisi e gli errori recenti, e per ogni feed una striscia delle **ultime 24 ore**, una barra per ora (nuove notizie, controllato senza novità, fallito, nessun controllo), conservata tra i riavvii.

## Avvisi e riepilogo

Nelle impostazioni, *Avvisi* manda una notifica sul desktop, Telegram e/o email (SMTP) quando un feed fallisce N esecuzioni di fila, quando una cartella di output scompare, e al ritorno alla normalità. Telegram ed email accettano più destinatari; **l'email parte come un solo messaggio con tutti in Bcc** (il mittente non riceve copia a meno che sia anche destinatario), e con un nome utente la connessione deve essere cifrata. *Invia prova* controlla ogni canale. Ogni avviso inizia con `[Ticker Feed Builder · nome dell'installazione]`.

- **Avviso di feed fermo**: un avviso quando un feed risponde ma non ha notizie nuove da N ore (per profilo o per feed), e di nuovo al ritorno alla normalità.
- **Riepilogo giornaliero** agli orari scelti, su Telegram e/o email.
- Password, token e credenziali dei feed restano sul computer, cifrati con il portachiavi del sistema quando è disponibile, e ne escono solo in un backup che chiedi con la casella *Includi password e token*.

## Impostazioni

Le impostazioni sono in schede: Generali, Senza finestra, Avvisi, Aggiornamenti, Backup e Aiuto e informazioni. La scheda Generali ha l'avvio con il computer, l'opzione per tenere sveglio il computer, *Avvia le pianificazioni all'apertura dell'app*, il nome di questa installazione, lingua e tema.

**Backup**: *Esporta* salva profili, feed, formati e impostazioni come `ticker-feed-builder-backup-AAAA-MM-GG.json`. La casella *Includi password e token* è spenta per default; spuntata, la password SMTP, il token Telegram e le credenziali dei feed vengono scritti in chiaro (un avviso rosso lo dice) e il file viene creato leggibile solo da te. *Importa* sostituisce tutto, oppure aggiunge solo i profili che questo computer non ha, e mantiene una password già presente sul computer quando server di posta e utente sono gli stessi; l'app elenca cosa va riscritto.

**Aiuto e informazioni** mostra la versione, il sistema, la licenza, i crediti e i link, *Copia info per assistenza* (versione, sistema, lingua, nome dell'installazione, ultimo controllo aggiornamenti ed errore: mai indirizzi, password o nomi di file) e *Apri cartella dei log* (log giornalieri, 7 giorni, fino a 5 MB ciascuno). Il riquadro mancia ha un salvadanaio e un pulsante: entrambi aprono la pagina di sostegno del sito nella lingua dell'app; dentro l'app non viene mai chiesto nulla. Dimensione e posizione della finestra vengono ricordate.

## Aggiornamenti

L'app cerca una nuova versione all'avvio e poi ogni 24 ore (puoi disattivarlo). Un avviso offre *Scarica e installa*, *Ricordamelo dopo* (24 ore) e *Salta questa versione*, con una barra di avanzamento e *Annulla*. Il file viene controllato con `SHA256SUMS.txt`. *Chiudi e installa* viene rifiutato mentre un profilo è in esecuzione, salva prima una copia di sicurezza delle impostazioni (si tengono le ultime 3) e poi avvia l'installer (Windows), apre l'immagine disco (macOS) o mostra l'AppImage (Linux). Dopo l'aggiornamento compare una volta la finestra *Novità*. Niente viene installato senza un clic.

## Modalità senza finestra

Per un server, o un computer che deve aggiornare il ticker dopo un riavvio prima che qualcuno acceda, lo stesso motore gira senza finestra (`src/cli.js`): pianificazioni, filtri, avvisi e riepilogo giornaliero funzionano, le notifiche sul desktop no. In *Impostazioni → Senza finestra* l'app mostra il comando esatto per questo computer. Legge il file delle impostazioni scritto da *Esporta*, che non contiene segreti, quindi il token Telegram e la password SMTP si passano come variabili d'ambiente. Con `--once` fa una sola esecuzione ed esce con 0 (tutti i feed a posto), 1 (qualche problema) o 2 (impostazioni inutilizzabili).

## Feed e condizioni degli editori

Un feed gratuito da scaricare non è necessariamente gratuito da trasmettere. Gli editori di solito offrono l'RSS per la lettura personale; mostrare pubblicamente i loro titoli in TV, su schermi o siti normalmente richiede un accordo con l'editore. Questa responsabilità è tua: non è una consulenza legale. Leggi le condizioni attuali dell'editore prima di fare affidamento su un feed.

## Limiti

- Le immagini vengono decodificate senza moduli nativi. Un AVIF molto grande può richiedere qualche secondo; un'immagine che non si legge riceve il segnaposto.
- Le immagini su indirizzi di rete privati (localhost, 10.x, 172.16–31.x, 192.168.x…) vengono ignorate per i feed su Internet pubblico.
- *Salta il controllo del certificato* mantiene la connessione cifrata ma non verifica il server: è spento per default e pensato solo per feed di cui ti fidi.
- Il computer deve restare acceso e sveglio. L'app chiede al sistema di non andare in sospensione (opzione), ma non può impedire una sospensione o uno spegnimento forzati.
- Se un server supporta le richieste condizionali dipende dal server; le notizie vengono prese nell'ordine del feed.

## Risoluzione dei problemi

| Problema | Cosa fare |
|---|---|
| macOS: «l'app è danneggiata / non può essere aperta» | Apri *Impostazioni di Sistema → Privacy e sicurezza → Apri comunque*; per una versione precedente alla 26.10.12, esegui nel Terminale `xattr -cr "/Applications/Ticker Feed Builder.app" && codesign --force --deep -s - "/Applications/Ticker Feed Builder.app"`. |
| Windows: «Windows ha protetto il PC» | *Ulteriori informazioni* → *Esegui comunque*. |
| Linux: l'AppImage non si avvia | Rendila eseguibile (`chmod +x`) e installa FUSE (`libfuse2`) se il tuo sistema lo richiede. |
| «cartella di output mancante» | La cartella o il disco non c'è (un disco scollegato): ricollegalo. L'app non la crea mai. |
| Un feed fallisce con un errore di certificato | Il certificato dell'editore è guasto. Se ti fidi del feed, attiva *Salta il controllo del certificato* per quel feed. |
| I file di testo e le immagini non coincidono | Coincidono sempre quando li scrive l'app; controlla che nient'altro scriva nella cartella. |
| Non arriva nessun avviso | Usa *Invia prova* nelle impostazioni degli avvisi e leggi il messaggio d'errore. |
| Il download dell'aggiornamento è fallito con «checksum mismatch» | Il file è stato eliminato automaticamente. Riprova, oppure scarica l'installer a mano dalla pagina delle release. |

## Contatti

Graziano Melzi · OnAir Garage — `https://onairgarage.com` — `hello@onairgarage.com`. Pagina dello strumento: `https://onairgarage.com/tools/ticker-feed-builder/`. Codice sorgente e release: `https://github.com/djgragra/ticker-feed-builder`. Licenza: MIT © 2026 Graziano Melzi.

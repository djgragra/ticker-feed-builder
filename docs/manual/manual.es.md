# Manual de Ticker Feed Builder

Ticker Feed Builder descarga feeds RSS a horas programadas y convierte cada uno en líneas de texto numeradas e imágenes JPG para tickers de TV y gráficos de emisión. Vive en la bandeja del sistema y funciona día y noche. Es una app de escritorio gratuita para Windows, macOS y Linux de OnAir Garage.

## Instalación y primer inicio

Descarga el instalador para tu sistema desde la página de [Releases](https://github.com/djgragra/ticker-feed-builder/releases) y compruébalo con `SHA256SUMS.txt`:
`Ticker-Feed-Builder-Setup-<V>.exe` (Windows), `Ticker-Feed-Builder-<V>-arm64.dmg` (Mac con Apple silicon), `Ticker-Feed-Builder-<V>-x64.dmg` (Mac con Intel), `Ticker-Feed-Builder-<V>.AppImage` (Linux).
La app es gratuita y no tiene certificado de Apple ni de Microsoft, así que en el primer inicio puede aparecer un aviso.

- **Windows**: ejecuta el instalador. Si SmartScreen dice «Windows protegió su PC», pulsa *Más información* → *Ejecutar de todos modos*.
- **macOS**: abre la imagen de disco y arrastra la app a Aplicaciones. La app tiene una firma ad-hoc, que es lo que necesita un Mac Apple silicon para abrirla. El primer inicio muestra igualmente el aviso «desarrollador no identificado»: abre *Ajustes del Sistema → Privacidad y seguridad*, desplázate hacia abajo y pulsa *Abrir de todos modos* (el clic derecho → Abrir ya no existe desde macOS 15). Si una versión anterior a la 26.10.12 dice que la app está «dañada», ejecuta una vez en Terminal: `xattr -cr "/Applications/Ticker Feed Builder.app" && codesign --force --deep -s - "/Applications/Ticker Feed Builder.app"`
- **Linux**: haz ejecutable el AppImage (`chmod +x Ticker-Feed-Builder-*.AppImage`) y ejecútalo.

La app se abre siempre en inglés; elige Italiano o Español y la elección se recuerda. El tema es oscuro por defecto, con claro y de sistema disponibles. La app se entrega **sin ningún feed**: añades los tuyos.

## Qué escribe

Por cada feed de cada perfil, la app escribe en la carpeta de salida del perfil:

| Archivo | Contenido |
|---|---|
| `<Nombre>_Title.Txt` | un titular por línea |
| `<Nombre>_Description.Txt` | una descripción por línea, en el mismo orden |
| `<Nombre>/00001.JPG`, `00002.JPG`… | un JPG por noticia, en el mismo orden |
| `<Nombre>_metadata.json` | contadores de la última ejecución (opcional) |

**Garantía de sincronía**: la noticia N es la línea N de los dos archivos de texto y la imagen N. Los saltos de línea y los caracteres invisibles dentro de un texto se quitan; un título o una descripción vacíos pasan a ser `-` (configurable); una imagen que falta o no se puede leer pasa a ser la imagen de relleno. La disposición por defecto reproduce los scripts que alimentaban un ticker desde el Programador de tareas de Windows; otros sistemas de ticker pueden necesitar otros nombres, codificaciones o tamaños, y por eso todo es configurable.

**Escrituras seguras**: cada archivo se escribe con un nombre temporal y después se renombra; los archivos sin cambios no se tocan; si una descarga falla, los archivos anteriores se quedan como estaban; una carpeta de salida que falta se señala y nunca se crea (un disco desconectado no debe convertirse en una carpeta local); las imágenes numeradas que quedan de una ejecución anterior más larga se quitan. Tras escribir, los archivos se vuelven a leer: tantas líneas de título y de descripción como noticias, y cada imagen un JPEG de verdad. Una comprobación fallida, o un archivo bloqueado por un reproductor, cuenta como feed fallido.

## Perfiles y feeds

Un **perfil** tiene un solo destino: la carpeta de salida, sus feeds, el intervalo de comprobación, la imagen de relleno y el formato de salida. Usa varios perfiles si pantallas distintas leen carpetas distintas.

1. Pulsa **+ Nuevo perfil**, ponle un nombre y pulsa *Crear*.
2. En la pestaña *Feeds* pulsa **+ Añadir feed**: dale al feed un *Nombre (carpeta)* y su dirección. Un feed puede llevar usuario y contraseña escritos en la dirección (`usuario:contraseña@`), que se enmascaran, con un botón de ojo para mostrarlos.
3. Pulsa **Probar** en el feed: la *Vista previa del feed* muestra las noticias exactamente como se escribirían (*Como en el ticker*), las líneas de título y de descripción, y qué imágenes caerían en la de relleno. No se escribe nada. *Mostrar el feed tal cual* lo muestra sin filtros ni límite.
4. Elige la carpeta de salida, la *Imagen de relleno* y, en *Programación y opciones*, cada cuánto comprobar.
5. Pasa el perfil a **Activo** («Comprobar este perfil según la programación»). **Ejecutar ahora** lo comprueba enseguida.

Los perfiles se enumeran en la columna de la izquierda; arrástralos, usa los botones ▲▼ o Alt + flechas, o pulsa A–Z para el orden alfabético. El orden se guarda y el panel lo sigue.

## Elegir y cambiar las noticias

Por feed, en *Opciones*:

- **Filtros**: conserva solo las noticias con ciertas palabras, o deja fuera otras (se ignoran mayúsculas y acentos; solo el título, o título y descripción); *Quitar noticias con el mismo título*; *Primero las más recientes* (por la fecha del feed). Los filtros actúan antes del límite de noticias. Un perfil puede dejar fuera una noticia ya usada por un feed anterior.
- **Feeds combinados** (*+ Añadir feed combinado*) ponen en una sola carpeta las últimas noticias de varios feeds, las más recientes primero y sin duplicados.
- **Cambios en el texto**: reemplaza trozos de texto (`buscar → reemplazar por`, uno por línea, texto simple, cuentan las mayúsculas), TODO EN MAYÚSCULAS / minúsculas / solo la primera letra en mayúscula, un texto antes y/o después del título (por ejemplo `ANSA – `), y límites propios de título y descripción. Se aplican justo antes de los límites de longitud, en este orden: reemplazos, mayúsculas, texto antes y después, límite de longitud (con «…» al final de una palabra). La ventana de prueba muestra el resultado.
- **Formato de salida** (la pestaña *Formato de salida*; los valores por defecto reproducen los scripts originales): codificación del texto (UTF-8, UTF-8 con BOM, Windows-1252), fin de línea, plantillas de los nombres de archivo (`{folder}`), número inicial, cifras y extensión de las imágenes, calidad JPEG, un cambio de tamaño opcional (rellenar o ajustar) y los límites de longitud de título y descripción. Las imágenes WebP y AVIF se convierten a JPEG (se puede desactivar por perfil).

## Programaciones y comprobaciones

Un perfil se comprueba de una de tres maneras, elegidas en *Programación y opciones*:

- **cada N minutos** después de la comprobación anterior;
- **cada N minutos en punto del reloj**, contados desde la medianoche (15 = :00 :15 :30 :45; 60 = cada hora en punto);
- **a horas fijas** en los días que elijas (una hora = una vez al día). A una hora fija se comprueban todos los feeds activos, sea cual sea su propio intervalo; una hora perdida mientras la app estaba cerrada se recupera una vez al iniciar (si *Iniciar las programaciones al abrir la app* está activado).

**Franjas horarias** (*+ Añadir franja*): un perfil puede comprobarse solo en ciertas horas y días (por ejemplo 06:00–24:00), y una franja puede tener su propio intervalo. Fuera de las franjas no se comprueba nada y los archivos se quedan como están. Escalona los perfiles para que no arranquen todos en el mismo minuto.

**Cómo funciona una comprobación**: la app pregunta primero al servidor si el feed ha cambiado (`ETag` / `Last-Modified`; una respuesta de «no modificado» significa que no se descarga nada). Si el servidor no puede decirlo, se descarga el feed y se compara su contenido con la copia anterior: el mismo contenido significa ninguna descarga de imágenes y ningún archivo tocado. Las imágenes se descargan y los archivos se escriben solo cuando hay algo nuevo; una imagen fallida se reintenta en la siguiente comprobación. Cómo era cada feed se recuerda entre reinicios, así que un feed sin cambios no se reconstruye y no se vuelve a descargar ninguna imagen.

## Panel

El **Panel** (tiene un botón propio sobre la lista de perfiles) muestra la fecha y la hora, si las programaciones están activas o en pausa (*Pausar* / *Reanudar* arriba), cuántos feeds están OK y cuántos tienen problemas, una lista ordenada por tiempo de las **próximas comprobaciones** con cuenta atrás, la última comprobación y la última actualización de archivos de cada perfil y feed, los avisos y errores recientes, y para cada feed una franja de las **últimas 24 horas**, una barra por hora (noticias nuevas, comprobado sin novedad, fallido, sin comprobación), conservada entre reinicios.

## Alertas y resumen

En los ajustes, *Alertas* envía una notificación de escritorio, Telegram y/o correo (SMTP) cuando un feed falla N ejecuciones seguidas, cuando desaparece una carpeta de salida, y al volver a la normalidad. Telegram y correo admiten varios destinatarios; **el correo sale como un solo mensaje con todos en copia oculta (Bcc)** (el remitente no recibe copia salvo que también sea destinatario), y con un nombre de usuario la conexión debe estar cifrada. *Enviar prueba* comprueba cada canal. Cada alerta empieza por `[Ticker Feed Builder · nombre de la instalación]`.

- **Alerta de feed parado**: una alerta cuando un feed responde pero no tiene noticias nuevas desde hace N horas (por perfil o por feed), y otra al volver a la normalidad.
- **Resumen diario** a las horas elegidas, por Telegram y/o correo.
- Las contraseñas, los tokens y las credenciales de los feeds se quedan en el equipo, cifrados con el llavero del sistema cuando está disponible, y solo salen en una copia de seguridad que pides con la casilla *Incluir contraseñas y tokens*.

## Ajustes

Los ajustes están en pestañas: General, Modo sin ventana, Alertas, Actualizaciones, Copia de seguridad y Ayuda e información. La pestaña General tiene el inicio con el equipo, la opción de mantener el equipo despierto, *Iniciar las programaciones al abrir la app*, el nombre de esta instalación, idioma y tema.

**Copia de seguridad**: *Exportar* guarda perfiles, feeds, formatos y ajustes como `ticker-feed-builder-backup-AAAA-MM-DD.json`. La casilla *Incluir contraseñas y tokens* está desactivada por defecto; marcada, la contraseña SMTP, el token de Telegram y las credenciales de los feeds se escriben en texto sin formato (un aviso rojo lo dice) y el archivo se crea legible solo por ti. *Importar* sustituye todo, o añade solo los perfiles que este equipo no tiene, y mantiene una contraseña que ya está en el equipo cuando el servidor de correo y el usuario son los mismos; la app enumera lo que hay que volver a escribir.

**Ayuda e información** muestra la versión, el sistema, la licencia, los créditos y los enlaces, *Copiar info para asistencia* (versión, sistema, idioma, nombre de la instalación, última comprobación de actualizaciones y error: nunca direcciones, contraseñas ni nombres de archivo) y *Abrir carpeta de registros* (registros diarios, 7 días, hasta 5 MB cada uno). La tarjeta de propina tiene una hucha y un botón: ambos abren la página de apoyo del sitio web en el idioma de la app; dentro de la app no se pide nunca nada. El tamaño y la posición de la ventana se recuerdan.

## Actualizaciones

La app busca una versión nueva al iniciarse y luego cada 24 horas (se puede desactivar). Un aviso ofrece *Descargar e instalar*, *Recordármelo más tarde* (24 horas) y *Omitir esta versión*, con una barra de progreso y *Cancelar*. El archivo se comprueba con `SHA256SUMS.txt`. *Cerrar e instalar* se rechaza mientras un perfil está en ejecución, guarda antes una copia de seguridad de los ajustes (se conservan las últimas 3) y después inicia el instalador (Windows), abre la imagen de disco (macOS) o muestra el AppImage (Linux). Tras la actualización aparece una vez la ventana *Novedades*. No se instala nada sin un clic.

## Modo sin ventana

Para un servidor, o un equipo que debe actualizar el ticker tras un reinicio antes de que nadie inicie sesión, el mismo motor funciona sin ventana (`src/cli.js`): las programaciones, los filtros, las alertas y el resumen diario funcionan, las notificaciones de escritorio no. En *Ajustes → Modo sin ventana* la app muestra el comando exacto para este equipo. Lee el archivo de ajustes escrito por *Exportar*, que no contiene secretos, así que el token de Telegram y la contraseña SMTP se pasan como variables de entorno. Con `--once` hace una sola ejecución y sale con 0 (todos los feeds bien), 1 (algún problema) o 2 (ajustes inutilizables).

## Feeds y condiciones de los editores

Un feed gratuito de descargar no es necesariamente gratuito de emitir. Los editores suelen ofrecer el RSS para la lectura personal; mostrar públicamente sus titulares en TV, pantallas o sitios web normalmente requiere un acuerdo con el editor. Esa responsabilidad es tuya: esto no es asesoramiento legal. Lee las condiciones actuales del editor antes de confiar en un feed.

## Límites

- Las imágenes se decodifican sin módulos nativos. Un AVIF muy grande puede tardar unos segundos; una imagen que no se puede leer recibe la de relleno.
- Las imágenes en direcciones de red privadas (localhost, 10.x, 172.16–31.x, 192.168.x…) se ignoran en los feeds de Internet público.
- *Omitir la comprobación del certificado* mantiene la conexión cifrada pero no verifica el servidor: está desactivado por defecto y pensado solo para feeds de confianza.
- El equipo debe seguir encendido y despierto. La app pide al sistema que no se suspenda (opción), pero no puede impedir una suspensión o un apagado forzados.
- Que un servidor admita peticiones condicionales depende del servidor; las noticias se toman en el orden del feed.

## Solución de problemas

| Problema | Qué hacer |
|---|---|
| macOS: «la app está dañada / no se puede abrir» | Abre *Ajustes del Sistema → Privacidad y seguridad → Abrir de todos modos*; para una versión anterior a la 26.10.12, ejecuta en Terminal `xattr -cr "/Applications/Ticker Feed Builder.app" && codesign --force --deep -s - "/Applications/Ticker Feed Builder.app"`. |
| Windows: «Windows protegió su PC» | *Más información* → *Ejecutar de todos modos*. |
| Linux: el AppImage no se inicia | Hazlo ejecutable (`chmod +x`) e instala FUSE (`libfuse2`) si tu sistema lo necesita. |
| «falta la carpeta de salida» | La carpeta o el disco no está (un disco desconectado): vuelve a conectarlo. La app no la crea nunca. |
| Un feed falla con un error de certificado | El certificado del editor está roto. Si confías en el feed, activa *Omitir la comprobación del certificado* para ese feed. |
| Los archivos de texto y las imágenes no coinciden | Coinciden siempre cuando los escribe la app; comprueba que nada más escriba en la carpeta. |
| No llega ninguna alerta | Usa *Enviar prueba* en los ajustes de alertas y lee el mensaje de error. |
| La descarga de la actualización falló con «checksum mismatch» | El archivo se eliminó automáticamente. Inténtalo de nuevo o descarga el instalador a mano desde la página de versiones. |

## Contactos

Graziano Melzi · OnAir Garage — `https://onairgarage.com` — `hello@onairgarage.com`. Página de la herramienta: `https://onairgarage.com/tools/ticker-feed-builder/`. Código fuente y versiones: `https://github.com/djgragra/ticker-feed-builder`. Licencia: MIT © 2026 Graziano Melzi.

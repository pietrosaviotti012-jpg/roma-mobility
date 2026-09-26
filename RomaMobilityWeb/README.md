# Roma Mobility - versione web

Sito statico: una pagina sola, mappa Leaflet con le tessere OpenStreetMap, le fermate dentro
due file GTFS `.txt` e gli orari chiesti a Transitland con lo `stop_id` della fermata.
Nessuna app da installare, nessun abbonamento Apple, niente Expo.

```
index.html               struttura della pagina
styles.css               aspetto, temi chiaro e scuro, margini per notch e barra di sistema
app.js                   tutta la logica (lettura file, mappa, ricerca, orari, fermate successive)
sw.js                    copia locale del sito e aggiornamenti automatici
manifest.webmanifest     nome e icone quando lo aggiungi alla schermata Home
data/stops.txt           8.389 fermate ATAC (bus, tram, banchine metro)
data/cotral_stops.txt    12.717 fermate COTRAL
icons/                   ricavate dal logo: icona app, logo chiaro e logo scuro
netlify.toml             pubblicazione e regola /api/*
netlify/functions/       la funzione che parla con Transitland tenendo la chiave sul server
```

## Com'e' fatta

Tre sezioni in basso: **Mappa**, **Fermate**, **Impostazioni**.

- **Mappa**: le fermate compaiono avvicinandosi; il tasto tondo centra sulla tua posizione.
- **Fermate**: cerca fermate (filtri metro, bus e tram, COTRAL, preferite) e anche vie e piazze,
  chieste a Nominatim di OpenStreetMap e limitate al Lazio.
- **Impostazioni**: tema, quanto guardare avanti, ogni quanto aggiornare.

Toccando una fermata si apre la sua scheda con le partenze. **Toccando una corsa** si vedono le
fermate successive, quanto ci mette il mezzo ad arrivare a ognuna partendo da li' e l'orario di
arrivo. I dati arrivano da Transitland (`/routes/{linea}/trips/{corsa}`); se la corsa e' in tempo
reale, gli orari tengono conto del suo anticipo o ritardo. Toccando una di quelle fermate se ne
aprono le partenze.

## Come arrivare (navigazione)

Sulla mappa c'e' la barra **Dove vuoi andare?**. Il flusso ricalca Moovit:

1. **ricerca** del luogo (vie, piazze, locali, fermate) con i **recenti** salvati nel telefono;
2. **Pianifica un viaggio**: partenza (di solito *Posizione attuale*) e arrivo, tasto per scambiarli,
   *Partendo ora / Parti alle / Arriva entro* (+15 minuti), ordine per *piu' veloci*, *meno a piedi*,
   *meno cambi*; le corse uguali dalla stessa fermata stanno in una scheda sola con piu' orari;
3. alternative **a piedi e in bici**;
4. il percorso scelto si disegna **sulla mappa** con i colori delle linee e un foglio con le tappe
   (fermate intermedie apribili, fermate che portano alla loro scheda con le partenze).

I percorsi li calcola **Transitous** (`api.transitous.org`), servizio pubblico e gratuito basato su
MOTIS, direttamente dal telefono: nessun server nostro. Copre ATAC (bus, tram, metro, con tempo
reale) e i treni regionali Trenitalia; **i bus COTRAL mancano** per lo stesso motivo del resto
dell'app (il loro file degli orari non si scarica). Le fermate di Transitous hanno lo stop_id dei
nostri file (`it-Lazio-Rome_71262` -> 71262).

Alcune corse arrivano con un tempo reale incoerente (tutte le fermate allo stesso minuto): i percorsi
che le usano vengono scartati, perche' promettono coincidenze impossibili.

Condizioni d'uso di Transitous: progetto **non commerciale**, poche richieste, link visibile alle
fonti (c'e' nelle impostazioni e sotto i percorsi). Chiedono anche che il progetto sia **open source**
e che sul sito ci sia un **contatto**: se pubblichi il codice su GitHub e aggiungi un recapito nei
crediti, sei a posto.

## Pubblicare su Netlify

1. Su app.netlify.com: **Add new site > Deploy manually** e trascina dentro questa cartella.
   (Oppure metti la cartella su GitHub e collega il repository: `publish` e `functions` sono
   gia' scritti in `netlify.toml`.)
2. A sito creato vai in **Site configuration > Environment variables** e aggiungi:

   | Nome | Valore |
   |---|---|
   | `TRANSITLAND_API_KEY` | la tua chiave Transitland |

3. Fai un nuovo deploy (**Deploys > Trigger deploy**) perche' la variabile venga letta.

La funzione risponde solo a due domande (partenze da una fermata, fermate di una corsa) e aggiunge
la chiave lato server: **la chiave non compare mai nella pagina**. Senza la variabile il sito
funziona lo stesso ma usa la chiave di riserva scritta in `app.js`, che chiunque puo' leggere.

## Aggiornare l'app sui telefoni

Non serve togliere e rimettere l'icona: il service worker controlla se c'e' una versione nuova
ogni volta che riapri l'app e ogni mezz'ora mentre e' aperta.

- se l'app e' aperta quando arriva l'aggiornamento compare **"C'e' una versione nuova"** con il
  tasto **Aggiorna**;
- alla prima apertura dopo l'aggiornamento compare **"Roma Mobility e' stata aggiornata"** con una
  riga su cosa e' cambiato.

Ogni volta che pubblichi:

1. in `app.js` cambia `APP_VERSION` e scrivi la novita' in `APP_NEWS`;
2. in `sw.js` alza `CACHE_VERSION` (ora e' `v21`).

**Unica eccezione:** il colore della barra dell'orologio iOS lo legge solo quando aggiungi il sito
alla schermata Home. Con questa versione la barra e' cambiata, quindi l'icona va tolta e rimessa
**una volta**. Dagli aggiornamenti successivi non serve piu'.

## La barra dell'orologio

La barra resta quella di iOS (`default`): niente sfocatura sopra la pagina e niente testo coperto.

**Da iOS 26 Safari non legge piu' `theme-color`**: colora la striscia con lo sfondo del `body`,
a meno che in cima ci sia un elemento `position: fixed` largo quanto lo schermo (e alto almeno
6 px), nel qual caso usa quello e lo ricalcola solo quando quell'elemento cambia. Per questo:

- la pagina e' una colonna flex (schermate + schede) senza elementi fissi in cima;
- il `body` ha il colore della striscia (`--bar`: bianco / `#101c33`) e le schermate il loro sfondo;
- al cambio di aspetto lo script riscrive `document.body.style.backgroundColor`, che iOS ridipinge subito.

`theme-color` resta per iOS fino al 18 e per Android. Non aggiungere elementi `fixed` a tutta
larghezza che tocchino il bordo alto, o la striscia smette di seguire il tema.

## La soglia in alto

Su iOS 26 la zona dell'orologio e' sfocata, e la sfocatura scende un po' oltre la barra. In
`styles.css` c'e' una sola variabile, `--top-clear`, che fissa la linea sotto cui deve stare
ogni scritta: una volta e mezza il margine di sicurezza del telefono (88 px con l'isola dinamica,
14 px nel browser normale). Avviso sulla mappa, titoli delle sezioni, ricerca e riquadro di
aggiornamento partono tutti da li': se aggiungi qualcosa in alto, usa `var(--top-clear)`.

## La posizione

Dopo il primo si' l'app se lo ricorda: alle aperture successive cerca la posizione da sola e,
nell'attesa, riparte dall'ultimo punto in cui eri. Se non l'hai ancora condivisa, la richiesta arriva all'apertura.

Se l'iPhone rifa' la domanda a ogni apertura, la fa iOS e non l'app. Per non vederla piu':
**Impostazioni > App > Safari > Posizione > Consenti**.

## Cose da sapere

- Gli orari ATAC arrivano dal GTFS di Roma Mobilita' via Transitland: in **blu** quando il mezzo
  trasmette la sua posizione, in grigio quando e' l'orario programmato.
- **COTRAL**: gli orari si chiedono a Transitland con lo stop_id, come per ATAC, ma il calendario
  COTRAL su Transitland e' fermo al 31 agosto 2025. Il motivo: il server COTRAL
  (travel.mob.cotralspa.it:4443) pubblica il GTFS aggiornato ogni giorno, ma con un certificato
  intestato a *.cotralspa.it, che copre mob.cotralspa.it e non travel.mob.cotralspa.it: il nome non
  corrisponde e chi scarica con i controlli attivi (Transitland, Transitous) rifiuta il file. L'app chiede quindi le corse
  del giorno equivalente di quel calendario, sulle prossime 6 ore, e le segna con la tilde (~).
- Le fermate **preferite** sono gialle sulla mappa e negli elenchi, e restano visibili anche con la
  mappa lontana.
- Le tessere della mappa arrivano dai server di OpenStreetMap: per un sito personale va bene. Il
  tema scuro non usa tessere diverse, le rende scure con un filtro.

## Provarlo in locale

```
python -m http.server 5191 --directory .
```

Poi apri http://localhost:5191. In locale la funzione Netlify non c'e': il sito se ne accorge da
solo (riceve un 404) e passa alla chiamata diretta a Transitland.

<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-OPCUA-SERVER banner" width="100%">
</p>

# 🏭 HYDRA-UMC-OPCUA-SERVER

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | 🇮🇹 <b>Italiano</b> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | <a href="README_jpn.md">🇯🇵 日本語</a> | <a href="README_por.md">🇵🇹 Português</a></p>

### 🛠️ Mappatura degli oggetti HydraState su spazi di indirizzamento OPC-UA standardizzati

<p align="center">
  <img src="https://img.shields.io/badge/Licenza-GPL%203.0--or--later-blue.svg" alt="GPL 3.0 or later">
  <img src="https://img.shields.io/badge/Standard-OPC--UA-orange.svg" alt="OPC-UA">
  <img src="https://img.shields.io/badge/Funzione-Address%20Space%20Modeling-blue.svg" alt="Modeling">
</p>

---

**Controllo di onestà - cosa funziona davvero oggi:** il server OPC-UA e la mappatura dello spazio degli indirizzi (`src/server.ts`) sono reali e testati (98 test superati tra `tests/server.test.ts`, `tests/security.test.ts`, `tests/security-policy.test.ts`, `tests/robotSource.test.ts`, `tests/robotSource.integration.test.ts`) - e sono veri test a livello di protocollo: `tests/server.test.ts` collega un vero `OPCUAClient` (il client stesso di node-opcua, la stessa libreria che userebbero UAExpert/Ignition) sul vero protocollo binario su una vera porta TCP, e `tests/security-policy.test.ts` dimostra che una sessione non cifrata `SecurityPolicy.None` viene genuinamente rifiutata di default (accettata solo tramite la via di fuga esplicita `OPCUA_ALLOW_INSECURE=1`). Ciò che è deliberatamente rimandato, non una lacuna trovata per caso: l'albero per robot (`Robot_<id>`) segue l'elenco riportato da HYDRA-UMC-SERVER (interrogato con un token o un account, vedi `.env.example`), ma il resto dello spazio degli indirizzi è costruito una sola volta all'avvio; finora sono testate end-to-end solo le letture/scritture, non le subscription OPC-UA; e il Pub/Sub (Fase 1 della Roadmap) resta non implementato, poiché nessun client ne dipende ancora. Vedi `mejoras_futuras.txt` per l'elenco completo di ciò che è rimandato e perché, e `CHANGELOG.md` per ciò che è stato consegnato esattamente finora.

---

> **Stato di sicurezza (safety e security):** questo ecosistema non è un sistema di sicurezza certificato. Non esiste ancora un percorso E-STOP hardware, né limiti o interblocchi imposti dal firmware, né un comando di movimento verificato; le immagini firmware sono controllate con CRC32 e un HMAC-SHA256 a chiave condivisa, non con una firma asimmetrica; TLS e TLS reciproco sono opzionali e disattivati per impostazione predefinita; nessuna scheda propria è stata ancora assemblata o provata. Leggi la [base di sicurezza](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md) e il [modello delle minacce](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md) prima di fidarti di qualsiasi affermazione qui per la sicurezza di una persona.

## 📋 In breve

| | |
|---|---|
| Versione | `0.2.0` |
| Maturità | Funzionale |
| Test | 73 |
| Tecnologia | Node.js / node-opcua / OPC-UA address space |
| Destinazione | Il Raspberry Pi CM5 di una cella HYDRA-UMC |
| Su hardware reale | Non ancora: per questa versione non risulta alcuna esecuzione su hardware reale |

## 🚦 Stato del progetto

Ogni riga è una parte di questo repository e il semaforo dice a che punto è oggi. È scritta in base a ciò che il repository può mostrare (test, compilazioni, esecuzioni), non a ciò che è previsto.

🟢 Fatto e verificato · 🟡 Funziona, con limiti noti · 🟠 Fatto a metà o non ancora verificato · 🔴 Non fatto o non funzionante

| Area | Stato | Cosa significa qui |
|---|---|---|
| Software | 🟡 | Funziona per il suo scopo principale; la verifica di onestà qui sopra elenca ciò che manca ancora |
| Test | 🟢 | 73 test automatici, eseguiti a ogni modifica |
| Hardware reale | 🔴 | Non ancora: per questa versione non risulta alcuna esecuzione su hardware reale |
| Documentazione | 🟢 | README in otto lingue, verificato rispetto al manifesto a ogni modifica |

## 1. 🛠️ PANORAMICA TECNICA

**HYDRA-UMC-OPCUA-SERVER** è il modulo di modellazione industriale principale per il Gateway. Traduce l'HydraState interno e dinamico (JSON) in uno spazio di indirizzamento OPC-UA strutturato e individuabile.

Consente ai software di automazione industriale (come Ignition, Siemens TIA Portal o Rockwell FactoryTalk) di sfogliare, leggere e scrivere nelle variabili robotiche come se fossero tag PLC standard.

### Caratteristiche principali:
* 🛠️ **Modellazione dinamica delle informazioni:** Genera automaticamente l'albero OPC-UA in base ai robot e agli strumenti attivi.
* 🔄 **Elenco dei robot e due indicatori:** l'elenco dei robot (oggetti `Robot_<id>` con `Name` e `Online`) è di sola lettura; anche `SwarmOnline` e `MaintenanceMode` sono di sola lettura (una scrittura non avrebbe effetto sul resto del sistema e viene rifiutata); `SwarmOnline` è `BadWaitingForInitialData` finché il poller dell'elenco non ha letto una volta. Nessun nodo comanda un giunto o un effettore.
* 🧭 **Modello tipizzato, ruoli e un segnale dal vivo:** la cella è un `HydraCellType` e ogni robot un `HydraRobotType` sotto una cartella `Objects/Robots` (i NodeId, nello spazio dei nomi 1, non cambiano; il modello è il file `nodeset/HydraUmc.NodeSet2.xml`, che un test mantiene uguale al codice). `Online` è solo l'interruttore dell'interfaccia dell'operatore; `Live` dice se il robot ha inviato una patch a HYDRA-UMC-SERVER entro `HYDRA_UMC_OPCUA_LIVE_WINDOW_MS` e `LastUpdate` quando, il che richiede `HYDRA_UMC_OPCUA_SOURCE=stream` (un WebSocket al posto del polling) e altrimenti vale `BadWaitingForInitialData`. Le sessioni hanno ruoli OPC UA: anonimo è `Anonymous`, il visualizzatore un `Observer`, l'amministratore anche `ConfigureAdmin`; nessun ruolo può scrivere. *(provato con il client di node-opcua, mai con uno SCADA)*
* 🔖 **Namespace Versionato e NodeId Stabili:** Un URI di namespace reale ed esplicito, e NodeId di tipo stringa espliciti - un aggiornamento dell'address space non può cambiare silenziosamente il percorso da cui dipende un client. *(implementato)*
* 🔐 **Autorizzazione di Scrittura per Sessione:** Un controllo reale e dinamico che distingue una sessione anonima da una autenticata - non tutti i client ottengono l'accesso in scrittura per impostazione predefinita. *(implementato)*
* 📡 **Supporto alle sottoscrizioni:** Aggiornamenti dei dati ad alta efficienza utilizzando i meccanismi publish-subscribe di OPC-UA. *(testato end-to-end: una vera sottoscrizione consegna una notifica di cambio dati)*
* 🩺 **Esercizio (tutto opzionale):** `OPCUA_HEALTH_PORT` apre un ascoltatore separato (solo loopback salvo diversa indicazione di `OPCUA_HEALTH_HOST`) con `GET /health` e `GET /metrics` (sessioni, sottoscrizioni, accessi falliti, robot, se l'elenco è leggibile); finché l'elenco non è leggibile, le variabili `Online` dei robot valgono `false` con qualità Uncertain invece di un semplice `false`; `OPCUA_VIEWER_USERNAME`/`OPCUA_VIEWER_PASSWORD` aggiungono un account di sola lettura e `OPCUA_ALLOW_ANONYMOUS=0` rifiuta le sessioni anonime; le impostazioni dell'elenco accettano anche i nomi `HYDRA_UMC_SERVER_*` comuni all'ecosistema. Tutto disattivato o invariato per impostazione predefinita. *(implementato)*
* 🛡️ **Crittografia:** ogni sessione reale richiede Signed o Signed+Encrypted (Basic256Sha256, Aes128_Sha256_RsaOaep o Aes256_Sha256_RsaPss) - una connessione non cifrata `SecurityPolicy.None` viene realmente rifiutata, non solo sconsigliata.

---

## 2. 🔄 FLUSSO DELLO SPAZIO DI INDIRIZZAMENTO OPC-UA

```mermaid
flowchart LR
    API["Hydra Internal API"] --> MAP["OPC-UA Mapper"]
    MAP --> SPACE["Address Space Tree"]
    SPACE --> TAGS["Tag PLC standardizzati"]
    TAGS --> CLIENT["PLC / SCADA esterni"]
```

---

## 3. 🧱 ARCHITETTURA E DECISIONI DI PROGETTAZIONE

* **Perché è fratello, non un sottomodulo, di HYDRA-UMC-GATEWAY-INDUSTRIAL.** Ogni adattatore di protocollo è un processo distribuibile/riavviabile separatamente - un problema nella libreria client OPC-UA non abbatte mai gli adattatori MQTT o MTConnect che girano accanto.
* **Perché un address space OPC-UA, non un semplice passthrough REST.** I client OPC-UA (SCADA/storici) si aspettano un vero address space navigabile con nodi tipizzati - un passthrough REST piatto esporrebbe tecnicamente i dati ma vanificherebbe il senso di parlare OPC-UA.
* **Come si inserisce nel resto dell'ecosistema.** Un servizio fratello sotto HYDRA-UMC-GATEWAY-INDUSTRIAL - traduce lo stato proprio di HYDRA-UMC-SERVER in un vero address space OPC-UA.
* **Test reali a livello di protocollo, non solo un controllo di compilazione.** `tests/server.test.ts` connette un `OPCUAClient` reale (il client proprio di node-opcua, la stessa libreria che userebbero UAExpert/Ignition) a un `OPCUAServer` reale tramite il vero protocollo binario su una porta TCP reale - aprendo una sessione, navigando/leggendo `SwarmOnline`/`ActiveRobotCount` per percorso, e confermando che una scrittura emessa dal client si riflette sia nel valore riletto sia nello stato interno del server.
* **Perché NodeId di tipo stringa espliciti, non quelli numerici auto-assegnati di node-opcua.** Un NodeId numerico viene assegnato in base all'ordine di creazione - inserire un nuovo DataItem prima di uno esistente nel codice lo rinumererebbe silenziosamente, rompendo qualsiasi client industriale che avesse il vecchio numero hardcoded. Un NodeId esplicito in stile `s=HydraNode_1.SwarmOnline` non può mai spostarsi sotto un client solo perché il codice dell'address space ha cambiato forma.
* **Perché `SpindleTemp` usa `timestamped_get`, non il più semplice `get()` usato dalle altre variabili.** `get()` marca automaticamente ogni lettura con l'ora corrente - adatto per un valore live, disonesto per uno che cambia lentamente (un mandrino non si riscalda di nuovo tra un polling e l'altro). `timestamped_get` restituisce un vero `DataValue` con un `sourceTimestamp` esplicito che traccia quando il valore è realmente cambiato l'ultima volta, la semantica reale su cui si basa uno storico OPC-UA.
* **Cosa succede quando la vera fonte di `SpindleTemp` si disconnette.** L'ultimo valore reale continua a essere servito - mai nascosto, mai azzerato - ma il suo `statusCode` degrada da `Good` al codice reale e standard di node-opcua `UncertainLastUsableValue` ("Whatever was updating this value has stopped doing so"), e `sourceTimestamp` continua a puntare al reale ultimo istante osservato, non a "adesso". Una sessione correttamente autenticata e cifrata non cambia mai questo - autentica il client, non la freschezza del dato.
* **Perché l'autorizzazione di scrittura è per sessione (`isUserWritable`), non un flag statico di livello di accesso.** Un `userAccessLevel` statico non può distinguere la sessione di un client da quella di un altro - è lo stesso per ogni connessione. Sovrascrivere `isUserWritable(context)` sul nodo variabile è il meccanismo proprio e documentato di node-opcua per un controllo che varia realmente per sessione, abbastanza reale da poter essere testato con due identità client reali diverse.

Deliberatamente rimandato, e perché: uno spazio degli indirizzi completamente dinamico (l'albero per robot segue già l'elenco riportato da HYDRA-UMC-SERVER; il resto è costruito una sola volta all'avvio); e il punto Pub/Sub della roadmap (ancora non implementato - nessun client ne dipende per ora).

---

## 📂 STRUTTURA DELLE CARTELLE

```text
HYDRA-UMC-OPCUA-SERVER/
├── src/         # Codice sorgente (Node/TypeScript - Modello, Server, Mapper)
├── tests/       # Suite Vitest - comportamento di server e sicurezza
├── dist/       # Output compilato (npm run build)
├── images/      # Media e diagrammi
├── scripts/     # Script di utilità (bump-version.mjs)
├── tools/       # ci_validate.py - validazione manifest/CHANGELOG/docs usata dalla CI
├── mejoras_futuras.txt  # L'elenco completo e onesto di ciò che è deliberatamente rimandato, e perché
└── README.md
```

Servizio di rete puro, senza hardware proprio - `hardware/`, `firmware/`
e `os/` sono omesse secondo la politica della struttura del repository.

---

## 🛠️ AMBIENTE DI SVILUPPO

### Requisiti
- [Node.js](https://nodejs.org/) (v20 o superiore consigliato)
- npm

### Installazione
```bash
npm install
```

### Modalità Sviluppo
Esegue il server OPC-UA direttamente con `tsx` (senza bundler):
- **Windows:** doppio clic su `dev.bat` oppure eseguire `npm run dev`
- **Linux/Mac:** eseguire `./dev.sh` oppure `npm run dev`

### Build di Produzione
Impacchetta il server in un unico file distribuibile con esbuild:
- **Windows:** doppio clic su `build.bat` oppure eseguire `npm run build`
- **Linux/Mac:** eseguire `./build.sh` oppure `npm run build`

Poi avvialo con:
```bash
npm start
```

Il server resta in ascolto su `0.0.0.0:4840` (la porta OPC-UA predefinita
registrata IANA) all'endpoint
`opc.tcp://<host>:4840/HYDRA-UMC-OPCUA-SERVER` - punta qualsiasi client
OPC-UA (UAExpert, Ignition, Siemens TIA Portal, ...) per esplorare lo
spazio di indirizzamento.

### Versionamento
`npm run build` si limita a impacchettare il server. La versione viene alzata solo da `python tools/hydra_project_tool.py bump` (tramite `bump_manifest_version.py`), un "contachilometri" in base 10: patch +1 per bump, con riporto su minor (e da minor a major) dopo 9 invece di raggiungere un segmento a due cifre (`0.0.9` -> `0.1.0`, non `0.0.10`).

---

## 🚀 TABELLA DI MARCIA
* **Fase 1:** Implementazione di OPC-UA Pub/Sub per lo scambio di dati ad alta velocità e bridging di protocolli legacy.
* **Fase 2:** il broker MQTT esiste già come repository a sé ([HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)); il cluster per la gestione massiva di dispositivi IoT e l'alta concorrenza resta pianificato.
* **Fase 3:** l'adattatore MTConnect esiste già come repository a sé ([HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)); l'integrazione di macchinari CNC e PLC multi-vendor oltre a esso resta pianificata.
* **Fase 4:** Piena conformità alla specifica companion OPC UA Robotics e sincronizzazione del gateway industriale.

---

## 🔗 Progetti Correlati

Questo progetto fa parte dell'ecosistema robotico HYDRA-UMC dello stesso autore (JuanenRac / Electro Hobby 3D). Vale la pena conoscerlo, poiché una richiesta potrebbe in realtà riguardare uno di questi invece di questo repository.

**Progetto Padre**
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — hub di integrazione che inoltra ai protocolli industriali, con un vero livello di allowlist dei comandi/backpressure; il genitore di cui questo repository è un adattatore di protocollo specifico, all'interno del proprio gateway industriale.

**Progetti Fratelli** — gli altri adattatori di protocollo del gateway industriale proprio di HYDRA-UMC-GATEWAY-INDUSTRIAL
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — vero broker MQTT con autenticazione opzionale per client e ACL sui topic.
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — veri endpoint XML `/probe` e `/current` di MTConnect, con output in modalità degradata.

**Direttamente Correlati**
- **[HYDRA-UMC-SERVER](https://github.com/JuanenRac/HYDRA-UMC-SERVER)** — il vero backend headless (REST/WebSocket) con cui parla davvero ogni client di controllo — la fonte dello stato che questo adattatore espone.

**Fa Anche Parte dell'Ecosistema**

*Hardware e Piattaforma di Base*
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — il progetto della scheda madre del braccio robotico: host CM5 + coprocessore STM32H745 dual-core, pensato per coordinare fino a 8 bracci utensile via CAN-OTA/SPI-OTA (firmware in fase iniziale; nessuna scheda assemblata per ora).
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — livello prodotto riproducibile su Raspberry Pi OS per il CM5: agente in sola lettura, config/profili validati, provisioning WiFi al primo contatto.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — il contratto JSON-Schema condiviso e la barriera software di controllo dei job contro cui ogni bridge valida i propri comandi (non è una funzione di sicurezza certificata).
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — registro dichiarativo e validatore di manifesti adattatore per connettori di macchine esterne; estende la propria idea di contratto dell'SDK alle macchine esterne senza sostituire i progetti di gateway industriale.

*Backend Centrale e Client*
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — dashboard di controllo web con visualizzazione 3D multi-robot in tempo reale.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — centro di comando sciame desktop (PySide6) per più server contemporaneamente, pacchettizzato come eseguibile standalone.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — app di controllo nativa per Android con login biometrico e un companion Wear OS abbinato.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — app di controllo per iOS/iPadOS (Flutter) con sincronizzazione WebSocket in tempo reale.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — interfaccia touch nativa per il touchscreen DSI da 7" a bordo, incorporata direttamente nel CM5.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — creatore/editor grafico desktop di URDF che invia i modelli finiti al catalogo di STUDIO.
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — editor desktop di modelli STL, che trasforma/sostituisce/rimuove/aggiunge veri pezzi nello stesso catalogo di modelli modificato anche da HYDRA-UMC-EDITOR-URDF.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — barriera di coordinamento per flotte AGV/AMR tramite un publisher MQTT VDA 5050 (testato solo contro una flotta emulata).
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — coordinatore ad alto livello per celle CNC con accesso a stato/byte di controllo GRBL (testato solo contro un emulatore).
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — barriera di coordinamento per droidi con zampe/umanoidi, con un mittente di comandi per Boston Dynamics Spot (testato solo contro un emulatore).
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — coordinatore per celle laser che legge 3 segnali GPIO di chiave/involucro/interblocco (testato solo contro un chip simulato; non può armare né far partire un laser).
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordinatore ad alto livello sicuro per il flusso schede del pick-and-place OpenPnP.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — barriera di coordinamento sicura per stampanti 3D Moonraker/Klipper, con comandi di lavoro reali e controllati.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordinatore con un trasporto ROS 2 rclpy importato in modo lazy (non ancora eseguito contro un'installazione ROS 2).
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — barriera di coordinamento per UAV dotati di fotocamera, con un mittente di comandi MAVLink (testato solo contro un emulatore).

*Piattaforma Strumenti URTC*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware per la scheda fisica dell'Universal Robot Tool Controller, oltre 25 profili utensile su bus CAN.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — strumento desktop con GUI per il flashing delle schede URTC, CAN-OTA più SWD/JTAG a chip intero.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — strumento desktop di diagnostica CAN-bus dal vivo per schede URTC, un pannello per profilo utensile.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternativa basata su browser a URTC-TESTER tramite la Web Serial API, senza installazione locale.
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** — gateway davanti al bus CAN di URTC: elenco di identificatori consentiti, limite di frequenza e chiave di sessione; software provato su computer, non ancora su un bus reale.

*Nodo IA Visione (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — hub di integrazione per la pipeline di visione Hailo-8, con un vero controllo di prontezza hardware per fase.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — registro reale di modelli compilati con verifica di caricamento sicuro per architettura Hailo/checksum.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — generatore reale di pipeline GStreamer + config MediaMTX, con una vera barriera di integrazione HailoRT.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — legge di correzione Position-Based Visual Servoing con autorizzazione condizionata allo stato di zona; ancora nessuna stima di posa da telecamera.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — logica v0 di violazione zona, freschezza di calibrazione e richiesta E-STOP che legge le posizioni degli oggetti da un file; nessun rilevatore la alimenta e nessun E-STOP fisico è ancora collegato.

*Nodo IA Cognitivo (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — hub di integrazione per la pipeline cognitiva Hailo-10 (orchestrazione LLM/VLA/voce).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — vera codifica/decodifica di token d'azione e generazione di traiettoria per un modello Vision-Language-Action.
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — vero front-end vocale (VAD + parser di intenti) con un relay verso Watch limitato e soggetto a conferma.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — vera scomposizione dei task basata su regole e recupero semantico degli errori sui codici errore MCU.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — vera ricerca documentale TF-IDF (solo libreria standard) sui documenti Markdown di questo ecosistema.
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — tecnico di manutenzione IA locale e con cancelli di policy per l'ecosistema stesso - osserva, diagnostica e propone correzioni; i due livelli di rischio più alti non sono deliberatamente ancora implementati.

*Orchestrazione e Sciame*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — hub di integrazione con un vero contratto di health-report gRPC/Protobuf e una macchina a stati di missione.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — vera coda di lavori basata su priorità con deduplicazione, su una vera API HTTP.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — vero watchdog di salute della flotta basato su gRPC, con retry/backoff e rilevamento di discrepanza d'identità.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — vero pianificatore di percorsi 3D basato su RRT, con vera validazione delle collisioni ostacolo/spazio di lavoro.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — vera sincronizzazione di stato CRDT LWW-Element-Map, con property test per la convergenza multi-cella.

*Gemello Digitale e Simulazione*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — hub di integrazione per il motore di gemello digitale, con un vero contratto di sincronizzazione per compatibilità di versione.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — router hardware-in-the-loop con un interblocco software di collisione tra simulazione e hardware reale (testato senza hardware reale).
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — vera cinematica diretta e validazione dei limiti articolari su un vero sottoinsieme URDF.
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — vero generatore procedurale di scene 2D con esportazione di annotazioni YOLO/COCO.

*Dati e Analisi*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — vero archivio di serie temporali basato su sqlite3, con una vera API HTTP di ingestione/query.
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — vero rilevatore di anomalie FFT + baseline statistica, con monitoraggio della deriva.
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — vero calcolo OEE/disponibilità sullo storico di DATALAKE, con esportazione CSV riproducibile.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — vera pipeline di ingestione CAN/WebSocket verso DATALAKE, con deduplicazione per sequenza.

*Strumenti Complementari e Operazioni dell'Ecosistema*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — pannelli Smart Summaries e Anomaly Highlighting su DATALAKE/ANOMALY-DETECTOR, con un fallback statistico onesto.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — CLI di flotta con un vero e stabile contratto di exit-code, un client live reale della stessa API di HYDRA-UMC-SERVER.
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — app companion WearOS con schemi di avviso aptico e un relay vocale verso il telefono abbinato (non ancora eseguita su un orologio fisico).
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware per un rack di montaggio schede con decodifica reale dell'ID utensile e logica di preriscaldamento Smart Idle.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware più un vero companion di visione Python per una testa utensile di ispezione termica/RGB.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — strumento amministrativo desktop che scopre, clona e aggiorna ogni repository di questo ecosistema.
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — strumento desktop Windows/Linux che costruisce un'immagine della CM5 pronta da scrivere, precaricata con le versioni più aggiornate dell'ecosistema, con configurazione di primo avvio Wi-Fi/utente/SSH in stile Raspberry Pi Imager.
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — coordinatore di incidenti di manutenzione: un ruolo edge a basso privilegio raccoglie uno snapshot di inventario/salute sanificato, un ruolo control-plane lo rende in sola lettura e chiede a un provider di IA di suggerire una diagnosi - non applica mai una patch né distribuisce nulla.
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — host di sviluppo riproducibile (Raspberry Pi 5 / CM5) che conserva il codice sorgente dell'ecosistema ed esegue attività delimitate di build/test tramite una coda durevole; un ruolo di sviluppo dedicato, esplicitamente distinto da un CM5 operativo.


---

## 📚 Documentazione e Comunità

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — stack tecnologico e linee guida di codifica per una pull request.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — gli standard di comportamento attesi in questa comunità.
- **[SECURITY.md](SECURITY.md)** — come segnalare una vulnerabilità, e le reali aree di attenzione sulla sicurezza di questo progetto.
- **[SUPPORT.md](SUPPORT.md)** — dove porre domande e segnalare bug.
- **[LICENSE.md](LICENSE.md)** — la licenza propria di questo progetto.

## 👤 AUTORE
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 LICENZA
GPL-3.0-or-later - Vedere LICENSE per i dettagli.

<!-- =============================================================================
HYDRA-UMC-OPCUA-SERVER - OPC-UA address space of the robot roster
Copyright (C) JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-OPCUA-SERVER banner" width="100%">
</p>

# 🏭 HYDRA-UMC-OPCUA-SERVER

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | <a href="README_ita.md">🇮🇹 Italiano</a> | 🇩🇪 <b>Deutsch</b> | <a href="README_zho.md">🇨🇳 简体中文</a> | <a href="README_jpn.md">🇯🇵 日本語</a> | <a href="README_por.md">🇵🇹 Português</a></p>

### 🛠️ Mapping von HydraState-Objekten auf standardisierte OPC-UA-Adressräume

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL%203.0--or--later-blue.svg" alt="GPL 3.0 or later">
  <img src="https://img.shields.io/badge/Standard-OPC--UA-orange.svg" alt="Standard">
  <img src="https://img.shields.io/badge/Feature-Address%20Space%20Modeling-blue.svg" alt="Feature">
  <img src="https://img.shields.io/badge/Tests-98%20passing-2ea44f.svg" alt="Tests">
  <img src="https://img.shields.io/badge/Version-0.2.0-0f6cbd.svg" alt="Version">
  <img src="https://img.shields.io/badge/Maturity-functional-0F6CBD.svg" alt="Maturity">
</p>

---

**Ehrlichkeitscheck - was heute wirklich läuft:** der OPC-UA-Server und die Adressraum-Zuordnung (`src/server.ts`) sind real und getestet (98 bestandene Tests über `tests/server.test.ts`, `tests/security.test.ts`, `tests/security-policy.test.ts`, `tests/robotSource.test.ts`, `tests/robotSource.integration.test.ts`) - und das sind echte Tests auf Protokollebene: `tests/server.test.ts` verbindet einen echten `OPCUAClient` (node-opcuas eigenen Client, dieselbe Bibliothek, die UAExpert/Ignition verwenden würden) über das echte Binärprotokoll auf einem echten TCP-Port, und `tests/security-policy.test.ts` beweist, dass eine unverschlüsselte `SecurityPolicy.None`-Sitzung standardmäßig tatsächlich abgelehnt wird (nur über das explizite Escape-Hatch `OPCUA_ALLOW_INSECURE=1` akzeptiert). Was absichtlich zurückgestellt ist, keine zufällig gefundene Lücke: der Baum pro Roboter (`Robot_<id>`) folgt der von HYDRA-UMC-SERVER gemeldeten Liste (abgefragt mit einem Token oder einem Konto, siehe `.env.example`), aber der Rest des Adressraums wird einmal beim Start aufgebaut; bisher sind nur Lese-/Schreibvorgänge Ende-zu-Ende getestet, keine OPC-UA-Subscriptions; und Pub/Sub (Roadmap-Phase 1) bleibt unimplementiert, da noch kein Client davon abhängt. Siehe `mejoras_futuras.txt` für die vollständige Liste dessen, was zurückgestellt ist und warum, und `CHANGELOG.md` für das, was bisher genau ausgeliefert wurde.

---

> **Stand von Sicherheit (Safety) und Security:** Dieses Ökosystem ist kein zertifiziertes Sicherheitssystem. Es gibt noch keinen Hardware-E-STOP-Pfad, keine von der Firmware durchgesetzten Grenzen oder Verriegelungen und keinen verifizierten Bewegungsbefehl; Firmware-Images werden mit CRC32 und einem HMAC-SHA256 mit gemeinsamem Schlüssel geprüft, nicht mit einer asymmetrischen Signatur; TLS und gegenseitiges TLS sind optional und standardmäßig aus; noch keine eigene Platine wurde bestückt oder getestet. Lesen Sie die [Sicherheitsbasis](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md) und das [Bedrohungsmodell](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md), bevor Sie sich für die Sicherheit einer Person auf eine Aussage hier verlassen.

---

## 📋 Auf einen Blick

| | |
|---|---|
| Version | `0.2.0` |
| Reifegrad | Funktionsfähig |
| Tests | 98 (`npm test`) |
| Technik | Node.js / node-opcua / OPC-UA address space |
| Ziel | Der Raspberry Pi CM5 einer HYDRA-UMC-Zelle |
| Auf echter Hardware | Noch nicht: für diese Version ist kein Lauf auf echter Hardware vermerkt |

**Springe zu:** [Überblick](#-überblick) · [Architektur](#-architektur) · [Schnellstart](#-schnellstart) · [Tests](#-tests) · [Struktur des Repositorys](#-struktur-des-repositorys) · [Verwandte Projekte](#-verwandte-projekte)

## 🚦 Projektstatus

Jede Zeile ist ein Teil dieses Repositorys, und die Ampel sagt, wie weit er heute ist. Sie beruht auf dem, was das Repository zeigen kann (Tests, Builds, Läufe), nicht auf dem, was geplant ist.

🟢 Fertig und überprüft · 🟡 Funktioniert, mit bekannten Grenzen · 🟠 Teilweise fertig oder noch nicht überprüft · 🔴 Nicht gemacht oder funktioniert nicht

| Bereich | Stand | Was das hier bedeutet |
|---|---|---|
| Software | 🟡 | Funktioniert für seinen Hauptzweck; die Ehrlichkeitsprüfung oben nennt, was noch fehlt |
| Tests | 🟢 | 98 automatische Tests, bei jeder Änderung ausgeführt |
| Echte Hardware | 🔴 | Noch nicht: für diese Version ist kein Lauf auf echter Hardware vermerkt |
| Dokumentation | 🟢 | README in acht Sprachen, bei jeder Änderung gegen das Manifest geprüft |

## 🎯 Überblick

**HYDRA-UMC-OPCUA-SERVER** ist das zentrale industrielle Modellierungsmodul für das Gateway. Er übersetzt den internen, dynamischen HydraState (JSON) in einen strukturierten, durchsuchbaren OPC-UA-Adressraum.

Er ermöglicht es industrieller Automatisierungssoftware (wie Ignition, Siemens TIA Portal oder Rockwell FactoryTalk), Robotervariablen zu durchsuchen, zu lesen und zu schreiben, als wären sie Standard-SPS-Tags.

### Hauptmerkmale:
* 🛠️ **Dynamische Informationsmodellierung:** Generiert automatisch den OPC-UA-Baum basierend auf aktiven Robotern und Werkzeugen.
* 🔄 **Roboterliste und zwei Schalter:** Die Roboterliste (`Robot_<id>`-Objekte mit `Name` und `Online`) ist schreibgeschützt; `SwarmOnline` und `MaintenanceMode` sind ebenfalls schreibgeschützt (eine Schreibaktion hätte keine Wirkung auf den Rest des Systems und wird abgelehnt); `SwarmOnline` ist `BadWaitingForInitialData`, bis der Abruf der Roboterliste einmal gelesen hat. Kein Knoten steuert ein Gelenk oder einen Effektor.
* 🧭 **Typisiertes Modell, Rollen und ein Live-Signal:** Die Zelle ist ein `HydraCellType` und jeder Roboter ein `HydraRobotType` unter einem Ordner `Objects/Robots` (die NodeIds im Namensraum 1 ändern sich nicht; das Modell ist die Datei `nodeset/HydraUmc.NodeSet2.xml`, die ein Test mit dem Code gleich hält). `Online` ist nur der Schalter der Bedieneroberfläche; `Live` sagt, ob der Roboter innerhalb von `HYDRA_UMC_OPCUA_LIVE_WINDOW_MS` einen Patch an HYDRA-UMC-SERVER geschickt hat, und `LastUpdate`, wann. Das braucht `HYDRA_UMC_OPCUA_SOURCE=stream` (ein WebSocket statt Abfrage) und ist sonst `BadWaitingForInitialData`. Sitzungen haben OPC-UA-Rollen: anonym ist `Anonymous`, der Betrachter ein `Observer`, der Administrator zusätzlich `ConfigureAdmin`; keine Rolle darf schreiben. *(mit dem Client von node-opcua erprobt, nie mit einem SCADA)*
* 🔖 **Versionierter Namespace & stabile NodeIds:** Eine echte, explizite Namespace-URI und explizite String-NodeIds - eine Aktualisierung des Address Space kann den Pfad, von dem ein Client abhängt, nicht stillschweigend ändern. *(implementiert)*
* 🔐 **Sitzungsbasierte Schreibautorisierung:** Eine echte, dynamische Prüfung, die eine anonyme Sitzung von einer authentifizierten unterscheidet - nicht jeder Client erhält standardmäßig Schreibzugriff. *(implementiert)*
* 📡 **Subscription-Unterstützung:** Hocheffiziente Datenaktualisierungen über OPC-UA-Publish-Subscribe-Mechanismen. *(Ende-zu-Ende getestet: eine echte Subscription liefert eine Datenänderungsmeldung)*
* 🩺 **Betrieb (alles optional):** `OPCUA_HEALTH_PORT` startet einen separaten Listener (nur Loopback, sofern `OPCUA_HEALTH_HOST` nichts anderes sagt) mit `GET /health` und `GET /metrics` (Sitzungen, Subscriptions, fehlgeschlagene Anmeldungen, Roboter, ob die Liste lesbar ist); solange die Liste nicht lesbar ist, sind die `Online`-Variablen der Roboter `false` mit Qualität Uncertain statt eines schlichten `false`; `OPCUA_VIEWER_USERNAME`/`OPCUA_VIEWER_PASSWORD` fügen ein Nur-Lese-Konto hinzu und `OPCUA_ALLOW_ANONYMOUS=0` weist anonyme Sitzungen ab; die Einstellungen der Roboterliste akzeptieren auch die ökosystemweiten Namen `HYDRA_UMC_SERVER_*`. Standardmäßig alles aus oder unverändert. *(implementiert)*
* 🛡️ **Verschlüsselung:** jede echte Sitzung erfordert Signed oder Signed+Encrypted (Basic256Sha256, Aes128_Sha256_RsaOaep oder Aes256_Sha256_RsaPss) - eine unverschlüsselte `SecurityPolicy.None`-Verbindung wird echt abgelehnt, nicht nur davon abgeraten.

## 🧩 Rolle in HYDRA-UMC

**HYDRA-UMC-OPCUA-SERVER** veröffentlicht die Roboterliste von `HYDRA-UMC-SERVER` als OPC-UA-Adressraum, den SCADA- und Automatisierungssoftware durchsuchen kann. Sitzungen tragen OPC-UA-Rollen, und keine Rolle darf schreiben: Kein Knoten steuert ein Gelenk oder einen Effektor.

## 🏛️ Architektur

<p align="center">
  <img src="images/architecture.svg" alt="HYDRA-UMC-OPCUA-SERVER architecture" width="100%">
</p>

<details>
<summary>Textversion des Diagramms (Mermaid)</summary>

```mermaid
flowchart LR
    API["Hydra Interne API"] --> MAP["OPC-UA Mapper"]
    MAP --> SPACE["Adressraum-Baum"]
    SPACE --> TAGS["Standardisierte SPS-Tags"]
    TAGS --> CLIENT["Externe SPS / SCADA"]
```

</details>

### ARCHITEKTUR & DESIGNENTSCHEIDUNGEN

* **Warum es Geschwister, kein Submodul, von HYDRA-UMC-GATEWAY-INDUSTRIAL ist.** Jeder Protokolladapter ist ein separat bereitstellbarer/neustartbarer Prozess - ein Problem in der OPC-UA-Client-Bibliothek legt nie die daneben laufenden MQTT- oder MTConnect-Adapter lahm.
* **Warum ein OPC-UA-Address-Space statt eines einfachen REST-Passthrough.** OPC-UA-Clients (SCADA/Historians) erwarten einen echten, durchsuchbaren Address Space mit typisierten Knoten - ein flacher REST-Passthrough würde die Daten technisch offenlegen, aber den Sinn ergäbe, überhaupt OPC-UA zu sprechen.
* **Wie sich das ins restliche Ökosystem einfügt.** Ein Geschwisterdienst unter HYDRA-UMC-GATEWAY-INDUSTRIAL - übersetzt den eigenen Zustand von HYDRA-UMC-SERVER in einen echten OPC-UA-Address-Space.
* **Echte Tests auf Protokollebene, nicht nur eine Kompilierprüfung.** `tests/server.test.ts` verbindet einen echten `OPCUAClient` (der eigene Client von node-opcua, dieselbe Bibliothek, die UAExpert/Ignition verwenden würden) mit einem echten `OPCUAServer` über das echte binäre Protokoll auf einem echten TCP-Port - eine Sitzung wird geöffnet, `SwarmOnline`/`ActiveRobotCount` werden per Pfad durchsucht/gelesen, und es wird bestätigt, dass ein vom Client ausgegebener Schreibvorgang sich sowohl im zurückgelesenen Wert als auch im serverseitigen Zustand widerspiegelt.
* **Warum explizite String-NodeIds statt der automatisch vergebenen numerischen von node-opcua.** Eine numerische NodeId wird nach Erstellungsreihenfolge vergeben - würde man ein neues DataItem im Code vor ein bestehendes einfügen, würde dieses stillschweigend umnummeriert, was jeden industriellen Client bricht, der die alte Nummer fest codiert hat. Eine explizite NodeId im Stil `s=HydraNode_1.SwarmOnline` kann sich niemals unter einem Client verschieben, nur weil sich die Form des Address-Space-Codes geändert hat.
* **Warum `SpindleTemp` `timestamped_get` verwendet, nicht das einfachere `get()`, das die anderen Variablen nutzen.** `get()` versieht jede Lesung automatisch mit dem aktuellen Zeitstempel - passend für einen Live-Wert, unehrlich für einen, der sich langsam ändert (eine Spindel heizt sich zwischen zwei Abfragen nicht neu auf). `timestamped_get` liefert einen echten `DataValue` mit einem expliziten `sourceTimestamp`, der nachverfolgt, wann sich der Wert tatsächlich zuletzt geändert hat - die echte Semantik, auf die sich ein OPC-UA-Historian verlässt.
* **Was passiert, wenn sich die echte Quelle von `SpindleTemp` trennt.** Der letzte echte Wert wird weiterhin ausgeliefert - nie zurückgehalten, nie zurückgesetzt - aber sein `statusCode` degradiert von `Good` zu node-opcuas eigenem echten, standardisierten `UncertainLastUsableValue` ("Whatever was updating this value has stopped doing so"), und `sourceTimestamp` zeigt weiterhin auf den echten, zuletzt beobachteten Zeitpunkt statt auf "jetzt". Eine korrekt authentifizierte, verschlüsselte Sitzung ändert daran nichts - sie authentifiziert den Client, nicht die Aktualität der Daten.
* **Warum die Schreibautorisierung pro Sitzung erfolgt (`isUserWritable`), statt über ein statisches Zugriffsebenen-Flag.** Ein statisches `userAccessLevel` kann die Sitzung eines Clients nicht von der eines anderen unterscheiden - es ist für jede Verbindung dasselbe. Das Überschreiben von `isUserWritable(context)` am Variablenknoten ist node-opcuas eigener dokumentierter Mechanismus für eine Prüfung, die tatsächlich pro Sitzung variiert - real genug, um es mit zwei verschiedenen echten Client-Identitäten zu testen.

Bewusst zurückgestellt, und warum: ein vollständig dynamischer Adressraum (der Baum pro Roboter folgt bereits der von HYDRA-UMC-SERVER gemeldeten Liste; der Rest wird beim Start einmal aufgebaut); und der Pub/Sub-Punkt der Roadmap (noch nicht implementiert - kein Client hängt bisher davon ab).

## 🚀 Schnellstart

Benötigt Node.js 20 oder neuer mit npm.

```bash
npm install
npm test
npm run build
npm start
```

## 🧪 Tests

98 automatische Tests laufen mit `npm test`. Sie brauchen weder Hardware noch etwas außerhalb dieses Rechners.

Die CI führt `HYDRA_UMC_CI=1 python tools/ci_validate.py` aus; das prüft das Manifest, die Dokumente, die acht READMEs und die Bilder.

## 🏗️ Build und Veröffentlichung

### Voraussetzungen
- [Node.js](https://nodejs.org/) (v20 oder höher empfohlen)
- npm

### Installation
```bash
npm install
```

### Entwicklungsmodus
Startet den OPC-UA-Server direkt mit `tsx` (ohne Bundler):
- **Windows:** Doppelklick auf `dev.bat` oder `npm run dev` ausführen
- **Linux/Mac:** `./dev.sh` oder `npm run dev` ausführen

### Produktions-Build
Bündelt den Server mit esbuild in eine einzige einsetzbare Datei:
- **Windows:** Doppelklick auf `build.bat` oder `npm run build` ausführen
- **Linux/Mac:** `./build.sh` oder `npm run build` ausführen

Dann starten mit:
```bash
npm start
```

Der Server lauscht auf `0.0.0.0:4840` (der von der IANA registrierte
OPC-UA-Standardport) unter dem Endpoint
`opc.tcp://<host>:4840/HYDRA-UMC-OPCUA-SERVER` - jeden OPC-UA-Client
(UAExpert, Ignition, Siemens TIA Portal, ...) darauf richten, um den
Adressraum zu durchsuchen.

### Versionierung
`npm run build` bündelt nur den Server. Die Version wird nur von `python tools/hydra_project_tool.py bump` erhöht (über `bump_manifest_version.py`).

## 📂 Struktur des Repositorys

<p align="center">
  <img src="images/repository-structure.svg" alt="Repository structure of HYDRA-UMC-OPCUA-SERVER" width="100%">
</p>

<details>
<summary>Textversion des Baums</summary>

```text
HYDRA-UMC-OPCUA-SERVER/
├── src/                       Quellcode (Node/TypeScript - Modell, Server, Mapper)
├── tests/                     Vitest-Suite - Server- und Sicherheitsverhalten
├── docs/                      OPERATIONS.md: was ein Integrator braucht, um diesen Server zu betreiben, anzubinden und sicher freizugeben
├── nodeset/                   HydraUmc.NodeSet2.xml: das Informationsmodell des Namensraums als NodeSet2-Datei (scripts/export_nodeset.ts schreibt und prüft sie)
├── images/                    Medien und Diagramme
├── scripts/                   Hilfsskripte (bump-version.mjs, export_nodeset.ts)
├── tools/                     build_test.py (Build-Prüfung ohne Versionierung), ci_validate.py (Manifest-/CHANGELOG-/Doku-Validierung der CI), hydra_project_tool.py und die gemeinsamen _doc_policy.py und _readme_parity.py
├── .github/                   CI-Workflow und Issue-Vorlagen
├── mejoras_futuras.txt        Die vollständige, ehrliche Liste dessen, was bewusst zurückgestellt wurde und warum
├── CHANGELOG.md               was sich in jeder Version geändert hat
├── Dockerfile                 Container-Image
├── build-test.sh              Build-Prüfung ohne Änderungen
├── build.sh                   baut und prüft; ändert nie die Version
├── bump_manifest_version.py   gleicht die Manifest-Version an
├── dev.sh                     Entwicklungsmodus
├── hydra-umc.project.json     Manifest: Version, Reifegrad, Familie
├── package.json               Paketmetadaten und Skripte
└── test.sh                    führt die Tests aus
```

</details>

## 🗺️ Roadmap und bekannte Grenzen

**Bekannte Grenzen heute**

* **Phase 1:** OPC-UA Pub/Sub-Implementierung für Hochgeschwindigkeitsdatenaustausch und Legacy-Protokoll-Bridging.
* **Phase 2:** der MQTT-Broker existiert bereits als eigenes Repository ([HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)); der Cluster für massives IoT-Gerätemanagement und hohe Parallelität ist weiterhin geplant.
* **Phase 3:** der MTConnect-Adapter existiert bereits als eigenes Repository ([HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)); die Integration von CNC- und SPS-Maschinen verschiedener Hersteller darüber hinaus ist weiterhin geplant.
* **Phase 4:** Volle Konformität mit der OPC UA Robotics Companion Specification und Synchronisation des Industrielles Gateways.

## 🌍 Sprachen

Diese README und die Dokumente des Repositorys gibt es in acht Sprachen: Englisch, Spanisch, Deutsch, Französisch, Italienisch, Japanisch, Chinesisch und Portugiesisch (Portugal). Sie entstehen gemeinsam, und die CI prüft, dass die acht Dateien dieselben Abschnitte und dieselben Links haben. Dieses Repository hat weder eine eigene Oberfläche noch einen eigenen Meldungskatalog, es gibt also keine Oberflächentexte zu übersetzen.

## 🔗 Verwandte Projekte

Dieses Projekt ist Teil des HYDRA-UMC-Robotik-Ökosystems desselben Autors (JuanenRac / Electro Hobby 3D). Gut zu wissen, da eine Anfrage eigentlich eines dieser Projekte betreffen könnte statt dieses Repositorys.

**Übergeordnetes Projekt**
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — Integrationsknoten, der zu Industrieprotokollen weiterleitet, mit einer echten Befehls-Allowlist-/Backpressure-Schicht; das übergeordnete Projekt, dessen spezifischer Protokolladapter dieses Repository innerhalb seines eigenen Industrie-Gateways ist.

**Geschwisterprojekte** — die übrigen Protokolladapter des eigenen Industrie-Gateways von HYDRA-UMC-GATEWAY-INDUSTRIAL
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — echter MQTT-Broker mit optionaler Pro-Client-Authentifizierung und Topic-ACLs.
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — echte MTConnect-`/probe`- und `/current`-XML-Endpunkte mit Degraded-Mode-Ausgabe.

**Direkt verwandt**
- **[HYDRA-UMC-SERVER](https://github.com/JuanenRac/HYDRA-UMC-SERVER)** — das reale Headless-Backend (REST/WebSocket), mit dem jeder Steuerungsclient tatsächlich spricht — die Quelle des Zustands, den dieser Adapter offenlegt.

**Ebenfalls Teil des Ökosystems**

*Kern-Hardware & Plattform*
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — der Entwurf des Motherboards des Roboterarms: CM5-Host + Dual-Core-STM32H745, gedacht zur Koordination von bis zu 8 Werkzeugarmen über CAN-OTA/SPI-OTA (Firmware in einer frühen Phase; noch keine bestückte Platine).
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — reproduzierbare Raspberry-Pi-OS-Produktschicht für den CM5: schreibgeschützter Agent, validierte Konfiguration/Profile, WiFi-Ersteinrichtung.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — der gemeinsame JSON-Schema-Vertrag und die Software-Auftragsschranke, gegen die jede Bridge ihre Befehle validiert (keine zertifizierte Sicherheitsfunktion).
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — deklaratives Adapter-Manifest-Register und Validator für Konnektoren externer Maschinen; erweitert die eigene Vertragsidee des SDK auf externe Maschinen, ohne die Industrie-Gateway-Projekte zu ersetzen.

*Kern-Backend & Clients*
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — Web-Steuerungs-Dashboard mit Echtzeit-3D-Visualisierung mehrerer Roboter.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — Desktop-Schwarmleitstand (PySide6) für mehrere Server gleichzeitig, verpackt als eigenständige ausführbare Datei.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — native Android-Steuerungs-App mit biometrischem Login und einer gekoppelten Wear-OS-Begleit-App.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — iOS/iPadOS-Steuerungs-App (Flutter) mit Echtzeit-WebSocket-Synchronisierung.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — native Touch-UI für das eingebaute 7"-DSI-Touchscreen, direkt auf dem CM5 eingebettet.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — grafischer Desktop-URDF-Ersteller/-Editor, der fertige Modelle in STUDIOs eigenen Katalog überträgt.
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — Desktop-STL-Modelleditor, der echte Teile im selben Modellkatalog transformiert/ersetzt/entfernt/hinzufügt, den auch HYDRA-UMC-EDITOR-URDF bearbeitet.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — Koordinationsschranke für AGV-/AMR-Flotten über einen VDA-5050-MQTT-Publisher (nur gegen eine emulierte Flotte getestet).
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — High-Level-Koordinator für CNC-Zellen mit GRBL-Status-/Steuerbyte-Zugriff (nur gegen einen Emulator getestet).
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — Koordinationsschranke für laufende/humanoide Droiden, mit einem Boston-Dynamics-Spot-Befehlssender (nur gegen einen Emulator getestet).
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — Koordinator für Laserzellen, liest 3 Schlüssel-/Gehäuse-/Verriegelungs-GPIO-Signale (nur gegen einen simulierten Chip getestet; kann keinen Laser scharfschalten oder auslösen).
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — sicherer High-Level-Koordinator für den Leiterplattenfluss von OpenPnP Pick-and-Place.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — sichere Koordinationsschranke für Moonraker/Klipper-3D-Drucker, mit echten gesicherten Job-Befehlen.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — Koordinator mit einem träge importierten rclpy-ROS-2-Transport (noch nicht gegen eine ROS-2-Installation ausgeführt).
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — Koordinationsschranke für kameraausgestattete UAVs, mit einem MAVLink-Befehlssender (nur gegen einen Emulator getestet).

*URTC-Werkzeugplattform*
- **[URTC](https://github.com/JuanenRac/URTC)** — Firmware für die physische Universal-Robot-Tool-Controller-Platine, 25+ Werkzeugprofile über CAN-Bus.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — Desktop-GUI-Flash-Tool für URTC-Platinen, CAN-OTA plus Full-Chip-SWD/JTAG.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — Desktop-Live-CAN-Bus-Diagnosetool für URTC-Platinen, ein Panel pro Werkzeugprofil.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — browserbasierte Alternative zu URTC-TESTER über die Web-Serial-API, ohne lokale Installation.
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** — Gateway vor dem CAN-Bus von URTC: Liste erlaubter Kennungen, Ratenbegrenzung und Sitzungsschlüssel; Software auf dem Computer getestet, noch nicht an einem echten Bus.

*Vision-KI-Knoten (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — Integrationsknoten für die Hailo-8-Vision-Pipeline, mit einer echten stufenweisen Hardware-Bereitschaftsprüfung.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — echte Registry für kompilierte Modelle mit Hailo-Architektur-/Prüfsummen-Safe-Load-Verifizierung.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — echter GStreamer-Pipeline- + MediaMTX-Konfigurationsgenerator mit einer echten HailoRT-Integrationsschranke.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — Position-Based-Visual-Servoing-Korrekturgesetz mit Freigabe abhängig vom Zonenstatus; noch keine Posenschätzung per Kamera.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — v0-Logik für Zonenverletzung, Kalibrierungsaktualität und E-STOP-Anforderung, die Objektpositionen aus einer Datei nimmt; kein Detektor speist sie, und noch kein physischer E-STOP ist angeschlossen.

*Kognitiver KI-Knoten (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — Integrationsknoten für die Hailo-10-Cognitive-Pipeline (LLM-/VLA-/Sprach-Orchestrierung).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — echte Aktions-Token-Kodierung/-Dekodierung und Trajektoriengenerierung für ein Vision-Language-Action-Modell.
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — echtes Sprach-Frontend (VAD + Intent-Parser) mit einem begrenzten, bestätigungsgesicherten Watch-Relay.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — echte regelbasierte Aufgabenzerlegung und semantische Fehlerbehebung über MCU-Fehlercodes.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — echte, nur auf der Standardbibliothek basierende TF-IDF-Dokumentensuche über die eigenen Markdown-Dokumente dieses Ökosystems.
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — lokaler, richtlinien-gesteuerter KI-Wartungstechniker für das Ökosystem selbst - beobachtet, diagnostiziert und schlägt Korrekturen vor; die zwei höchsten Risikostufen sind absichtlich noch nicht implementiert.

*Orchestrierung & Schwarm*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — Integrationsknoten mit einem echten gRPC/Protobuf-Health-Report-Vertrag und einer Missions-Zustandsmaschine.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — echte prioritätsbasierte Job-Queue mit Deduplizierung, über eine echte HTTP-API.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — echter gRPC-basierter Flotten-Health-Watchdog mit Retry/Backoff und Identitäts-Mismatch-Erkennung.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — echter RRT-basierter 3D-Pfadplaner mit echter Hindernis-/Arbeitsraum-Kollisionsvalidierung.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — echte CRDT-LWW-Element-Map-Zustandssynchronisation, eigenschaftsgetestet auf Multi-Zellen-Konvergenz.

*Digitaler Zwilling & Simulation*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — Integrationsknoten für die Digital-Twin-Engine, mit einem echten Versionskompatibilitäts-Sync-Vertrag.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — Hardware-in-the-Loop-Router mit einer Software-Kollisionsverriegelung zwischen Simulation und echter Hardware (ohne echte Hardware getestet).
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — echte Vorwärtskinematik und Gelenkgrenzenvalidierung über eine echte URDF-Teilmenge.
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — echter prozeduraler 2D-Szenengenerator mit YOLO/COCO-Annotationsexport.

*Daten & Analytik*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — echter sqlite3-gestützter Zeitreihenspeicher mit einer echten Ingest-/Abfrage-HTTP-API.
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — echter FFT- + statistischer Basislinien-Anomaliedetektor mit Drift-Überwachung.
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — echte OEE-/Verfügbarkeitsberechnung über den DATALAKE-Verlauf, mit reproduzierbarem CSV-Export.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — echte CAN/WebSocket-Ingestion-Pipeline in DATALAKE, mit Sequenz-Deduplizierung.

*Ergänzende Tools & Ökosystembetrieb*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — Smart-Summaries- und Anomaly-Highlighting-Panels über DATALAKE/ANOMALY-DETECTOR, mit einem ehrlichen statistischen Fallback.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — Flotten-CLI mit einem echten, stabilen Exit-Code-Vertrag, ein echter Live-Client der eigenen API von HYDRA-UMC-SERVER.
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — WearOS-Begleit-App mit haptischen Alarmmustern und einem Sprach-Relay zum gekoppelten Telefon (noch nicht auf einer physischen Uhr ausgeführt).
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — Firmware für ein Platinenmontagegestell mit echter Werkzeug-ID-Dekodierung und Smart-Idle-Vorheizlogik.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — Firmware plus ein echter Python-Vision-Begleiter für einen Thermal-/RGB-Inspektionswerkzeugkopf.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — administratives Desktop-Tool, das jedes Repository in diesem Ökosystem entdeckt, klont und aktualisiert.
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — Windows/Linux-Desktop-Tool, das ein flashbereites CM5-Image baut, vorgeladen mit den aktuellsten Versionen des Ökosystems, mit Ersteinrichtungs-Konfiguration für WLAN/Benutzer/SSH im Stil von Raspberry Pi Imager.
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — Wartungsvorfall-Koordinator: eine Edge-Rolle mit niedrigem Privileg sammelt einen bereinigten Inventar-/Gesundheits-Snapshot, eine Control-Plane-Rolle rendert ihn schreibgeschützt und bittet einen KI-Anbieter um einen Diagnosevorschlag - wendet nie einen Patch an und stellt nie etwas bereit.
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — reproduzierbarer Entwicklungshost (Raspberry Pi 5 / CM5), der den Quellcode des Ökosystems vorhält und begrenzte Build-/Test-Aufgaben über eine dauerhafte Warteschlange ausführt; eine dedizierte Entwicklerrolle, ausdrücklich kein operativer CM5.

## 📚 Dokumentation

Hier steht mehr:

* [Sicherheitsgrundlage des Ökosystems](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)
* [Bedrohungsmodell des Ökosystems](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)
* [Änderungsprotokoll dieses Repositorys](CHANGELOG.md)
* [Lizenz dieses Repositorys](LICENSE.md)

## 🤝 Mitwirken und Community

* Führe vor einem Pull Request `HYDRA_UMC_CI=1 py -3 tools/ci_validate.py` (oder `HYDRA_UMC_CI=1 python3 tools/ci_validate.py`) aus: Es muss `CI_VALIDATION=PASS` ausgeben. Führe dafür nicht `build.sh` oder `build.bat` aus; Bauen ist keine Prüfung.
* Die acht READMEs entstehen aus einer einzigen Quelle in HYDRA-UMC-DOCS; bearbeite sie nicht von Hand. Ändere die Quelle und schreibe sie mit `tools/make_readmes.py` neu.
* Behaupte in einer README nichts, was nicht gelaufen ist: Schreibe „simuliert“ oder „nicht auf Hardware erprobt“, wo das stimmt.
* Siehe [CONTRIBUTING.md](CONTRIBUTING.md), den [Verhaltenskodex](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md) und [SUPPORT.md](SUPPORT.md).

## 👤 AUTOR

**JuanenRac (Electro Hobby 3D)** · electrohobby3d@gmail.com

## 📜 LIZENZ

GPL-3.0-or-later - [LICENSE](LICENSE).

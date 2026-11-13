<!-- =============================================================================
HYDRA-UMC-OPCUA-SERVER - Operations guide
Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

# Operations Guide

What an integrator needs to run, connect to and safely expose this server.
Everything below describes what `src/server.ts` really does today; where
something is not implemented it says so.

## Endpoint and configuration

| Setting | Meaning | Default |
| --- | --- | --- |
| `HYDRA_UMC_OPCUA_PORT` | OPC-UA TCP port (1-65535, otherwise startup fails); wins over the shared `PORT` | `4840` |
| `PORT` | Last resort when `HYDRA_UMC_OPCUA_PORT` is not set (prints a warning, because several services of one machine read this variable) | unset |
| `OPCUA_ADMIN_USERNAME` / `OPCUA_ADMIN_PASSWORD` | The one authenticated account | unset = **no one can log in** |
| `OPCUA_ALLOW_INSECURE` | `1` also exposes an unencrypted `SecurityPolicy.None` endpoint | off |
| `OPCUA_AUTO_ACCEPT` | `1` accepts the application certificate of any client that connects (lab use). User certificates are never auto-accepted | off: unknown clients wait in `rejected/` until you trust them |
| `OPCUA_PKI_DIR` | Directory of the certificate stores (`PKI/` and `UserPKI/` below it). Put it on a persistent volume | the library's per-user default location |
| `OPCUA_ALTERNATE_HOSTNAME` | Extra host name the server certificate and the advertised endpoints use (the name your SCADA resolves) | the machine's host name |
| `OPCUA_LOGIN_MAX_FAILURES` | Failed logins allowed per minute before every login is refused until the minute passes | `10` |
| `HYDRA_SERVER_URL` + (`HYDRA_SERVER_TOKEN` or `HYDRA_SERVER_USER` + `HYDRA_SERVER_PASSWORD`) | Read the robot roster from HYDRA-UMC-SERVER (`GET /api/settings`, which only a logged-in account may read) and keep one `Robot_<id>` object per robot. An account is logged in with `POST /api/login` and logged in again, once, when the session is refused; a token expires with its session. A response over 4 MiB is refused | off |
| `HYDRA_SERVER_POLL_MS` | Roster polling interval in milliseconds (at least 1000) | `5000` |
| `HYDRA_UMC_SERVER_URL`, `_TOKEN`, `_USER`, `_PASSWORD`, `_POLL_MS` | The same five settings under the names the rest of the ecosystem uses (HYDRA-UMC-MTCONNECT-ADAPTER reads these). When both spellings are set, `HYDRA_UMC_SERVER_*` wins | unset |
| `OPCUA_VIEWER_USERNAME` / `OPCUA_VIEWER_PASSWORD` | An optional second account that can log in and read but never write (it is never the administrator). Its name must differ from `OPCUA_ADMIN_USERNAME` | unset |
| `HYDRA_UMC_OPCUA_SOURCE` | `poll` reads `GET /api/settings` every interval; `stream` keeps a WebSocket (`/ws`, schema 2, the token as the `hydra.bearer` subprotocol) open instead: the roster arrives when the connection opens and each patch of a robot is its "last seen" time. The connection comes back with a growing pause; while it is down the robots are shown offline with an uncertain quality. Needs Node 22 or newer | `poll` |
| `HYDRA_UMC_OPCUA_LIVENESS` | `1` makes `Online` follow `GET /api/robots/liveness` of HYDRA-UMC-SERVER instead of the `online` switch of the settings (only with `HYDRA_UMC_OPCUA_SOURCE=poll`; with `stream` the service refuses to start): a robot is online only while the server says `live`; `stale`, `unknown`, a robot the report does not list, a server without the route and a report that cannot be read all count as not online, and an unreadable report also makes the roster uncertain | off |
| `HYDRA_UMC_OPCUA_LIVE_WINDOW_MS` | How long after its last patch a robot is `Live` (at least 1000) | `30000` |
| `HYDRA_UMC_OPCUA_MQTT` | `1` makes the server follow the MQTT broker and show what the bridges publish on `hydra/bridges/+/opcua` as a read-only tree under `Fleet/<vehicle>/...` (see "Fleet from the MQTT broker" below). Settings: `HYDRA_UMC_OPCUA_MQTT_URL` (`mqtt://host[:port]`, default `mqtt://127.0.0.1:1883`; no TLS), `HYDRA_UMC_OPCUA_MQTT_TOPICS` (comma list of filters), `HYDRA_UMC_OPCUA_MQTT_USER` and `HYDRA_UMC_OPCUA_MQTT_PASSWORD_FILE` (an account whose password is in a file), `HYDRA_UMC_OPCUA_MQTT_STALE_MS` (at least 1000, default `60000`) | off |
| `OPCUA_ALLOW_ANONYMOUS` | `0` refuses anonymous sessions: every client must log in as the administrator or the viewer | anonymous may read |
| `HYDRA_UMC_OPCUA_HISTORY` | `1` switches Historical Access on (see "Historical access" below); it also needs `HYDRA_UMC_OPCUA_HISTORY_URL` and `HYDRA_UMC_OPCUA_HISTORY_MAP` | off |
| `OPCUA_HEALTH_PORT` / `OPCUA_HEALTH_HOST` | A separate HTTP listener with `GET /health` (JSON) and `GET /metrics` (Prometheus text): open sessions and subscriptions, sessions rejected, failed logins, login lock, robots and robots online, `SwarmOnline`, whether the roster can be read. It reads numbers only: no secret, no address-space value and no write path | off; host `127.0.0.1` |

The endpoint URL is printed at startup, with resource path
`/HYDRA-UMC-OPCUA-SERVER` (for example `opc.tcp://<host>:4840/HYDRA-UMC-OPCUA-SERVER`).
The service does not load a `.env` file: export the variables through
systemd, Docker or the shell. Never commit credentials.

## Security model

- **Sessions must sign.** Only `Sign` and `SignAndEncrypt` are offered, with
  `Basic256Sha256`, `Aes128_Sha256_RsaOaep` and `Aes256_Sha256_RsaPss`.
  `None` exists only when `OPCUA_ALLOW_INSECURE=1`, prints a warning, and is
  meant for a local smoke test - never for a real deployment.
- **Anonymous is read-only.** Every client that does not log in is
  `anonymous` and can browse and read.
- **Nothing is writable.** Every variable is read-only for every session,
  the administrator's included: nothing a client wrote ever reached
  HYDRA-UMC-SERVER, so a writable flag only gave a false sense of control. The
  administrator account still logs in (it is the identity for the audit trail);
  a user certificate is refused at login unless you put it in
  `UserPKI/trusted/certs/`.
- **Logins are bounded.** The password is compared in constant time, and after
  `OPCUA_LOGIN_MAX_FAILURES` failures in a minute every login is refused until
  that minute passes (an attacker can therefore also keep the administrator out
  for as long as the attack lasts).
- **No dangerous writes are published.** The only writable nodes are those
  two Booleans, and writing them changes a value held in this process only: it
  is not sent to HYDRA-UMC-SERVER and does not inhibit any robot or job. There
  is no actuator, setpoint or command node.

- **Quality of the robot `Online` variables.** `Robot_<id>.Online` is read with a
  `Good` status and, as source timestamp, the time the roster was last read. While
  HYDRA-UMC-SERVER cannot be read the value is `false` (a robot is never reported
  online on the strength of old data) and the status is
  `UncertainNoCommunicationLastUsableValue`, with the time of the last good read
  still as source timestamp, so a SCADA that looks at quality can tell "unknown"
  from a robot that is really offline.
- **Optional read-only account and no anonymous access.** `OPCUA_VIEWER_USERNAME`
  and `OPCUA_VIEWER_PASSWORD` add a login that can read and never write, for a
  poller that needs an identity of its own; `OPCUA_ALLOW_ANONYMOUS=0` then
  refuses anonymous sessions altogether. Both are off by default.

## Certificates

node-opcua generates the server's own application certificate on first start,
in the PKI store (`OPCUA_PKI_DIR`, on persistent storage in a deployment, or
every restart presents a new identity to your clients).

The server **does not trust a client by itself**: the first time a client
connects, its application certificate lands in `PKI/rejected/`, and the
connection is refused. Move that file to `PKI/trusted/certs/` (or set
`OPCUA_AUTO_ACCEPT=1` in a lab) and connect again. Clients must in turn trust
the server's certificate; the exact step depends on your client (UAExpert,
Ignition, TIA Portal ...). The stores for user certificates (`UserPKI/`) never
auto-accept, whatever `OPCUA_AUTO_ACCEPT` says. Certificate rotation is not
managed by this project.

## Address space

Namespace URI `urn:hydra-umc:opcua-server:v1`, namespace index 2 (index 1 is the local
namespace of the server, with the URI node-opcua gives it). NodeIds are explicit
strings, so they stay stable when nodes are added later. The namespace version
changes only on a breaking change to this shape. Read the index from the
namespace array of the server (or browse by name) instead of fixing it in a client.

**Old `ns=1` identifiers.** Earlier versions put the nodes in index 1. While
`OPCUA_LEGACY_NS_ALIAS` is on (the default) a request for `ns=1;s=NAME` is
answered with the node `ns=2;s=NAME`: reads, browses, subscriptions, history and
method calls. The alias adds no node and gives no write access. Set
`OPCUA_LEGACY_NS_ALIAS_UNTIL=YYYY-MM-DD` (in the environment file, see
`.env.example`) to end it after that day, or `OPCUA_LEGACY_NS_ALIAS=0` to turn it
off now. Move clients to `ns=2` before it ends. The alias covers NodeIds only: the
browse names of the nodes are in the same namespace now (`2:HydraNode_1`), so a client
that finds a node by browse path must use the index it reads from the namespace array.

| NodeId | Type | Access | Notes |
| --- | --- | --- | --- |
| `s=HydraNode_1` | `HydraCellType` object | - | Root object |
| `s=Robots` | Folder | - | Under `Objects`; holds the robot objects. NodeIds are the same as before; the browse path of a robot is now `Objects/Robots/Robot_<id>` |
| `s=HydraNode_1.SwarmOnline` | Boolean | read | `BadWaitingForInitialData` until the roster poller has read once (and always when no source is configured) |
| `s=HydraNode_1.ActiveRobotCount` | UInt32 | read | Robots of the roster whose `online` flag is true |
| `s=HydraNode_1.SpindleTemp` | Double (°C, range -20..150) | read | `BadWaitingForInitialData` until a real source reports a value (nothing feeds it today); then a real source timestamp, and quality drops to `UncertainLastUsableValue` when the source stops updating - the last value stays readable |
| `s=Robot_<id>` | `HydraRobotType` object under `s=Robots` | - | One per robot of the roster, with `Name` (String), `Online` (Boolean: the switch of the operator interface, not a measure of connectivity), `Live` (Boolean) and `LastUpdate` (DateTime), all read-only; the last two need `HYDRA_UMC_OPCUA_SOURCE=stream` and are `BadWaitingForInitialData` until the first patch of the robot. An id with characters outside letters, digits, `_` and `-` gets them replaced and a short hash appended |
| `s=HydraNode_1.MaintenanceMode` | Boolean | read | Always false: it is not wired to anything |

Honest limits: with `HYDRA_SERVER_URL` set, `SwarmOnline` is true only while
the last read of HYDRA-UMC-SERVER worked, and Bad before the first one; without a source it stays Bad.
`Online` (and so `ActiveRobotCount`) is the `online` flag HYDRA-UMC-SERVER keeps
for each robot, the one the operator interface toggles: it says the robot is
enabled there, not that its controller answered. Nothing feeds `SpindleTemp`.
There are no companion-specification types (OPC UA Robotics / DI) yet; the
robots hang from the Objects folder.

## Reconnection and subscriptions

Clients reconnect on their own; the server keeps no per-client state beyond
the OPC-UA session, so a restart simply ends sessions and clients must
re-establish them (and re-trust the certificate if the PKI store was lost).
Variables sample at a minimum of 1000 ms.

## Docker

The Gateway stack (`HYDRA-UMC-GATEWAY-INDUSTRIAL/docker-compose.yml`)
publishes port 4840. After pulling new code, rebuild the container:
`docker compose up -d --build` - a plain `git pull` does not change a
running container.

## Recovery

| Symptom | Likely cause |
| --- | --- |
| Client cannot connect | Certificate not trusted on one side, or a security mode/policy the client does not support |
| Client cannot connect, certificate in `PKI/rejected/` | Trust it: move it to `PKI/trusted/certs/` (or `OPCUA_AUTO_ACCEPT=1` in a lab) |
| Login refused | `OPCUA_ADMIN_*` not set, wrong credentials, or too many failed logins in the last minute |
| Write refused | Session is anonymous or certificate-based, not the administrator's user name and password |
| `PORT must be an integer` at startup | Invalid `PORT` value |

## Information model and roles

`nodeset/HydraUmc.NodeSet2.xml` is the model of the namespace as a NodeSet2 file (`HydraCellType` and `HydraRobotType` with their mandatory members, then the static cell); `npm run nodeset` writes it and a test fails when it differs from what the code builds. The members of the types are read-only.

Sessions hold OPC UA roles (Part 18): anonymous gets `Anonymous`, the viewer account `AuthenticatedUser` and `Observer`, the administrator also `ConfigureAdmin`, and any other identity (a user certificate) only `AuthenticatedUser`. Every node grants those roles Browse, Read and ReadRolePermissions and no role Write: the roles tell a SCADA who is who and make the absence of writes visible in `UserRolePermissions`. `Anonymous` is listed only while anonymous sessions are allowed.

## Historical access

A SCADA client can read the past of a variable (HistoryRead, raw values) and the server answers it from HYDRA-UMC-DATALAKE (`GET /history`), so there is no second database. It is **off** unless `HYDRA_UMC_OPCUA_HISTORY=1`.

| Setting | Meaning | Default |
| --- | --- | --- |
| `HYDRA_UMC_OPCUA_HISTORY` | `1` switches it on | off |
| `HYDRA_UMC_OPCUA_HISTORY_URL` | Address of HYDRA-UMC-DATALAKE | required when on |
| `HYDRA_UMC_OPCUA_HISTORY_TOKEN` | Its read token, when it has one | none |
| `HYDRA_UMC_OPCUA_HISTORY_MAP` | Path of a JSON file that maps variables to series | required when on |
| `HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS` | Most points one read takes from the data lake (1 to 200000) | `10000` |
| `HYDRA_UMC_OPCUA_HISTORY_TIMEOUT_MS` | Timeout of each request to the data lake | `10000` |
| `HYDRA_UMC_OPCUA_HISTORY_ANONYMOUS` | `1` lets anonymous sessions read history too | off |
| `HYDRA_UMC_OPCUA_HISTORY_AGGREGATES`, `HYDRA_UMC_OPCUA_HISTORY_MAX_INTERVALS` | Processed reads (see "Processed history" below) | off, `1000` |
| `HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS` | Processed reads use the windows and rollups of the data lake, with a fallback to the raw points | off |
| `HYDRA_UMC_OPCUA_HISTORY_EVENTS`, `HYDRA_UMC_OPCUA_HISTORY_EVENTS_MAP` | Event history (see "Event history" below) | off |

The map names a variable by its NodeId without `s=` and gives the series of the data lake that holds its values:

```json
{
  "HydraNode_1.SpindleTemp": {"sourceId": "arm-1", "kind": "spindle", "field": "temp"},
  "Robot_arm-1.Online": {"sourceId": "arm-1", "kind": "status", "field": "online"}
}
```

- Only the variables in the map get the HistoryRead access level; every other variable is unchanged, and no variable becomes writable.
- The data lake stores numbers: Boolean variables show a stored value as true when it is not zero, UInt32 variables round it.
- The window of a read is `[start, end)`: the start is included and the end is not (a read with the same instant twice returns that instant). With only an end and a number of values, the newest values come first. Bounding values are returned on request, and a bound that does not exist comes back as `BadBoundNotFound`. A long answer is paged with continuation points.
- A window with more points than `HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS` is cut at that number, and the console says so.
- If the data lake cannot be read, the read fails with an error status; nothing is invented.
- Reading history is a permission of its own (`ReadHistory`) on the mapped variables, granted to the logged-in roles; anonymous sessions have it only with `HYDRA_UMC_OPCUA_HISTORY_ANONYMOUS=1`.
- Reads at given times and modified-value reads are not supported (they answer `BadHistoryOperationUnsupported`). Processed history and event history are separate switches, described next; while they are off they answer `BadHistoryOperationUnsupported` too.

### Processed history (aggregates)

Off unless `HYDRA_UMC_OPCUA_HISTORY_AGGREGATES=1` (it needs `HYDRA_UMC_OPCUA_HISTORY=1`). A client reads aggregates with HistoryRead and a processing interval; the server cuts the time domain into intervals and computes one value for each from the raw points of the data lake.

| Setting | Meaning | Default |
| --- | --- | --- |
| `HYDRA_UMC_OPCUA_HISTORY_AGGREGATES` | `1` switches processed reads on | off |
| `HYDRA_UMC_OPCUA_HISTORY_MAX_INTERVALS` | Most intervals one read may ask for (1 to 100000) | `1000` |

- **Aggregates:** Average, Minimum, Maximum, Count and Interpolative (the Part 13 names). Any other aggregate answers `BadAggregateNotSupported`.
- **Intervals:** read forwards, an interval holds the points with `start <= time < end`; read backwards (end before start) the later time begins the interval and it holds `start < time <= end`. A processing interval of zero is one interval for the whole domain. The last interval is cut at the end of the domain and then carries the `HistorianPartial` bit. The value is stamped with the start of the interval in the direction of the read.
- **Average** is the arithmetic mean of the raw points of the interval (not time weighted); **Minimum** and **Maximum** their smallest and largest; **Count** their number. They carry `HistorianCalculated`. An interval without points is `BadNoData` (Count says `0`).
- **Interpolative** gives, at the start of each interval, the raw value when a point sits exactly there, otherwise the straight line between the nearest point before and the nearest point after (simple bounding values, `HistorianInterpolated`); with no point on one side the value is `BadNoData`.
- **Nothing is computed over part of the data:** a domain with more points than `HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS` answers `BadResponseTooLarge`, as does one with more intervals than the limit above. A data lake that cannot be read answers `BadResourceUnavailable`.
- The permission is the one of raw history: anonymous sessions have no processed history unless `HYDRA_UMC_OPCUA_HISTORY_ANONYMOUS=1`.

#### Using the windows and rollups of the data lake

Off unless `HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS=1` (it needs `HYDRA_UMC_OPCUA_HISTORY_AGGREGATES=1`; with only that switch the service refuses to start). With it, the average, minimum, maximum and count of a read (forwards or backwards) are not computed from the raw points: the server asks the data lake for `GET /windows` (count, min, max and sum per interval, one request however many points there are) and for `GET /rollups` (the same numbers for data that downsampling already replaced), and combines them. The answers are the same as the raw calculation (a differential test compares them over random data), and a domain with more points than `HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS` no longer needs to be refused.

| Setting | Meaning | Default |
| --- | --- | --- |
| `HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS` | `1` asks the windows and rollups of the data lake first | off (raw points, as before) |
| `HYDRA_UMC_OPCUA_HISTORY_ROLLUP_LOOKBACK_MS` | How far before a time the rollups are looked at when an Interpolative read is checked against them (1000 to 31536000000); a rollup bucket wider than this makes the answer uncertain | `604800000` (7 days) |

- **Backwards reads:** the intervals of a backwards read are open at the early end and closed at the late one, `(low, high]`. The server asks `GET /windows` with `order=desc` (windows aligned to the late end) and `GET /rollups` up to the late end; a data lake that does not know `order=desc` answers windows aligned to the start, which the server detects and does not use (the raw calculation answers instead).
- **Interpolative is not served from the windows** (it needs the bounding raw values, which windows do not carry); it uses the raw points as before. With this switch on it is also checked against the rollups: when the stretch between the nearest point before and the nearest point after the stamp holds rollup buckets, raw points existed there and were replaced, so a straight line would invent a value and "no data" would deny data that exists. That stamp comes back with no value and `UncertainDataSubNormal`. A point exactly on the stamp is always used. If the rollups cannot be read, or hold a bucket wider than the lookback, nothing can be ruled out and the stamps that are not on a point are Uncertain too (the lookback is also the limit: rollup buckets that start more than that before the first stamp and are narrower than it are not seen).
- **Fallback:** if `/windows` is not offered (`404`) or fails, if `/rollups` fails with anything but `404`, if the rollups cannot be trusted (more than two bucket widths in the domain, or two that do not divide each other, which would count a point twice, or a list as long as the limit of 200000 rows) or a window does not line up with an interval, the console says so and the raw calculation answers. `/rollups` answering `404` means downsampling is off there, so there are no rollups and the windows are enough. A data lake that is really down still answers `BadResourceUnavailable`.
- **Uncertain, not "no data", when the raw calculation answers over replaced data:** the raw points no longer include what downsampling already replaced by rollups. When the raw calculation answers an Average, Minimum, Maximum or Count (the fallback above) and an interval reaches into a stretch that only exists as rollups, that interval is `UncertainDataSubNormal` (with `HistorianCalculated` and `HistorianPartial`) instead of `BadNoData` or a value that looks complete: it keeps the value computed from the points that remain, if there are any, and has no value otherwise. If the rollups cannot be read, nothing can be ruled out and every interval of such a read is Uncertain. Where no rollup lies in the interval, an empty interval is still `BadNoData` and a count is `0`. With the switch off nothing changes.
- **Two rollup levels:** a data lake that runs its optional fine rollup level keeps, for the same points, a coarse bucket and the narrower buckets inside it. They are never added together: where the fine buckets inside a coarse bucket add up to exactly its count they replace it, so an interval edge that falls inside the coarse bucket is answered exactly instead of Uncertain; where they do not (the fine level was turned on later) the coarse bucket is used and the fine ones are ignored. Fine buckets without a coarse one stay. Backwards, the edges still have to sit one millisecond before the buckets. More than two widths, or two that do not divide each other, fall back to the raw calculation.
- **Rollups only when whole:** a rollup bucket is added to an interval only if it lies entirely inside it. A bucket that straddles the edge of an interval cannot be split, so that interval is answered from what can be used and carries `UncertainDataSubNormal` (with `HistorianCalculated` and `HistorianPartial`) instead of looking complete. A bucket covers `[bucketStart, bucketStart + bucketMs - 1]`: forwards it is whole in `[low, high)` when it starts at or after `low` and ends before `high`; backwards it is whole in `(low, high]` only when it starts after `low`, so intervals are exact when their edges fall on the edges of the buckets (backwards: one millisecond before them, because the early edge is open). The raw points of a bucket that was rolled up are gone, so the data lake cannot give them back: an interval cut inside a bucket stays Uncertain, there is no way to recompose it exactly.
- **Limit:** percentiles do not exist in rollups, but none of the five aggregates needs them. The data lake has to run with `--enable-window-stats` for `/windows` (and `--enable-downsampling` for `/rollups`); otherwise the fallback applies. Not tried against a data lake on the CM5, only against a stand-in and the real data lake code in its own tests.

### Event history

Off unless `HYDRA_UMC_OPCUA_HISTORY_EVENTS=1` (it needs `HYDRA_UMC_OPCUA_HISTORY=1` and `HYDRA_UMC_OPCUA_HISTORY_EVENTS_MAP`). The data lake stores numbers, not events, so the events are derived from the stored series by rules written in a JSON file; nothing is stored or invented.

```json
{
  "HydraNode_1": [
    {"name": "SpindleHot", "series": {"sourceId": "arm-1", "kind": "spindle", "field": "temp"}, "high": 80, "severity": 700, "message": "Spindle temperature above 80"}
  ]
}
```

- The key is the object (`HydraNode_1`, or `Robot_<id>`). A rule has a `name`, a `series`, `high` and/or `low` (the event happens when the value rises above `high` or falls below `low`), and optionally a `severity` (1 to 1000, default 500) and a `message`. Only the objects with rules get the HistoryRead bit in their EventNotifier.
- An event is one transition from within the limits to outside them. The first stored point counts as a transition when it is already outside; a window that starts while the value is already outside does not repeat it.
- The event carries the standard fields of BaseEventType: `EventId` (a stable identifier of the event), `EventType` (BaseEventType), `SourceNode`, `SourceName` (the rule name), `Time`, `ReceiveTime` (both the instant of the point), `Message` and `Severity`. Any other requested field is returned as `BadNoData`.
- The window works like a raw read: with a start and an end the events come oldest first (newest first when the end is before the start), with only an end and a number of values the newest come first. A long answer is paged with continuation points that are positions in the list of events of the read, so if the history changes between two calls the pages can shift.
- Not supported: a where clause in the event filter (it answers `BadEventFilterInvalid`) and live events. A window with more points than `HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS` in one rule answers `BadResponseTooLarge` instead of leaving events out.

## StartJob and AbortJob

Off unless `HYDRA_UMC_OPCUA_METHODS=1`. The two methods are on the object `HydraNode_1` (`ns=2;s=HydraNode_1.StartJob` and `.AbortJob`) and answer `Accepted` (Boolean) and `Message` (String); a refusal also gives the status BadUserAccessDenied. Every call goes through these steps in order and stops at the first that refuses: the session is the administrator's (user name and password; not anonymous, not the viewer account); the arguments are valid (a job id of letters, digits, `.`, `_` and `-`, up to 64; a priority of 0 to 1000); the order is written to the audit trail; the capability gate says `allowed`; the job queue takes the order; the outcome is written to the audit trail.

| Variable | Meaning |
|---|---|
| `HYDRA_UMC_OPCUA_METHODS` | `1` switches the methods on; the start fails when one of the next ones is missing. |
| `HYDRA_UMC_OPCUA_GATE_URL`, `_GATE_TOKEN` or `_GATE_TOKEN_FILE` | `serve-gate` of HYDRA-UMC-CONNECTOR-HUB and its bearer token (required). The adapter id it is asked about is `hydra-umc-opcua-server`, described by `docs/adapter-manifest.json`, which has to be in the registry of the hub. |
| `HYDRA_UMC_OPCUA_JOBS_URL`, `_JOBS_TOKEN` or `_JOBS_TOKEN_FILE` | HYDRA-UMC-JOB-DISPATCHER (the token may be empty for a dispatcher on loopback). |
| `HYDRA_UMC_OPCUA_AUDIT_URL`, `_AUDIT_TOKEN` or `_AUDIT_TOKEN_FILE` | The HYDRA-UMC-DATALAKE that keeps the audit trail: `sourceId` `opcua:<administrator>`, `kind` `method.StartJob` or `method.AbortJob`, the fields `job:<id>` and `phase.<order, ok or the reason of the refusal>`. |
| `HYDRA_UMC_OPCUA_METHOD_TIMEOUT_MS` | How long each of those services may take (200 to 30000, default 3000). |

This server cannot read a machine, so it tells the gate that the machine state is not observed (`allowUnobserved`); the answer of the gate says so, and the state of the cell is read by the gate service itself when it is started with a cell-state provider. A job that is already on a robot cannot be withdrawn by the queue: only the report of the robot ends it.

## Alarms and Conditions

Off unless `HYDRA_UMC_OPCUA_FAULTS_URL` is set. The feed is a JSON document `{"faults": [{"robot_id", "component", "error_code", "detail", "at_utc", "severity", "active"}]}`; `severity` (`fault` or `warning`) and `active` are optional. Without `severity` the error codes `ESTOP_ACTIVE`, `OUT_OF_RANGE`, `TOOL_INCOMPATIBLE` and `GRIP_LOST_SEAL` are faults and every other code is a warning. A component whose name contains `urtc` feeds `UrtcAlarm`, every other one `McuAlarm`. No service of the ecosystem publishes this feed yet; the server consumes it from whatever produces it.

Or, with `HYDRA_UMC_OPCUA_SERVER_FAULTS=1` (off by default; it cannot be set together with the address above), the alarms follow the faults that HYDRA-UMC-SERVER keeps: this server reads `GET /api/faults?active=1` with the identity it already uses for the roster (`HYDRA_UMC_SERVER_URL` with `HYDRA_UMC_SERVER_TOKEN`, or `HYDRA_UMC_SERVER_USER` and `HYDRA_UMC_SERVER_PASSWORD`, logging in again when the session ends) every `HYDRA_UMC_OPCUA_FAULTS_POLL_MS`. The SERVER must have its fault feed on (`HYDRA_UMC_FAULT_FEED=1`). Each active `fault-event/1` counts as a fault of the component named by its `source`: severity `warning` is a warning (400), `error` and `critical` are faults (800), `info` is left out. When the server cannot be read the alarms keep their state with an Uncertain quality.

## Mobile bridges

Off unless `HYDRA_UMC_OPCUA_BRIDGES=1`, and only with `HYDRA_UMC_OPCUA_SOURCE=poll` and a HYDRA-UMC-SERVER that has its bridge gateway switched on (otherwise `/api/bridges` answers 404 and the nodes show an Uncertain quality).

## Fleet from the MQTT broker

Off unless `HYDRA_UMC_OPCUA_MQTT=1`. The server subscribes to the broker (it only listens, it never publishes) and shows the nodes that a bridge publishes on `hydra/bridges/<bridge>/opcua` under a `Fleet` folder: `Fleet/<vehicle>/battery/charge` and so on, with the type each node declares (Double, Boolean, String or Int64). Nothing is writable. The message is `{"observed_at": <ms>, "vehicle": "<name>", "nodes": [{"path": "Fleet/<vehicle>/...", "type": "Double", "value": 80.5}]}`.

Every message is checked before a node is made: the vehicle and every segment of a path are plain names, the path starts with `Fleet/<vehicle>/`, the type is one of the four, the value has that type and is finite, a path is never both a value and a folder, and the size and the number of nodes (at most 200) are bounded. A message that fails any check is dropped whole and counted in the log. A vehicle that is silent for longer than `HYDRA_UMC_OPCUA_MQTT_STALE_MS` keeps its last values with an Uncertain quality. The connection to the broker comes back with a growing pause (1 s up to 30 s) after it drops. The broker is reached over plain TCP: run it on this machine or on a trusted network. Tested against a broker made for the tests and a real OPC UA client (simulator); a run against the real broker and a real fleet is pending.

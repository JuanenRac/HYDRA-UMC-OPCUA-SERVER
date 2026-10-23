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
| `PORT` | OPC-UA TCP port (1-65535, otherwise startup fails) | `4840` |
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
| `OPCUA_ALLOW_ANONYMOUS` | `0` refuses anonymous sessions: every client must log in as the administrator or the viewer | anonymous may read |
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

Namespace URI `urn:hydra-umc:opcua-server:v1`, namespace index 1. NodeIds are
explicit strings, so they stay stable when nodes are added later. The
namespace version changes only on a breaking change to this shape.

| NodeId | Type | Access | Notes |
| --- | --- | --- | --- |
| `s=HydraNode_1` | Object | - | Root object |
| `s=HydraNode_1.SwarmOnline` | Boolean | read | `BadWaitingForInitialData` until the roster poller has read once (and always when no source is configured) |
| `s=HydraNode_1.ActiveRobotCount` | UInt32 | read | Robots of the roster whose `online` flag is true |
| `s=HydraNode_1.SpindleTemp` | Double (°C, range -20..150) | read | `BadWaitingForInitialData` until a real source reports a value (nothing feeds it today); then a real source timestamp, and quality drops to `UncertainLastUsableValue` when the source stops updating - the last value stays readable |
| `s=Robot_<id>` | Object | - | One per robot of the roster, with `Name` (String) and `Online` (Boolean), both read-only. An id with characters outside letters, digits, `_` and `-` gets them replaced and a short hash appended |
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

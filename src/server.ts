// =============================================================================
// HYDRA-UMC OPCUA SERVER - OPC-UA Address Space Server: src/server.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Core industrial modeling module for the Gateway (see this project's own
// README.md for the full rationale). node-opcua does the actual protocol
// work (address space browsing, subscriptions, security policies); this
// file builds a minimal but real address space - one HydraNode object
// with a couple of variables - so any OPC-UA client (UAExpert, Ignition,
// Siemens TIA Portal, ...) can already connect, browse and read something
// real today. The per-robot tree (one Robot_<id> object per robot) is built
// by the setRobots() function buildAddressSpaceServer() returns, from
// whatever list the caller hands it.
//
// buildAddressSpaceServer() is exported (not just called from main() below)
// so tests/server.test.ts can start a real OPCUAServer on an ephemeral
// port and connect a real OPCUAClient against it - proving the address
// space is actually browsable/readable over the real protocol, not just
// that addObject()/addVariable() were called without throwing.
// =============================================================================

import {
  OPCUAServer,
  OPCUACertificateManager,
  Variant,
  DataType,
  DataValue,
  StatusCodes,
  MessageSecurityMode,
  SecurityPolicy,
  UserNameIdentityToken,
  PermissionType,
  makeRoles,
  getDefaultCertificateManager,
  type ISessionContext,
} from "node-opcua";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { readPackageVersion } from "./version.js";
import { livenessFromEnv, pollerConfigFromEnv, sourceModeFromEnv, startRobotPolling } from "./robotSource.js";
import { startRobotStream } from "./liveSource.js";
import { healthPortFromEnv, startHealthServer } from "./health.js";
import { resolveListenPort, type ResolvedPort } from "./portConfig.js";
import { historyConfigFromEnv, installHistory, type HistoryConfig } from "./history.js";
import { EVENT_NOTIFIER_HISTORY_READ, installEvents } from "./historyEvents.js";

// 4840 is the IANA-registered default OPC-UA TCP port, and node-opcua's
// own default - kept here explicitly (rather than relying on the library
// default) so it's obvious at a glance and overridable via HYDRA_UMC_OPCUA_PORT
// (first) or the shared PORT (last resort, with a warning).
export function resolveListenPortOf(env: NodeJS.ProcessEnv = process.env): ResolvedPort {
  return resolveListenPort(env, "HYDRA-UMC-OPCUA-SERVER", "HYDRA_UMC_OPCUA_PORT", 4840);
}

/** The shared `PORT` text on its own: the default is 4840, a value that is set but not a port is an error. */
export function resolvePort(raw: string | undefined = process.env.PORT): number {
  if (raw === undefined || raw.trim() === "") return 4840;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`HYDRA-UMC-OPCUA-SERVER: PORT must be an integer in 1..65535, got ${raw}`);
  }
  return port;
}

// A real, explicit, versioned namespace URI for this project's own address
// space, rather than node-opcua's implicit hostname-derived default - the
// review's own concern: "una actualizacion no debe cambiar
// silenciosamente la ruta que consume un cliente industrial". Bumped only
// on a real breaking change to the address space shape.
const NAMESPACE_URI = "urn:hydra-umc:opcua-server:v1";

/**
 * What a role may do with the nodes of this server: browse, read and read the role permissions. Nothing is writable by any role (not the
 * administrator's either): the variables are read-only, and no role carries the Write permission. The Anonymous role is listed only when
 * anonymous sessions are allowed, so switching them off (OPCUA_ALLOW_ANONYMOUS=0) is also visible in the permissions a client reads.
 */
export function readOnlyRolePermissions(allowAnonymous: boolean, history?: { anonymous: boolean }): Array<{ roleId: ReturnType<typeof makeRoles>[number]; permissions: number }> {
  const permissions = PermissionType.Browse | PermissionType.Read | PermissionType.ReadRolePermissions;
  const roles = ["AuthenticatedUser", "Observer", "ConfigureAdmin", ...(allowAnonymous ? ["Anonymous"] : [])];
  // Reading history is a permission of its own: only on the variables that have a history, and not for anonymous sessions unless it was asked for.
  return roles.map((role) => ({
    roleId: makeRoles(role)[0],
    permissions: history && (role !== "Anonymous" || history.anonymous) ? permissions | PermissionType.ReadHistory : permissions,
  }));
}

export interface BuildOptions {
  /** The history configuration; by default it comes from the environment (off unless HYDRA_UMC_OPCUA_HISTORY=1). */
  history?: HistoryConfig | null;
}

export interface HydraNodeState {
  /** null until something real reports it: the poller of HYDRA-UMC-SERVER, once its first read has finished. */
  swarmOnline: boolean | null;
  activeRobotCount: number;
  /** null until a real source has reported a temperature: nothing in this server measures one by itself. */
  spindleTempC: number | null;
  /** null until the first real report; while null SpindleTemp is served with a Bad status instead of an invented value. */
  spindleTempUpdatedAtMs: number | null;
  // real disconnection tracking, not simulated. true means whatever
  // real source feeds spindleTempC is still actively updating it; a real
  // caller sets this to false the moment it detects the source has
  // stopped (a timeout, a closed connection, ...) - see SpindleTemp's
  // own timestamped_get below for exactly what that changes on the wire.
  // Defaults true once a value has been reported; before the first report
  // (spindleTempUpdatedAtMs === null) the variable is Bad regardless.
  spindleTempConnected: boolean;
  maintenanceMode: boolean;
}

export interface CertificateManagers {
  serverCertificateManager: OPCUACertificateManager;
  userCertificateManager: OPCUACertificateManager;
}

/**
 * The PKI stores of the server.
 *
 *  - Application certificates (the clients' own, for the secure channel): an unknown one is accepted only when OPCUA_AUTO_ACCEPT=1 says so
 *    (a lab); otherwise it lands in `rejected/` and the operator moves it to `trusted/certs/` to let that client in.
 *  - User certificates (an X509 identity token): an unknown certificate is NEVER accepted, whatever OPCUA_AUTO_ACCEPT says.
 *
 * OPCUA_PKI_DIR puts both stores under a directory that should live on a persistent volume, so a container that is recreated keeps its own
 * certificate and the clients keep trusting it. Without it the library's per-user default location is used.
 */
export function createCertificateManagers(env: NodeJS.ProcessEnv = process.env): CertificateManagers {
  const autoAccept = (env.OPCUA_AUTO_ACCEPT ?? "").trim() === "1";
  const pkiDir = env.OPCUA_PKI_DIR?.trim();
  if (pkiDir) {
    return {
      serverCertificateManager: new OPCUACertificateManager({ name: "PKI", rootFolder: path.join(pkiDir, "PKI"), automaticallyAcceptUnknownCertificate: autoAccept }),
      userCertificateManager: new OPCUACertificateManager({ name: "UserPKI", rootFolder: path.join(pkiDir, "UserPKI"), automaticallyAcceptUnknownCertificate: false }),
    };
  }
  const serverCertificateManager = getDefaultCertificateManager("PKI");
  serverCertificateManager.automaticallyAcceptUnknownCertificate = autoAccept;
  const userCertificateManager = getDefaultCertificateManager("UserPKI");
  userCertificateManager.automaticallyAcceptUnknownCertificate = false;
  return { serverCertificateManager, userCertificateManager };
}

/** Compares two secrets in constant time (hashing first so the lengths do not leak). */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Bounds how many failed logins are tried: after `maxFailures` failures inside `windowMs`, every attempt is refused until the window passes,
 * even with the right password. It slows a guessing attack from the network down to a handful of attempts a minute; the price is that an
 * attacker can also keep the administrator out of the (few) writable variables for as long as the attack lasts.
 */
export class LoginThrottle {
  private failures: number[] = [];
  private total = 0;
  /** Every failed login since the process started (for the metrics). */
  get totalFailures(): number {
    return this.total;
  }
  constructor(
    private readonly maxFailures: number = 10,
    private readonly windowMs: number = 60_000,
  ) {}

  private prune(now: number): void {
    this.failures = this.failures.filter((at) => now - at < this.windowMs);
  }

  isLocked(now: number = Date.now()): boolean {
    this.prune(now);
    return this.failures.length >= this.maxFailures;
  }

  recordFailure(now: number = Date.now()): void {
    this.prune(now);
    this.total += 1;
    this.failures.push(now);
  }
}

/** True only for a session that logged in with the administrator's user name and password (never a certificate, never anonymous). */
export function isAdminSession(context: ISessionContext, adminUsername: string | undefined): boolean {
  if (!adminUsername) return false;
  const token = (context as { session?: { userIdentityToken?: unknown } }).session?.userIdentityToken;
  return token instanceof UserNameIdentityToken && token.userName === adminUsername;
}

/** Builds and starts a real OPCUAServer with one HydraNode_1 object exposing
 * SwarmOnline (read-only Boolean) and ActiveRobotCount (read-only UInt32).
 * `state` is returned so a caller (main() below, or a test) can mutate
 * activeRobotCount and observe the change reflected in a real OPC-UA read -
 * the get() closures below always read from this same object, never a
 * value captured at construction time. */
export async function buildAddressSpaceServer(port: number = resolveListenPortOf().port, options: BuildOptions = {}) {
  const history = options.history === undefined ? historyConfigFromEnv() : options.history;
  // Real username/password credentials for the one authenticated role this
  // v0 defines (see MaintenanceMode below) - sourced from real env vars,
  // never hardcoded. Unset means isValidUser rejects every credential, so
  // an undeployed instance never ships a silent default login.
  const adminUsername = process.env.OPCUA_ADMIN_USERNAME;
  const adminPassword = process.env.OPCUA_ADMIN_PASSWORD;
  // An optional second account that can log in and read but never write (a SCADA poller that needs an identity for its audit trail, or
  // that must keep working when anonymous access is switched off). It is never the administrator: isAdminSession compares the user name.
  const viewerUsername = process.env.OPCUA_VIEWER_USERNAME;
  const viewerPassword = process.env.OPCUA_VIEWER_PASSWORD;
  if (viewerUsername && viewerUsername === adminUsername) {
    // a session is the administrator's by user name, so a viewer with the same name would be one
    throw new Error("HYDRA-UMC-OPCUA-SERVER: OPCUA_VIEWER_USERNAME must differ from OPCUA_ADMIN_USERNAME");
  }
  // OPCUA_ALLOW_ANONYMOUS=0 turns anonymous sessions off: every client must log in (administrator or viewer). Default: anonymous may read, as before.
  const allowAnonymous = (process.env.OPCUA_ALLOW_ANONYMOUS ?? "").trim() !== "0";
  if (!allowAnonymous && !(adminUsername && adminPassword) && !(viewerUsername && viewerPassword)) {
    console.warn("[HYDRA-UMC-OPCUA-SERVER] OPCUA_ALLOW_ANONYMOUS=0 with no administrator or viewer account: nobody can open a session");
  }
  const maxFailures = Number(process.env.OPCUA_LOGIN_MAX_FAILURES);
  const throttle = new LoginThrottle(Number.isInteger(maxFailures) && maxFailures > 0 ? maxFailures : 10);
  const { serverCertificateManager, userCertificateManager } = createCertificateManagers();
  const alternateHostname = process.env.OPCUA_ALTERNATE_HOSTNAME?.trim();

  // Real gap found while auditing the code:
  // leaving securityModes/securityPolicies unset let node-opcua fall back
  // to ITS OWN defaults (see server_end_point.js's defaultSecurityModes),
  // which - despite this project's own "Encryption: Basic256Sha256" README
  // claim - still include MessageSecurityMode.None, and node-opcua adds a
  // REAL SecurityPolicy.None/MessageSecurityMode.None endpoint alongside
  // the encrypted ones whenever None is present in securityModes at all.
  // Any client (or attacker) could simply choose that endpoint and skip
  // encryption/signing entirely - the Basic256Sha256 default was real but
  // optional, not enforced. Explicit here, with None excluded: every real
  // session now requires Sign or SignAndEncrypt with a real, modern
  // security policy. OPCUA_ALLOW_INSECURE is a real, explicit, off-by-
  // default escape hatch for local development against a client that
  // cannot yet manage a certificate exchange (e.g. a quick UAExpert
  // smoke test) - never silently enabled, and loud about it when it is.
  const allowInsecure = process.env.OPCUA_ALLOW_INSECURE === "1";
  if (allowInsecure) {
    console.warn("[HYDRA-UMC-OPCUA-SERVER] OPCUA_ALLOW_INSECURE=1: exposing an UNENCRYPTED SecurityPolicy.None endpoint. Never set this in a real deployment.");
  }
  const securityModes = allowInsecure
    ? [MessageSecurityMode.None, MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt]
    : [MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt];
  const securityPolicies = [SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep, SecurityPolicy.Aes256_Sha256_RsaPss];

  const server = new OPCUAServer({
    port,
    resourcePath: "/HYDRA-UMC-OPCUA-SERVER",
    buildInfo: {
      productName: "HYDRA-UMC-OPCUA-SERVER",
      buildNumber: readPackageVersion(),
      buildDate: new Date(),
    },
    securityModes,
    securityPolicies,
    serverCertificateManager,
    userCertificateManager,
    allowAnonymous,
    ...(alternateHostname ? { alternateHostname } : {}),
    userManager: {
      // The roles of a logged-in user (OPC UA Part 18). The administrator is ConfigureAdmin, the viewer an Observer; any other identity (a
      // user certificate) is only an AuthenticatedUser. Anonymous sessions get the Anonymous role from the server itself.
      getUserRoles: (username: string) => {
        if (adminUsername && secretsMatch(username, adminUsername)) return makeRoles("AuthenticatedUser;Observer;ConfigureAdmin");
        if (viewerUsername && secretsMatch(username, viewerUsername)) return makeRoles("AuthenticatedUser;Observer");
        return makeRoles("AuthenticatedUser");
      },
      isValidUser: (username: string, password: string): boolean => {
        const accounts: Array<[string, string]> = [];
        if (adminUsername && adminPassword) accounts.push([adminUsername, adminPassword]);
        if (viewerUsername && viewerPassword) accounts.push([viewerUsername, viewerPassword]);
        if (accounts.length === 0) return false;
        if (throttle.isLocked()) {
          console.warn("[HYDRA-UMC-OPCUA-SERVER] too many failed logins: attempts are refused until the window passes");
          return false;
        }
        // Every account is always compared, so a wrong user name takes as long as a wrong password.
        let accepted = false;
        for (const [expectedUser, expectedPassword] of accounts) {
          const userOk = secretsMatch(username, expectedUser);
          const passwordOk = secretsMatch(password, expectedPassword);
          if (userOk && passwordOk) accepted = true;
        }
        if (accepted) return true;
        throttle.recordFailure();
        console.warn("[HYDRA-UMC-OPCUA-SERVER] failed login attempt");
        return false;
      },
    },
  });

  await server.initialize();

  // engine.addressSpace only exists after initialize() resolves - node-opcua
  // builds the base OPC-UA information model (the standard node set) at
  // that point, which is what getOwnNamespace()/rootFolder below build on
  // top of.
  const addressSpace = server.engine.addressSpace;
  if (!addressSpace) {
    throw new Error("HYDRA-UMC-OPCUA-SERVER: address space failed to initialize");
  }
  const namespace = addressSpace.getOwnNamespace();
  // A real, explicit URI instead of node-opcua's implicit hostname-derived
  // default - see NAMESPACE_URI's own doc comment above. Same namespace
  // index (1) as before, so existing browse-by-name lookups are unaffected.
  namespace.namespaceUri = NAMESPACE_URI;

  // Placeholder address space: one HydraNode object exposing a few
  // variables. Real deployments generate one such object per active
  // robot/tool from HYDRA-UMC-SERVER's own state (see the "Dynamic
  // Information Modeling" feature in README.md) - this proves the tree
  // shape and variable typing are already correct end to end. Explicit
  // string NodeIds (rather than node-opcua's auto-assigned numeric ones)
  // give this project's own address-space paths real stability - adding a
  // future DataItem before these in the file can never silently renumber
  // an existing one, the exact risk the review called out.
  const rolePermissions = readOnlyRolePermissions(allowAnonymous);
  const historyRolePermissions = history ? readOnlyRolePermissions(allowAnonymous, { anonymous: history.allowAnonymous }) : rolePermissions;
  // A variable that the history map names gets the HistoryRead access level and the permission for it; the others stay as they were.
  const historyProps = (name: string) =>
    history?.mapping[name]
      ? { accessLevel: "CurrentRead | HistoryRead", userAccessLevel: "CurrentRead | HistoryRead", rolePermissions: historyRolePermissions }
      : {};
  // An object with event rules gets the HistoryRead bit in its EventNotifier and the permission for it; the others stay as they were.
  const eventProps = (objectKey: string) =>
    history?.events?.[objectKey] ? { eventNotifier: EVENT_NOTIFIER_HISTORY_READ, rolePermissions: historyRolePermissions } : { rolePermissions };
  const withEvents = (object: any, objectKey: string): void => {
    const rules = history?.events?.[objectKey];
    if (history && rules) installEvents(object, history, objectKey, rules);
  };
  const withHistory = (variable: any, name: string, dataType: DataType): void => {
    const series = history?.mapping[name];
    if (history && series) installHistory(variable, history, series, dataType);
  };

  // The information model of this namespace (exported as nodeset/HydraUmc.NodeSet2.xml by tools/export_nodeset.ts): a type for the cell and a
  // type for a robot, so a client that understands types can tell what an object is from its type and not from its name. The members of a type
  // are declared Mandatory; an instance below has each of them under a stable, explicit NodeId.
  const declareMember = (type: any, name: string, dataType: string) =>
    namespace.addVariable({
      componentOf: type,
      browseName: name,
      nodeId: `s=${type.browseName.name}.${name}`,
      dataType,
      accessLevel: "CurrentRead",
      userAccessLevel: "CurrentRead",
      modellingRule: "Mandatory",
    });
  const cellType = namespace.addObjectType({ browseName: "HydraCellType", nodeId: "s=HydraCellType" });
  declareMember(cellType, "SwarmOnline", "Boolean");
  declareMember(cellType, "ActiveRobotCount", "UInt32");
  declareMember(cellType, "SpindleTemp", "Double");
  declareMember(cellType, "MaintenanceMode", "Boolean");
  const robotType = namespace.addObjectType({ browseName: "HydraRobotType", nodeId: "s=HydraRobotType" });
  declareMember(robotType, "Name", "String");
  declareMember(robotType, "Online", "Boolean");
  declareMember(robotType, "Live", "Boolean");
  declareMember(robotType, "LastUpdate", "DateTime");

  const hydraNode = namespace.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "HydraNode_1",
    nodeId: "s=HydraNode_1",
    typeDefinition: cellType,
    ...eventProps("HydraNode_1"),
  });
  withEvents(hydraNode, "HydraNode_1");
  const robotsFolder = namespace.addFolder(addressSpace.rootFolder.objects, { browseName: "Robots", nodeId: "s=Robots", rolePermissions });

  const state: HydraNodeState = {
    swarmOnline: null,
    activeRobotCount: 0,
    // Nothing in this server measures a spindle temperature: until a real source reports one the variable is Bad.
    spindleTempC: null,
    spindleTempUpdatedAtMs: null,
    spindleTempConnected: true,
    maintenanceMode: false,
  };

  // SwarmOnline is read-only: nothing that a client wrote here ever reached HYDRA-UMC-SERVER, so a writable flag only gave a false sense
  // of control. It is served with BadWaitingForInitialData until the poller has made its first read (and always, when no source is
  // configured): a literal "true" would be an invented value.
  const swarmOnlineNode = namespace.addVariable({
    componentOf: hydraNode,
    browseName: "SwarmOnline",
    nodeId: "s=HydraNode_1.SwarmOnline",
    rolePermissions,
    dataType: "Boolean",
    accessLevel: "CurrentRead",
    userAccessLevel: "CurrentRead",
    ...historyProps("HydraNode_1.SwarmOnline"),
    minimumSamplingInterval: 1000,
    value: {
      timestamped_get: () =>
        state.swarmOnline === null
          ? new DataValue({ value: new Variant({ dataType: DataType.Null }), statusCode: StatusCodes.BadWaitingForInitialData })
          : new DataValue({ value: new Variant({ dataType: DataType.Boolean, value: state.swarmOnline }), statusCode: StatusCodes.Good }),
    },
  });

  const activeRobotCountNode = namespace.addVariable({
    componentOf: hydraNode,
    browseName: "ActiveRobotCount",
    nodeId: "s=HydraNode_1.ActiveRobotCount",
    rolePermissions,
    dataType: "UInt32",
    accessLevel: "CurrentRead",
    userAccessLevel: "CurrentRead",
    ...historyProps("HydraNode_1.ActiveRobotCount"),
    minimumSamplingInterval: 1000,
    value: {
      get: () => new Variant({ dataType: DataType.UInt32, value: state.activeRobotCount }),
    },
  });

  // A real DataItem carrying its own real quality and UTC sourceTimestamp
  // (via `timestamped_get`, node-opcua's own documented mechanism for full
  // control over the DataValue, distinct from the simple `get()` above
  // which auto-stamps "now" on every read) plus a real, standard OPC-UA
  // EngineeringUnits (part 8 AnalogItemType) - the review's own
  // "asociar unidad, calidad y timestamp a cada variable". sourceTimestamp
  // reflects when the value actually last changed, not when it was read -
  // real historian semantics, not a stamp that lies about freshness.
  //
  // ("calidad y tiempo de origen coherentes con la fuente"): quality
  // is likewise mapped from the real observation, not from the fact that
  // a read happened to succeed. A `Good` statusCode paired with a stale
  // sourceTimestamp would let a client compute staleness by hand but
  // still see "Good" at a glance - real historian software, and this
  // project's own README, both treat quality as the primary signal.
  // `UncertainLastUsableValue` is node-opcua's own real, standard OPC-UA
  // status code for exactly this situation ("Whatever was updating this
  // value has stopped doing so.") - the LAST real value is kept and
  // still readable (never fabricated, never withheld), only its quality
  // degrades, with sourceTimestamp still honestly pointing at when it
  // was last genuinely observed. A correct certificate and write
  // permission on the session never overrides this - they authenticate
  // the CLIENT, not the freshness of the DATA.
  const spindleTempNode = namespace.addAnalogDataItem({
    componentOf: hydraNode,
    browseName: "SpindleTemp",
    nodeId: "s=HydraNode_1.SpindleTemp",
    rolePermissions,
    dataType: "Double",
    accessLevel: "CurrentRead",
    userAccessLevel: "CurrentRead",
    ...historyProps("HydraNode_1.SpindleTemp"),
    minimumSamplingInterval: 1000,
    engineeringUnits: { displayName: "°C", description: "degree Celsius", namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact", unitId: 4408652 },
    engineeringUnitsRange: { low: -20, high: 150 },
    value: {
      timestamped_get: () =>
        state.spindleTempC === null || state.spindleTempUpdatedAtMs === null
          ? new DataValue({ value: new Variant({ dataType: DataType.Null }), statusCode: StatusCodes.BadWaitingForInitialData })
          : new DataValue({
              value: new Variant({ dataType: DataType.Double, value: state.spindleTempC }),
              statusCode: state.spindleTempConnected ? StatusCodes.Good : StatusCodes.UncertainLastUsableValue,
              sourceTimestamp: new Date(state.spindleTempUpdatedAtMs),
            }),
    },
  });

  // Read-only too: a MaintenanceMode written from a SCADA never inhibited anything in HYDRA-UMC-SERVER, and an operator could believe the
  // cell was locked out. It stays false until a contract with the server exists that would make a write mean something (and that
  // contract has to go through the SDK gate and the server's command reservation).
  const maintenanceModeNode = namespace.addVariable({
    componentOf: hydraNode,
    browseName: "MaintenanceMode",
    nodeId: "s=HydraNode_1.MaintenanceMode",
    rolePermissions,
    dataType: "Boolean",
    accessLevel: "CurrentRead",
    userAccessLevel: "CurrentRead",
    ...historyProps("HydraNode_1.MaintenanceMode"),
    minimumSamplingInterval: 1000,
    value: {
      get: () => new Variant({ dataType: DataType.Boolean, value: state.maintenanceMode }),
    },
  });
  withHistory(swarmOnlineNode, "HydraNode_1.SwarmOnline", DataType.Boolean);
  withHistory(activeRobotCountNode, "HydraNode_1.ActiveRobotCount", DataType.UInt32);
  withHistory(spindleTempNode, "HydraNode_1.SpindleTemp", DataType.Double);
  withHistory(maintenanceModeNode, "HydraNode_1.MaintenanceMode", DataType.Boolean);

  // One object per robot, built from whatever list the caller hands to
  // setRobots(). Node ids are derived from the robot id ("s=Robot_<id>"),
  // so a robot keeps the same path for as long as it exists. A robot that
  // is no longer in the list has its object and variables removed, and
  // ActiveRobotCount follows the number of robots reported online.
  const robotObjects = new Map<string, { object: any; state: RobotSnapshot; seenAtMs?: number }>();
  let rosterMeta: RosterMeta = { stale: false };
  // How recent a patch from a robot must be for it to count as Live (HYDRA_UMC_OPCUA_LIVE_WINDOW_MS, at least one second).
  const liveWindowMs = liveWindowFromEnv();
  const seenBeforeListed = new Map<string, number>();

  // A robot sent something to HYDRA-UMC-SERVER (a patch on the live stream): this is the liveness signal, which the Online flag of the
  // operator interface is not. A robot that is not in the tree yet keeps the time until it is.
  const markRobotSeen = (id: string | number, atMs: number): void => {
    const key = robotNodeKey(id);
    const entry = robotObjects.get(key);
    if (entry) entry.seenAtMs = Math.max(entry.seenAtMs ?? 0, atMs);
    else seenBeforeListed.set(key, atMs);
  };

  const setRobots = (robots: RobotSnapshot[], meta: RosterMeta = { stale: false }): void => {
    // the last successful read keeps its time while the roster is stale
    rosterMeta = { stale: meta.stale, observedAtMs: meta.observedAtMs ?? rosterMeta.observedAtMs };
    const wanted = new Map<string, RobotSnapshot>();
    for (const robot of robots) {
      const key = robotNodeKey(robot.id);
      if (key === "") continue;
      if (wanted.has(key)) console.warn(`[HYDRA-UMC-OPCUA-SERVER] two robots map to the node Robot_${key}; the later one wins`);
      wanted.set(key, robot);
    }
    for (const [key, entry] of [...robotObjects]) {
      if (wanted.has(key)) continue;
      for (const child of entry.object.getComponents()) addressSpace.deleteNode(child);
      addressSpace.deleteNode(entry.object);
      robotObjects.delete(key);
    }
    for (const [key, robot] of wanted) {
      const known = robotObjects.get(key);
      if (known) {
        known.state = { ...robot };
        continue;
      }
      const entry = {
        object: namespace.addObject({
          organizedBy: robotsFolder,
          browseName: `Robot_${key}`,
          nodeId: `s=Robot_${key}`,
          typeDefinition: robotType,
          ...eventProps(`Robot_${key}`),
        }),
        state: { ...robot },
        seenAtMs: seenBeforeListed.get(key),
      };
      withEvents(entry.object, `Robot_${key}`);
      seenBeforeListed.delete(key);
      namespace.addVariable({
        componentOf: entry.object,
        browseName: "Name",
        nodeId: `s=Robot_${key}.Name`,
        rolePermissions,
        dataType: "String",
        accessLevel: "CurrentRead",
        userAccessLevel: "CurrentRead",
        value: { get: () => new Variant({ dataType: DataType.String, value: entry.state.name }) },
      });
      const onlineNode = namespace.addVariable({
        componentOf: entry.object,
        browseName: "Online",
        nodeId: `s=Robot_${key}.Online`,
        rolePermissions,
        dataType: "Boolean",
        accessLevel: "CurrentRead",
        userAccessLevel: "CurrentRead",
        ...historyProps(`Robot_${key}.Online`),
        minimumSamplingInterval: 1000,
        // While the roster cannot be read the robot is not claimed online, and the quality says the value is the last one that was usable:
        // a SCADA that looks at quality sees "uncertain" instead of a plain false it cannot tell from a robot that is really off.
        value: {
          timestamped_get: () =>
            new DataValue({
              value: new Variant({ dataType: DataType.Boolean, value: entry.state.online }),
              statusCode: rosterMeta.stale ? StatusCodes.UncertainNoCommunicationLastUsableValue : StatusCodes.Good,
              ...(rosterMeta.observedAtMs !== undefined ? { sourceTimestamp: new Date(rosterMeta.observedAtMs) } : {}),
            }),
        },
      });
      // Live: the robot sent a patch to the server within the window. It needs the live stream (HYDRA_UMC_OPCUA_SOURCE=stream); with polling
      // there is nothing that says a robot is alive, so the value stays BadWaitingForInitialData instead of being guessed from Online.
      const liveNode = namespace.addVariable({
        componentOf: entry.object,
        browseName: "Live",
        nodeId: `s=Robot_${key}.Live`,
        rolePermissions,
        dataType: "Boolean",
        accessLevel: "CurrentRead",
        userAccessLevel: "CurrentRead",
        ...historyProps(`Robot_${key}.Live`),
        minimumSamplingInterval: 1000,
        value: {
          timestamped_get: () => {
            if (entry.seenAtMs === undefined) {
              return new DataValue({ value: new Variant({ dataType: DataType.Null }), statusCode: StatusCodes.BadWaitingForInitialData });
            }
            return new DataValue({
              value: new Variant({ dataType: DataType.Boolean, value: !rosterMeta.stale && Date.now() - (entry.seenAtMs ?? 0) <= liveWindowMs }),
              statusCode: rosterMeta.stale ? StatusCodes.UncertainNoCommunicationLastUsableValue : StatusCodes.Good,
              sourceTimestamp: new Date(entry.seenAtMs),
            });
          },
        },
      });
      namespace.addVariable({
        componentOf: entry.object,
        browseName: "LastUpdate",
        nodeId: `s=Robot_${key}.LastUpdate`,
        rolePermissions,
        dataType: "DateTime",
        accessLevel: "CurrentRead",
        userAccessLevel: "CurrentRead",
        minimumSamplingInterval: 1000,
        value: {
          timestamped_get: () =>
            entry.seenAtMs === undefined
              ? new DataValue({ value: new Variant({ dataType: DataType.Null }), statusCode: StatusCodes.BadWaitingForInitialData })
              : new DataValue({
                  value: new Variant({ dataType: DataType.DateTime, value: new Date(entry.seenAtMs) }),
                  statusCode: StatusCodes.Good,
                  sourceTimestamp: new Date(entry.seenAtMs),
                }),
        },
      });
      withHistory(onlineNode, `Robot_${key}.Online`, DataType.Boolean);
      withHistory(liveNode, `Robot_${key}.Live`, DataType.Boolean);
      robotObjects.set(key, entry);
    }
    state.activeRobotCount = [...robotObjects.values()].filter((e) => e.state.online).length;
  };

  await server.start();

  return { server, state, setRobots, markRobotSeen, throttle, robotCount: () => robotObjects.size, liveRobotCount: () => [...robotObjects.values()].filter((e) => e.seenAtMs !== undefined && !rosterMeta.stale && Date.now() - e.seenAtMs <= liveWindowMs).length };
}

/** The window (milliseconds) within which a patch from a robot keeps it Live; HYDRA_UMC_OPCUA_LIVE_WINDOW_MS, at least 1000, default 30000. */
export function liveWindowFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYDRA_UMC_OPCUA_LIVE_WINDOW_MS?.trim();
  if (!raw) return 30_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000) {
    throw new Error(`HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_LIVE_WINDOW_MS must be an integer of at least 1000, got ${raw}`);
  }
  return value;
}

/**
 * The node name of a robot. An id made only of letters, digits, `_` and `-` is used as it is; any other id gets its unusable characters
 * replaced and a short hash of the original appended, so "a.b" and "a_b" never end up on the same node.
 */
export function robotNodeKey(id: string | number): string {
  const text = String(id);
  const clean = text.replace(/[^A-Za-z0-9_-]/g, "_");
  if (clean === text) return clean;
  const suffix = createHash("sha1").update(text).digest("hex").slice(0, 6);
  return clean === "" ? `_${suffix}` : `${clean}_${suffix}`;
}

/** What the address space knows about one robot; fed from the caller's own source. */
export interface RobotSnapshot {
  id: string | number;
  name: string;
  online: boolean;
}

/** How fresh a roster is. Sent with setRobots; omitted means "as good as before this existed" (served as Good). */
export interface RosterMeta {
  /** true when the roster could not be read and `online` is only the safe default (false): the Online variables are served with an Uncertain quality. */
  stale: boolean;
  /** When (unix milliseconds) the roster was last read successfully; becomes the source timestamp of the Online variables. */
  observedAtMs?: number;
}

async function main() {
  const listen = resolveListenPortOf();
  if (listen.warning) console.warn(`[HYDRA-UMC-OPCUA-SERVER] ${listen.warning}`);
  const port = listen.port;
  const { server, state, setRobots, markRobotSeen, throttle, robotCount, liveRobotCount } = await buildAddressSpaceServer(port);
  const health = healthPortFromEnv();
  let sourceStatus: "not configured" | "ok" | "unreadable" = "not configured";
  const shutdown = (signal: string) => {
    console.log(`[HYDRA-UMC-OPCUA-SERVER] ${signal} received: closing the sessions`);
    server
      .shutdown(1000)
      .catch((err) => console.error("[HYDRA-UMC-OPCUA-SERVER] shutdown error:", err))
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  const source = pollerConfigFromEnv();
  if (source) {
    // With a source configured, SwarmOnline follows it: it is Bad until the first read ends, then true only while the last read of HYDRA-UMC-SERVER worked.
    const onSourceStatus = (readable: boolean): void => {
      state.swarmOnline = readable;
      sourceStatus = readable ? "ok" : "unreadable";
    };
    if (sourceModeFromEnv() === "stream") {
      if (livenessFromEnv()) throw new Error("HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_LIVENESS needs HYDRA_UMC_OPCUA_SOURCE=poll (the stream does not read the liveness report)");
      startRobotStream({ ...source, setRobots, onRobotSeen: markRobotSeen, onSourceStatus });
      console.log(`[HYDRA-UMC-OPCUA-SERVER] following the robots live on ${source.url} (WebSocket), Live = a patch within the window`);
    } else {
      startRobotPolling({ ...source, setRobots, onSourceStatus, useLiveness: livenessFromEnv() });
      console.log(`[HYDRA-UMC-OPCUA-SERVER] reading the robot roster from ${source.url} every ${source.intervalMs} ms`);
    }
    sourceStatus = "unreadable"; // until the first read works
  }
  if (health) {
    const listener = startHealthServer({
      ...health,
      snapshot: () => ({
        version: readPackageVersion(),
        sessions: server.currentSessionCount,
        subscriptions: server.engine.currentSubscriptionCount,
        rejectedSessions: Number(server.engine.serverDiagnosticsSummary.rejectedSessionCount ?? 0),
        cumulatedSessions: Number(server.engine.serverDiagnosticsSummary.cumulatedSessionCount ?? 0),
        failedLogins: throttle.totalFailures,
        loginLocked: throttle.isLocked(),
        robots: robotCount(),
        activeRobots: state.activeRobotCount,
        liveRobots: liveRobotCount(),
        swarmOnline: state.swarmOnline === true,
        source: sourceStatus,
      }),
    });
    listener.on("error", (err) => console.error("[HYDRA-UMC-OPCUA-SERVER] health listener error:", err));
    process.once("exit", () => listener.close());
    console.log(`[HYDRA-UMC-OPCUA-SERVER] health and metrics on http://${health.host}:${health.port} (GET /health, GET /metrics)`);
  }
  const endpointUrl = server.getEndpointUrl();
  console.log("=================================================");
  console.log(` HYDRA-UMC-OPCUA-SERVER v${readPackageVersion()}`);
  console.log(" ROLE: Full mapping of HydraState objects to OPC-UA address spaces");
  console.log(` STATUS: Running on port ${port} - endpoint ${endpointUrl}`);
  console.log("=================================================");
}

// Only auto-start when run directly (node/tsx src/server.ts, or the
// bundled dist/server.cjs), not when imported by tests/server.test.ts -
// comparing basenames rather than full URLs sidesteps file:// vs Windows
// backslash-path mismatches entirely.
const entryFile = process.argv[1] ? path.basename(process.argv[1]) : "";
if (entryFile === "server.ts" || entryFile === "server.cjs" || entryFile === "server.js") {
  main().catch((err) => {
    console.error("[HYDRA-UMC-OPCUA-SERVER] fatal startup error:", err);
    process.exit(1);
  });
}

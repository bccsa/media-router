// ============================================================================
// Media Router v2.0 — Zod Validation Schemas for System Boundaries
// ============================================================================

import { z } from 'zod';

// --- Patch Operations -------------------------------------------------------

/** Validates a single RFC 6902 JSON Patch operation. */
export const PatchOpSchema = z.object({
    op: z.enum(['add', 'replace', 'remove']),
    path: z.string(),
    value: z.unknown().optional(),
});

/** Validates a non-empty array of patch operations. */
export const PatchOpsSchema = z.array(PatchOpSchema).min(1);

// --- dgram-comms Wire Format ------------------------------------------------

/** Validates the decrypted data envelope inside a dgram message. */
export const DgramDataSchema = z.object({
    topic: z.string().optional(),
    message: z.unknown().optional(),
    ackID: z.number().optional(),
    socketID: z.string().optional(),
});

/**
 * Validates the raw dgram-comms wire message after JSON.parse.
 * Note: `data` can be a string (encrypted) or an object (plaintext/decrypted).
 */
export const DgramWireMessageSchema = z.object({
    type: z.enum(['data', 'keepAlive', 'ack', 'connect', 'connected', 'reset']),
    clientID: z.string(),
    iv: z.string().optional(),
    seq: z.number().optional(),
    data: z.union([z.string(), DgramDataSchema]),
});

// --- Engine Event Payloads --------------------------------------------------

/** Engine running state report. */
export const EngineRunningStateSchema = z.object({
    running: z.boolean(),
});

/** LCP engine command (start/stop). */
export const LcpEngineCommandSchema = z.object({
    command: z.enum(['start', 'stop']),
});

/** Dynamic port update from engine. */
export const DynamicPortsSchema = z.object({
    moduleId: z.string().min(1),
    ports: z.array(z.unknown()),
});

/** Engine reports a host-reboot failure (typically a polkit denial). */
export const RebootFailedSchema = z.object({
    reason: z.string(),
});

/** Patch envelope (ops wrapper). */
export const PatchEnvelopeSchema = z.object({
    ops: PatchOpsSchema,
});

// --- Manager Socket RPC Payloads --------------------------------------------
//
// All manager mutations + reads flow through Socket.IO with an ack callback.
// The HTTP API was retired — only `/health` and the SPA's static assets are
// served over HTTP now. Each event accepts a payload and returns
// `Ack<T> = { ok: true; data?: T } | { ok: false; error: string; details? }`
// via the ack callback.
//
// Schemas below are shared between the manager (which validates incoming
// payloads with `safeParse`) and the manager-ui (which builds payloads of
// the same shape).

/**
 * Engine identifier — also the dgram-comms `clientId` and the SQLite PK across
 * `engines`, `engine_profiles`, `engine_config_history`. Restricted to a safe
 * URL-token charset so the id is round-trippable through log lines,
 * filesystem paths (engine-side `profile.name`), and Socket.IO room names
 * (`watch:<engineId>`) without needing escaping anywhere. Length cap matches what a typical operator
 * deployment will use (e.g. `studio-a-engine`) without being so long that it
 * pollutes log output.
 */
export const EngineIdSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
        'Engine ID must start with a letter or digit and contain only letters, digits, dot, dash, underscore',
    );
// First char alphanumeric on purpose — keeps `..`, `.hidden`, `-flag` out of
// id space. The engine writes `profile.name` to `~/.media-router/profiles.json`
// so any path-traversal-looking id would be more confusing than useful.

const ProfileNameSchema = z.string().min(1).max(64);
const HexColor = z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
// Group ids are server-generated (`grp_*`), but the schema is permissive
// because the special `ungrouped` id and any future seeded groups must also
// round-trip. Same charset rationale as EngineIdSchema.
const GroupIdSchema = z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** `engine:create` */
export const CreateEngineSchema = z.object({
    engineId: EngineIdSchema,
    displayName: z.string().min(1),
    password: z.string().min(1),
});

/**
 * `engine:update` — `engineId` is the current row's PK. If `newEngineId` is
 * provided and differs, the row is renamed atomically along with display_name
 * and password (see `ConfigStore.renameEngine`).
 */
export const UpdateEngineSchema = z.object({
    engineId: EngineIdSchema,
    displayName: z.string().min(1),
    password: z.string().optional(),
    newEngineId: EngineIdSchema.optional(),
});

/** `engine:delete` */
export const DeleteEngineSchema = z.object({ engineId: EngineIdSchema });

/** `engine:reorder` */
export const ReorderEnginesSchema = z.object({
    updates: z
        .array(
            z.object({
                engineId: EngineIdSchema,
                groupId: GroupIdSchema,
                sortOrder: z.number().int().nonnegative(),
            }),
        )
        .min(1),
});

/** `engine-group:create` */
export const CreateGroupSchema = z.object({
    name: z.string().min(1).max(64),
    color: HexColor.optional(),
});

/** `engine-group:update` */
export const UpdateGroupSchema = z.object({
    groupId: GroupIdSchema,
    name: z.string().min(1).max(64).optional(),
    collapsed: z.boolean().optional(),
    color: HexColor.nullable().optional(),
});

/** `engine-group:delete` */
export const DeleteGroupSchema = z.object({ groupId: GroupIdSchema });

/** `engine-group:reorder` */
export const ReorderGroupsSchema = z.object({
    orderedIds: z.array(GroupIdSchema).min(1),
});

/** `profile:list` */
export const ListProfilesSchema = z.object({ engineId: EngineIdSchema });

/** `profile:create` */
export const CreateManagerProfileSchema = z.object({
    engineId: EngineIdSchema,
    profileName: ProfileNameSchema,
    config: z.record(z.string(), z.unknown()).optional(),
});

/** `profile:delete` */
export const DeleteProfileSchema = z.object({
    engineId: EngineIdSchema,
    profileName: ProfileNameSchema,
});

/** `profile:activate` */
export const ActivateProfileSchema = z.object({
    engineId: EngineIdSchema,
    profileName: ProfileNameSchema,
});

/** `profile:config` / `profile:history` */
export const ProfileQuerySchema = z.object({
    engineId: EngineIdSchema,
    profileName: ProfileNameSchema,
});

/** `profile:rollback` */
export const RollbackSchema = z.object({
    engineId: EngineIdSchema,
    profileName: ProfileNameSchema,
    versionId: z.number().int().positive(),
});

/** `device:list` — initial-snapshot read for plugin-registered device types. */
export const DeviceListSchema = z.object({
    engineId: EngineIdSchema,
    type: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});

// --- Engine HTTP Payloads ---------------------------------------------------

const ManagerPathSchema = z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    bindInterface: z.string().optional(),
    bindAddress: z.string().optional(),
});

/** POST /api/v1/profiles (engine local API) */
export const CreateEngineProfileSchema = z.object({
    name: z.string().min(1),
    managerHost: z.string().min(1),
    managerPort: z.number().int().positive(),
    password: z.string().min(1),
    paths: z.array(ManagerPathSchema).optional(),
});

// --- Socket.IO Payloads -----------------------------------------------------

/** Payload with just an engineId. */
export const EngineIdPayloadSchema = z.object({
    engineId: z.string().min(1),
});

/** module:restart payload. */
export const ModuleRestartPayloadSchema = z.object({
    engineId: z.string().min(1),
    moduleId: z.string().min(1),
});

/** Browser patch payload (engineId + ops). */
export const BrowserPatchPayloadSchema = z.object({
    engineId: z.string().min(1),
    ops: PatchOpsSchema,
});

// --- Interlocks -------------------------------------------------------------

/**
 * An "interlock" is an exclusive-mute group: at most one member may have
 * `settings.audioEnabled === true` at a time. Unmuting one auto-mutes the rest.
 */
export const InterlockSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    members: z.array(z.string().min(1)),
    color: z.string().optional(),
});

export const InterlocksSchema = z.array(InterlockSchema);

export interface InterlockInvariantIssue {
    kind: 'duplicate-id' | 'duplicate-member' | 'unknown-member' | 'ineligible-member';
    interlockId: string;
    moduleId?: string;
}

/**
 * Check that an interlocks array satisfies cross-entry invariants:
 *  - unique interlock ids
 *  - each moduleId appears in at most one group
 *  - every moduleId exists in the provided set (if given)
 *  - every moduleId is eligible per `isEligible` predicate (if given)
 */
export function validateInterlocksInvariants(
    interlocks: Array<{ id: string; members: string[] }>,
    opts: {
        knownModuleIds?: ReadonlySet<string>;
        isEligible?: (moduleId: string) => boolean;
    } = {},
): InterlockInvariantIssue[] {
    const issues: InterlockInvariantIssue[] = [];
    const seenIds = new Set<string>();
    const seenMembers = new Map<string, string>(); // moduleId → owning interlockId

    for (const ilk of interlocks) {
        if (seenIds.has(ilk.id)) {
            issues.push({ kind: 'duplicate-id', interlockId: ilk.id });
        } else {
            seenIds.add(ilk.id);
        }

        for (const moduleId of ilk.members) {
            const owner = seenMembers.get(moduleId);
            if (owner && owner !== ilk.id) {
                issues.push({ kind: 'duplicate-member', interlockId: ilk.id, moduleId });
            } else {
                seenMembers.set(moduleId, ilk.id);
            }
            if (opts.knownModuleIds && !opts.knownModuleIds.has(moduleId)) {
                issues.push({ kind: 'unknown-member', interlockId: ilk.id, moduleId });
            }
            if (opts.isEligible && !opts.isEligible(moduleId)) {
                issues.push({ kind: 'ineligible-member', interlockId: ilk.id, moduleId });
            }
        }
    }
    return issues;
}

// --- Helpers ----------------------------------------------------------------

type Logger = { warn: (obj: Record<string, unknown>, msg: string) => void };

function formatIssues(error: z.core.$ZodError): string[] {
    return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

/** Returns validated data or undefined (with log). For EventEmitter patterns with multiple args. */
export function safeParse<T>(
    schema: z.ZodType<T>,
    data: unknown,
    context: string,
    logger?: Logger,
): T | undefined {
    const result = schema.safeParse(data);
    if (result.success) return result.data;
    logger?.warn(
        { context, issues: formatIssues(result.error) },
        'Validation failed — dropping message',
    );
    return undefined;
}

/**
 * Wraps a Socket.IO / EventEmitter handler with Zod validation.
 * Invalid payloads are logged and silently dropped.
 *
 * Usage: `socket.on('event', validated(Schema, log, (data) => { ... }))`
 */
export function validated<T>(
    schema: z.ZodType<T>,
    logger: Logger,
    handler: (data: T) => void,
): (raw: unknown, ...rest: unknown[]) => void {
    return (raw: unknown, ...rest: unknown[]) => {
        const result = schema.safeParse(raw);
        if (!result.success) {
            logger.warn(
                { issues: formatIssues(result.error) },
                'Validation failed — dropping event',
            );
            return;
        }
        handler(result.data);
    };
}

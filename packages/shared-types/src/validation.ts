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

/** Engine running state report; `localChange` = set on site during an outage, adopt it (ADR-0025). */
export const EngineRunningStateSchema = z.object({
    running: z.boolean(),
    localChange: z.boolean().optional(),
});

/** Carried as `_push` on every manager config push (ADR-0025). */
export interface ConfigPushTag {
    reason: 'connect' | 'activate';
    profile: string;
}

/** Leaf state ops from an engine, numbered so the manager spots a gap (ADR-0025). */
export const StatePatchSchema = z.object({
    seq: z.number().int(),
    ops: z.array(PatchOpSchema),
});

/** A Start/Stop made on the router itself (wire topic `lcpEngineCommand`). */
export const LocalRunCommandSchema = z.object({
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

// --- Manager Tree Payloads --------------------------------------------------
//
// Payloads of the manager tree's writes and calls (ADR-0024). The HTTP API
// was retired — only `/health` and the SPA's static assets are served over
// HTTP.
//
// Schemas below are shared between the manager (which validates incoming
// payloads with `safeParse`) and the manager-ui (which builds payloads of
// the same shape).

/**
 * Engine identifier — also the dgram-comms `clientId` and the SQLite PK across
 * `engines`, `engine_profiles`, `engine_config_history`. Restricted to a safe
 * URL-token charset so the id is round-trippable through log lines,
 * filesystem paths (engine-side `profile.name`), and tree paths without
 * needing escaping anywhere. Length cap matches what a typical operator
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

/** Call `create` on `/engines`. */
export const CreateEngineSchema = z.object({
    engineId: EngineIdSchema,
    displayName: z.string().min(1),
    password: z.string().min(1),
});

/** Writes to `/engines/<id>/info/{groupId,sortOrder}`. */
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

/** Write `add /groups/<id>` (the client picks the id). */
export const CreateGroupSchema = z.object({
    name: z.string().min(1).max(64),
    color: HexColor.optional(),
});

/** Writes to `/groups/<id>/{name,color,collapsed}`. */
export const UpdateGroupSchema = z.object({
    groupId: GroupIdSchema,
    name: z.string().min(1).max(64).optional(),
    collapsed: z.boolean().optional(),
    color: HexColor.nullable().optional(),
});

/** Engine + profile name pair; the profile name rule backs `/engines/<id>/profiles/<name>` writes. */
export const ProfileQuerySchema = z.object({
    engineId: EngineIdSchema,
    profileName: ProfileNameSchema,
});

// --- Manager Settings -------------------------------------------------------

/** One UDP listener the manager accepts engine connections on. */
export const DgramListenerSchema = z.object({
    port: z.number().int().min(1).max(65535),
    /** IPv4 to bind; omitted = all interfaces. */
    bindAddress: z.ipv4().optional(),
});

/**
 * Write `replace /settings/dgramListeners`. At least one listener always remains so a
 * save can never leave the manager unreachable by every engine. A port may
 * appear once: a wildcard bind and a specific-address bind on the same port
 * collide at bind time, so they are rejected up front too.
 */
export const ManagerSettingsSchema = z.object({
    dgramListeners: z
        .array(DgramListenerSchema)
        .min(1, 'At least one listener is required')
        .max(16)
        .refine((list) => new Set(list.map((l) => l.port)).size === list.length, 'Duplicate port'),
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

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
    type: z.enum(['data', 'keepAlive', 'ack', 'connect', 'connected']),
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

/** Patch envelope (ops wrapper). */
export const PatchEnvelopeSchema = z.object({
    ops: PatchOpsSchema,
});

// --- Manager HTTP Payloads --------------------------------------------------

/** POST /api/v1/engines */
export const CreateEngineSchema = z.object({
    engineId: z.string().min(1),
    displayName: z.string().min(1),
    password: z.string().min(1),
});

/** PUT /api/v1/engines/:id */
export const UpdateEngineSchema = z.object({
    displayName: z.string().min(1),
    password: z.string().optional(),
});

/** POST /api/v1/engines/:id/profiles */
export const CreateManagerProfileSchema = z.object({
    profileName: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
});

/** POST /api/v1/engines/:id/profiles/:profile/rollback */
export const RollbackSchema = z.object({
    versionId: z.number().int().positive(),
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
    logger?.warn({ context, issues: formatIssues(result.error) }, 'Validation failed — dropping message');
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
            logger.warn({ issues: formatIssues(result.error) }, 'Validation failed — dropping event');
            return;
        }
        handler(result.data);
    };
}

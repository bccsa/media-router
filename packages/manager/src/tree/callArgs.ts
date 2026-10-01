import { z } from 'zod';
import { TreeCallError } from '@media-router/topic-tree';

/** A call's arguments checked against its schema, or "invalid arguments". */
export function args<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) throw new TreeCallError('invalid arguments');
    return parsed.data;
}

/** `rollback` on a profile or a dashboard: the stored version to go back to. */
export const Rollback = z.object({ versionId: z.number().int().positive() });

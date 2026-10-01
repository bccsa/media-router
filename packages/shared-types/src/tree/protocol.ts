import { z } from 'zod';
import { PatchOpSchema } from '../validation.js';

export * from './wire.js';

export const PatternListSchema = z.object({
    patterns: z.array(z.string()).min(1).max(500),
});

export const WriteRequestSchema = z.object({
    id: z.number().int().nonnegative(),
    ops: z.array(PatchOpSchema).min(1).max(2000),
});

export const CallRequestSchema = z.object({
    path: z.string(),
    method: z.string().min(1),
    args: z.unknown().optional(),
});

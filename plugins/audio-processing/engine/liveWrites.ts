/** One live config change → every element property write it implies. */

import { resolveAgcWrites } from './agcStage.js';
import {
    resolveEqFanOut,
    resolveLiveTarget,
    type ChainStages,
    type LiveTarget,
} from './lspProcessing.js';

/** Empty when no built stage owns the key: structural keys, ducker params
 *  (read live off config), knobs of a disabled stage. */
export function resolveLiveWrites(key: string, value: unknown, stages: ChainStages): LiveTarget[] {
    const target = resolveLiveTarget(key, value, stages);
    if (target) return [target];
    return [...resolveAgcWrites(key, value, stages), ...resolveEqFanOut(key, value, stages)];
}

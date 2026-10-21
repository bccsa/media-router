/** One live config change → every element property write it implies. */

import { resolveAgcWrites } from './agcStage.js';
import { resolveDuckerWrites } from './duckerStage.js';
import {
    resolveEqFanOut,
    resolveLiveTarget,
    type ChainStages,
    type LiveTarget,
} from './lspProcessing.js';

/** Empty when no built stage owns the key: structural keys, knobs of a disabled
 *  stage, the duck settings without the ducker. */
export function resolveLiveWrites(key: string, value: unknown, stages: ChainStages): LiveTarget[] {
    const target = resolveLiveTarget(key, value, stages);
    if (target) return [target];
    return [
        ...resolveAgcWrites(key, value, stages),
        ...resolveEqFanOut(key, value, stages),
        ...resolveDuckerWrites(key, value, stages),
    ];
}

/**
 * The ducker stage: `mrducker` (native/mrducker), the sidechain ducker in the pipeline on
 * content time (house-clock part 4.5). Pure mapping, no gst. Its settings are live properties,
 * and it reports its envelope as `mrducker` messages on the `mrducker:ducker` channel.
 */

import { DUCK_DEFAULTS } from './chainSetup.js';
import { clampNumber, type PropMap } from './lspConfig.js';
import type { ChainStages, LiveTarget } from './lspProcessing.js';

export const DUCKER_ELEMENT = 'ducker';
/** The element message's structure name: the busReport and the plugin-event channel. */
export const DUCKER_MESSAGE = 'mrducker';
export const DUCKER_CHANNEL = `${DUCKER_MESSAGE}:${DUCKER_ELEMENT}`;

type DuckKey = keyof typeof DUCK_DEFAULTS;

/** Config key → `mrducker` property. The clamps are the element's ranges, which are the
 *  schema's (the launch string and a live write agree with the slider). */
export const DUCKER_PROP_MAP: Record<DuckKey, PropMap> = {
    threshold: { prop: 'threshold', convert: (v) => clampNumber(v, -60, 0) },
    duckDepth: { prop: 'depth', convert: (v) => clampNumber(v, -40, 0) },
    attack: { prop: 'attack', convert: (v) => clampNumber(v, 0, 500) },
    release: { prop: 'release', convert: (v) => clampNumber(v, 5, 2000) },
    hold: { prop: 'hold', convert: (v) => clampNumber(v, 0, 2000) },
};

const isDuckKey = (key: string): key is DuckKey => Object.hasOwn(DUCKER_PROP_MAP, key);

/** `mrducker name=ducker threshold=… depth=… attack=… release=… hold=…`, defaults applied. */
export function duckerElement(config: Record<string, unknown>): string {
    const props = (Object.keys(DUCKER_PROP_MAP) as DuckKey[]).map((key) => {
        const { prop, convert } = DUCKER_PROP_MAP[key];
        return `${prop}=${convert(config[key] ?? DUCK_DEFAULTS[key])}`;
    });
    return `mrducker name=${DUCKER_ELEMENT} ${props.join(' ')}`;
}

/** Live writes for one duck setting; empty unless the running chain has the ducker. */
export function resolveDuckerWrites(
    key: string,
    value: unknown,
    stages: ChainStages,
): LiveTarget[] {
    if (stages.dynMode !== 'ducker' || !stages.duckerKey || !isDuckKey(key)) return [];
    const { prop, convert } = DUCKER_PROP_MAP[key];
    return [{ element: DUCKER_ELEMENT, prop, value: convert(value) }];
}

import type { ChainStages } from './lspProcessing.js';

/** Test fixture: a bypass chain with `over` applied. */
export const stages = (over: Partial<ChainStages> = {}): ChainStages => ({
    hpf: false,
    agcElement: null,
    eqElement: null,
    dynElement: null,
    dynMode: 'none',
    keyedGate: false,
    limiterElement: null,
    duckerKey: false,
    ...over,
});

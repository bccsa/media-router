/**
 * Public surface of the SMPTE-302M library plugin.
 *
 * Consumers import the package, never a deep path:
 * `import { buildAudioMixInput } from '@media-router/plugin-audio-302m-core'`.
 * Dependency direction is plugin → engine (ADR-0002): everything here builds
 * on `@media-router/engine`, and nothing in `packages/engine` imports it back.
 */
export {
    buildAudioMixInput,
    build302mEncodeBranch,
    normalize302mChannels,
    pacedMixer,
    probe302mSupport,
} from './audio302mHelpers.js';
export type {
    AudioMixSource,
    AudioMixInputOpts,
    Audio302mEncodeOpts,
    PacedMixerOpts,
} from './audio302mHelpers.js';
export { mixMatrixClause } from './channelMapMatrix.js';

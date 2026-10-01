// What a browser tree client needs, without zod or the logger — the router's
// dashboard viewer (ADR-0026) bundles this instead of the whole package.
export { escapeSegment, unescapeSegment, splitPath, joinPath, isPrefix } from './tree/paths.js';
export { WILDCARD, parsePattern, covers, isAncestorOf, overlaps } from './tree/patterns.js';
export { getAt, keysOf, applyTreeOp } from './tree/apply.js';
export { absolutePath, widgetPaths } from './dashboardPaths.js';
export { MODULE_HEALTH, type ModuleHealth } from './health.js';
export { VU_BLOCKS, vuBlockDbfs } from './vu.js';
export { carriesAudio } from './carriesAudio.js';
export * from './script.js';
export {
    TREE_PROTOCOL,
    TREE_EVENTS,
    ROUTER_TREE_PATH,
    ROUTER_BRANCHES,
    ENGINE_BRANCHES,
    protocolMismatch,
    requiredProtocol,
} from './tree/wire.js';
export type { TreeOp, TreeFrame, TreeHello, WriteRejection, WriteResult, TreeRenamed, TreeAck, TreeErrorCode } from './tree/wire.js';

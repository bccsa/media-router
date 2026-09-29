export { escapeSegment, unescapeSegment, splitPath, joinPath, isPrefix } from './paths.js';
export { WILDCARD, parsePattern, covers, isAncestorOf, overlaps } from './patterns.js';
export { prune, projectOp } from './project.js';
export { diffValues } from './diff.js';
export { getAt, keysOf, applyTreeOp } from './apply.js';
export {
    describeModuleValue,
    describeModule,
    metaAt,
    touchedModules,
    checkWrite,
    ModuleWriteCheck,
    ROUTER_INFO_META,
    ENGINE_INFO_META,
    META_RUNTIME_FIELDS,
} from './describe.js';
export type { ValueDescriptor, DescribableModule, ModuleMeta } from './describe.js';
export {
    TREE_PROTOCOL,
    TREE_EVENTS,
    ROUTER_TREE_PATH,
    PatternListSchema,
    WriteRequestSchema,
    CallRequestSchema,
    protocolMismatch,
    requiredProtocol,
    ROUTER_BRANCHES,
    ENGINE_BRANCHES,
} from './protocol.js';
export type {
    TreeOp,
    TreeFrame,
    TreeHello,
    WriteRejection,
    WriteResult,
    TreeRenamed,
    TreeAck,
} from './protocol.js';
export { isPlainObject, isContainer, dropUndefined, appendRing, LOG_RING_MAX } from './object.js';
export { overlayManifest, type ModuleManifestLike } from './moduleNode.js';

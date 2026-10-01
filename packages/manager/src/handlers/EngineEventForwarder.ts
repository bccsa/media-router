import {
    createLogger,
    isPlainObject,
    joinPath,
    safeParse,
    type PatchOp,
    EngineRunningStateSchema,
    StatePatchSchema,
    LocalRunCommandSchema,
    DynamicPortsSchema,
    RebootFailedSchema,
} from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { EngineCommandService } from './EngineCommandService.js';
import type { RuntimeCache } from '../tree/RuntimeCache.js';
import type { TreePublisher } from '../tree/TreePublisher.js';

const log = createLogger('EngineEventForwarder');

/** System-stat fields that describe the engine rather than its load — they live in `info`. */
const IDENTITY_FIELDS = ['ip', 'ips', 'hostname', 'buildNumber', 'features', 'managerPaths'];

type Obj = Record<string, unknown>;


/**
 * Engine events → runtime cache → tree. Also reconciles the engine's run
 * state against the manager's intent on every handshake.
 */
export class EngineEventForwarder {
    /** Last statePatch seq per engine; 0 after a full snapshot. */
    private patchSeq = new Map<string, number>();

    constructor(
        private configStore: ConfigStore,
        private engineManager: EngineConnectionManager,
        private engineCommands: EngineCommandService,
        private runtime: RuntimeCache,
        private publisher: TreePublisher,
    ) {}

    /** Wire all engine events. Call once during Manager construction. */
    setup(): void {
        const em = this.engineManager;
        const paths = (engineId: string) => this.publisher.infoFields(engineId, { paths: em.enginePaths(engineId) });

        em.on('engineOnline', (engineId: string) => this.publisher.info(engineId));
        em.on('enginePathUp', paths);
        em.on('enginePathDown', paths);
        em.on('engineRunningState', (engineId: string, data: unknown) => this.reconcileRunning(engineId, data));

        em.on('engineOffline', (engineId: string) => {
            this.patchSeq.delete(engineId);
            this.runtime.clearEngine(engineId);
            this.publisher.offline(engineId);
        });

        em.on('engineState', (engineId: string, state: unknown) => {
            if (!isPlainObject(state)) {
                log.warn({ engineId }, 'engineState: expected object, dropping');
                return;
            }
            // A full snapshot is the baseline the next statePatch counts from.
            this.patchSeq.set(engineId, 0);
            this.publisher.runtime(engineId, this.runtime.mergeStates(engineId, state));
        });

        // Leaf state ops (ADR-0025). A gap in seq means a lost message: ask for a snapshot.
        em.on('engineStatePatch', (engineId: string, data: unknown) => {
            const msg = safeParse(StatePatchSchema, data, 'engineStatePatch', log);
            if (!msg) return;
            const expected = (this.patchSeq.get(engineId) ?? 0) + 1;
            if (msg.seq !== expected) {
                log.debug({ engineId, seq: msg.seq, expected }, 'statePatch gap — requesting resync');
                em.sendToEngine(engineId, 'stateResync', {}, { guaranteeDelivery: true });
            }
            this.patchSeq.set(engineId, msg.seq);
            this.publisher.statePatch(engineId, this.runtime.applyStateOps(engineId, msg.ops as PatchOp[]));
        });

        // The engine's effective per-plugin schemas (issue #661): refresh placed modules.
        em.on('engineCapabilities', (engineId: string, data: unknown) => {
            if (!isPlainObject(data)) {
                log.warn({ engineId }, 'engineCapabilities: expected object, dropping');
                return;
            }
            this.runtime.setData(engineId, 'pluginSchemas', data);
            const engine = this.configStore.getEngine(engineId);
            if (!engine?.active_profile) return;
            const profile = this.configStore.getProfile(engineId, engine.active_profile as string);
            const modules = (profile?.modules ?? {}) as Record<string, Obj>;
            const placed = Object.entries(modules).filter(([, mod]) => data[mod.pluginId as string] !== undefined);
            this.publisher.publish(
                placed.map(([id, mod]) => ({
                    op: 'replace' as const,
                    path: joinPath(['engines', engineId, 'modules', id, 'configSchema']),
                    value: data[mod.pluginId as string],
                })),
            );
            this.publisher.metaChanged(engineId, placed.map(([id]) => id));
        });

        // One batch per engine flush; older engines send one module per message.
        em.on('engineVu', (engineId: string, data: unknown) => {
            if (!isPlainObject(data)) return;
            const batch = isPlainObject(data.batch)
                ? (data.batch as Record<string, number[]>)
                : typeof data.instanceId === 'string' && Array.isArray(data.vuData)
                  ? { [data.instanceId]: data.vuData as number[] }
                  : undefined;
            if (!batch) return;
            this.runtime.setVu(engineId, batch);
            this.publisher.vu(engineId, batch);
        });

        em.on('engineSystem', (engineId: string, data: unknown) => {
            if (!isPlainObject(data)) return;
            const identity: Obj = {};
            const stats: Obj = {};
            for (const [k, v] of Object.entries(data)) (IDENTITY_FIELDS.includes(k) ? identity : stats)[k] = v;
            for (const [k, v] of Object.entries(identity)) if (v) this.runtime.setData(engineId, k, v);
            const prev = this.runtime.getData(engineId, 'system');
            this.runtime.setData(engineId, 'system', stats);
            this.publisher.infoFields(engineId, identity);
            this.publisher.system(engineId, prev, stats);
        });

        em.on('engineLogs', (engineId: string, batch: unknown) => {
            if (!Array.isArray(batch)) return;
            this.runtime.appendLogs(engineId, batch);
            this.publisher.logs(engineId, batch);
        });

        em.on('engineDeviceList', (engineId: string, data: unknown) => {
            if (!isPlainObject(data) || typeof data.type !== 'string') {
                log.warn({ engineId, data }, 'engineDeviceList payload missing type');
                return;
            }
            // The engine re-sends every list on its 10 s heartbeat; publish changes only.
            const topic = `devices:${data.type}`;
            if (JSON.stringify(this.runtime.getData(engineId, topic)) === JSON.stringify(data.devices)) return;
            this.runtime.setData(engineId, topic, data.devices);
            this.publisher.devices(engineId, data.type, data.devices);
        });

        // Start/Stop made on the router: it already acted; adopt it as the manager's intent.
        em.on('engineLocalRunCommand', (engineId: string, data: unknown) => {
            const parsed = safeParse(LocalRunCommandSchema, data, 'engineLocalRunCommand', log);
            if (!parsed) return;
            this.engineCommands.setRunning(engineId, parsed.command === 'start');
            this.publisher.info(engineId);
        });

        // Host reboot failed — typically a polkit denial.
        em.on('engineRebootFailed', (engineId: string, data: unknown) => {
            const parsed = safeParse(RebootFailedSchema, data, 'engineRebootFailed', log);
            if (parsed) this.publisher.event(engineId, { type: 'rebootFailed', reason: parsed.reason });
        });

        em.on('engineDynamicPorts', (engineId: string, data: unknown) => {
            const parsed = safeParse(DynamicPortsSchema, data, 'engineDynamicPorts', log);
            if (!parsed) return;
            const { moduleId, ports } = parsed;
            const engine = this.configStore.getEngine(engineId);
            if (engine?.active_profile) {
                this.configStore.modifyProfileConfig(engineId, engine.active_profile as string, (config) => {
                    const modules = config.modules as Record<string, Obj> | undefined;
                    if (modules?.[moduleId]) modules[moduleId].ports = ports;
                    return config;
                });
            }
            this.publisher.publish([
                { op: 'replace', path: joinPath(['engines', engineId, 'modules', moduleId, 'ports']), value: ports },
            ]);
        });
    }

    /**
     * Manager intent is authoritative; every handshake (connect + 10 s)
     * retries the command. A Start/Stop made on site during an outage is
     * adopted instead (ADR-0025).
     */
    private reconcileRunning(engineId: string, data: unknown): void {
        const parsed = safeParse(EngineRunningStateSchema, data, 'engineRunningState', log);
        if (!parsed) return;
        if (parsed.localChange) {
            log.info({ engineId, running: parsed.running }, 'Run state changed on site during the outage — adopting');
            this.engineCommands.setRunning(engineId, parsed.running);
            this.publisher.info(engineId);
            return;
        }
        const wanted = this.engineCommands.isRunning(engineId);
        if (wanted && !parsed.running) {
            log.info({ engineId }, 'Engine reports stopped — sending start');
            this.engineCommands.sendCommand(engineId, 'start');
        } else if (!wanted && parsed.running) {
            log.info({ engineId }, 'Manager wants stopped — sending stop');
            this.engineCommands.sendCommand(engineId, 'stop');
        }
    }
}

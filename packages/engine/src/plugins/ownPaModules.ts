import type { PipeWireManager } from '../audio/PipeWireManager.js';
import { MR_PW_PREFIX } from '../audio/PipeWireManager.js';

type Pw = Pick<PipeWireManager, 'loadNullSink' | 'loadLoopback' | 'setSinkVolume' | 'unloadModule'>;

/**
 * The PA modules a module makes for itself (its null sinks, its loopbacks), kept by ID and node
 * name (v104 B1): a PipeWire restart takes them all, and the module's own-node watchdog
 * (`startDeviceWatchdog(true, true)`) unloads what is left by name and makes them again.
 * Ownership tracking still releases them at the module's stop.
 */
export class OwnPaModules {
    private modules: Array<{ id: number; name: string }> = [];

    constructor(
        private readonly pw: () => Pw | undefined,
        private readonly ownerId: () => string,
    ) {}

    /** `MR_PW_<name>` at 100 % (stream-restore may remember 0 %); its PA module ID (null: no
     *  PipeWire service). */
    async nullSink(name: string, channels = 2, rate = 48000): Promise<number | null> {
        const node = `${MR_PW_PREFIX}${name}`;
        const pw = this.pw();
        if (!pw) return null;
        const id = await pw.loadNullSink(name, channels, rate, this.ownerId());
        this.modules.push({ id, name: node });
        await pw.setSinkVolume(node, 100);
        return id;
    }

    async loopback(
        connId: string,
        source: string,
        sink: string,
        channels = 2,
        rate = 48000,
        latencyMs = 20,
    ): Promise<void> {
        const pw = this.pw();
        if (!pw) return;
        const id = await pw.loadLoopback(
            connId,
            source,
            sink,
            channels,
            rate,
            this.ownerId(),
            latencyMs,
        );
        this.modules.push({ id, name: `${MR_PW_PREFIX}CONN_${connId}` });
    }

    /** Unload each one still loaded under its name: after a restart an old ID can be another's. */
    async unloadAll(): Promise<void> {
        const pw = this.pw();
        const modules = this.modules;
        this.modules = [];
        if (!pw) return;
        for (const m of modules.reverse()) {
            await pw.unloadModule(m.id, m.name).catch(() => {});
        }
    }

    /** Forget them (the module's stop releases them through ownership tracking). */
    clear(): void {
        this.modules = [];
    }
}

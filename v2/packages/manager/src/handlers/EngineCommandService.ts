import { createLogger } from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';

const log = createLogger('EngineCommandService');

/**
 * Manages engine start/stop commands with retry logic and persisted running state.
 * Cancels any pending retry when a new command arrives for the same engine.
 */
export class EngineCommandService {
    /** Pending retry timers per engine — ensures only one command chain runs at a time. */
    private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private configStore: ConfigStore,
        private engineManager: EngineConnectionManager,
    ) {}

    /** Persist engine running state in profile config. */
    setRunning(engineId: string, running: boolean): void {
        const engine = this.configStore.getEngine(engineId);
        if (!engine?.active_profile) return;
        this.configStore.modifyProfileConfig(engineId, engine.active_profile as string, (config) => {
            config.running = running;
            return config;
        });
    }

    /** Get persisted running state for an engine. */
    isRunning(engineId: string): boolean {
        const engine = this.configStore.getEngine(engineId);
        if (!engine?.active_profile) return false;
        const config = this.configStore.getProfile(engineId, engine.active_profile as string);
        return (config?.running as boolean) ?? false;
    }

    /**
     * Send a start/stop command to an engine with retry.
     * Cancels any pending command for this engine before starting.
     */
    sendCommand(engineId: string, command: 'start' | 'stop'): void {
        // Cancel any pending retry for this engine
        const existing = this.pendingTimers.get(engineId);
        if (existing) {
            clearTimeout(existing);
            this.pendingTimers.delete(engineId);
            log.info({ engineId, command }, 'Cancelled previous pending command');
        }

        const maxRetries = 5;
        const retryInterval = 2000;
        let attempt = 0;

        const trySend = () => {
            attempt++;
            this.pendingTimers.delete(engineId);

            // Check if the desired state still matches — abort if someone changed it
            const shouldBeRunning = this.isRunning(engineId);
            if ((command === 'start' && !shouldBeRunning) || (command === 'stop' && shouldBeRunning)) {
                log.info({ engineId, command }, 'Command cancelled — running state changed');
                return;
            }

            if (!this.engineManager.isEngineOnline(engineId)) {
                if (attempt < maxRetries) {
                    log.warn({ engineId, command, attempt }, 'Engine offline — retrying');
                    this.pendingTimers.set(engineId, setTimeout(trySend, retryInterval));
                } else {
                    log.error({ engineId, command }, 'Engine offline — giving up after retries');
                }
                return;
            }

            if (command === 'start') {
                const engine = this.configStore.getEngine(engineId);
                if (engine?.active_profile) {
                    const config = this.configStore.getProfile(engineId, engine.active_profile as string);
                    if (config) {
                        this.engineManager.sendToEngine(engineId, 'config', config, { guaranteeDelivery: true });
                    }
                }
            }

            log.info({ engineId, command, attempt }, 'Sending engine command');
            this.engineManager.sendToEngine(engineId, 'command', { command }, { guaranteeDelivery: true });
        };

        trySend();
    }

    /** Cancel all pending retries (e.g. on shutdown). */
    cancelAll(): void {
        for (const timer of this.pendingTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();
    }
}

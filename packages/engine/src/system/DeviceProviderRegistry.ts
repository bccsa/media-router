import { EventEmitter } from 'events';
import { createLogger, type Device } from '@media-router/shared-types';

const log = createLogger('DeviceProviderRegistry');

export interface DeviceProvider {
    type: string;
    list(): Promise<Device[]> | Device[];
    /** Poll cadence in ms. `0` opts out of polling — `getDevices()` still works on demand. */
    pollMs?: number;
}

/**
 * Generic device-provider registry. Plugins register typed device sources;
 * the registry diff-polls them and emits one `deviceList` event per change.
 */
export class DeviceProviderRegistry extends EventEmitter {
    private providers = new Map<string, DeviceProvider>();
    private timers = new Map<string, ReturnType<typeof setInterval>>();
    private lastJson = new Map<string, string>();
    private polling = false;

    register(provider: DeviceProvider): void {
        if (this.providers.has(provider.type)) {
            log.warn({ type: provider.type }, 'DeviceProvider replaced');
            this.unregister(provider.type);
        }
        this.providers.set(provider.type, provider);
        log.info({ type: provider.type, pollMs: provider.pollMs ?? 2000 }, 'DeviceProvider registered');
        if (this.polling) this.startProviderTimer(provider);
    }

    unregister(type: string): void {
        const timer = this.timers.get(type);
        if (timer) {
            clearInterval(timer);
            this.timers.delete(type);
        }
        this.providers.delete(type);
        this.lastJson.delete(type);
    }

    getProvider(type: string): DeviceProvider | undefined {
        return this.providers.get(type);
    }

    types(): string[] {
        return Array.from(this.providers.keys());
    }

    async getDevices(type: string): Promise<Device[]> {
        const provider = this.providers.get(type);
        if (!provider) throw new Error(`No device provider registered for type "${type}"`);
        return Promise.resolve(provider.list());
    }

    startPolling(): void {
        if (this.polling) return;
        this.polling = true;
        for (const provider of this.providers.values()) {
            this.startProviderTimer(provider);
        }
    }

    stopPolling(): void {
        this.polling = false;
        for (const timer of this.timers.values()) clearInterval(timer);
        this.timers.clear();
        this.lastJson.clear();
    }

    /** Force-reset snapshots so the next poll always emits. Used on manager reconnect. */
    resetSnapshots(): void {
        this.lastJson.clear();
    }

    private startProviderTimer(provider: DeviceProvider): void {
        const pollMs = provider.pollMs ?? 2000;
        if (pollMs <= 0) return;
        const existing = this.timers.get(provider.type);
        if (existing) clearInterval(existing);
        // Fire once immediately so the first emit doesn't wait for pollMs.
        void this.pollOnce(provider);
        const timer = setInterval(() => void this.pollOnce(provider), pollMs);
        this.timers.set(provider.type, timer);
    }

    private async pollOnce(provider: DeviceProvider): Promise<void> {
        try {
            const devices = await Promise.resolve(provider.list());
            const json = JSON.stringify(devices);
            if (json === this.lastJson.get(provider.type)) return;
            this.lastJson.set(provider.type, json);
            this.emit('deviceList', { type: provider.type, devices });
            log.info({ type: provider.type, count: devices.length }, 'Device list changed');
        } catch (err) {
            log.warn({ err, type: provider.type }, 'Device provider list() failed');
        }
    }
}

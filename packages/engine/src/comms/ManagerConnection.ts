import { EventEmitter } from 'events';
import { Client } from '@media-router/dgram-comms';
import { createLogger, ExponentialBackoff } from '@media-router/shared-types';
import type { ManagerConnectionProfile } from '@media-router/shared-types';

const log = createLogger('ManagerConnection');

/**
 * Wraps the dgram-comms Client for engine→manager communication.
 *
 * Emits:
 *   - 'config' (config) — manager pushed a config update
 *   - 'command' (command) — manager sent a command
 *   - 'connected' — connected to manager
 *   - 'disconnected' — lost connection to manager
 */
export class ManagerConnection extends EventEmitter {
    private client: Client | null = null;
    private _isConnected = false;
    private currentProfile: ManagerConnectionProfile | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private connectTimeout: ReturnType<typeof setTimeout> | null = null;
    private backoff = new ExponentialBackoff(3000, 30000, 0, 60000);
    private intentionalDisconnect = false;

    get isConnected(): boolean {
        return this._isConnected;
    }

    /** Connect to manager using the given profile. */
    connect(profile: ManagerConnectionProfile): void {
        this.intentionalDisconnect = false;
        this.currentProfile = profile;
        this.clearReconnectTimer();
        this.createClient(profile);
    }

    private createClient(profile: ManagerConnectionProfile): void {
        // Clear previous connect timeout to prevent overlapping retries
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }

        // Destroy old client if any
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }

        log.info(
            { name: profile.name, paths: profile.paths.map((p) => `${p.host}:${p.port}`) },
            'Connecting',
        );

        this.client = new Client({
            clientId: profile.name,
            paths: profile.paths,
            encryptionKey: profile.encryptionKey,
            connectionTimeout: 3000,
            missedKeepaliveThreshold: 5,
        });

        // If not connected within 5s, recreate client (UDP packet may have been lost)
        this.connectTimeout = setTimeout(() => {
            this.connectTimeout = null;
            if (!this._isConnected && !this.intentionalDisconnect && this.currentProfile) {
                log.warn('Connection timeout — retrying with fresh client');
                this.createClient(this.currentProfile);
            }
        }, 5000);

        this.client.on('connected', () => {
            if (this.connectTimeout) {
                clearTimeout(this.connectTimeout);
                this.connectTimeout = null;
            }
            this._isConnected = true;
            this.clearReconnectTimer();
            this.backoff.reset();
            log.info('Connected to manager');
            this.emit('connected');
        });

        this.client.on('disconnected', () => {
            this._isConnected = false;
            log.info('Disconnected from manager');
            this.emit('disconnected');
            // Auto-reconnect unless intentionally disconnected
            if (!this.intentionalDisconnect && this.currentProfile) {
                this.scheduleReconnect();
            }
        });

        this.client.on('data', (topic: string, message: unknown) => {
            this.emit(topic, message);
        });
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer();
        const delay = this.backoff.nextDelay() ?? 30000;
        log.info({ delayMs: delay, attempt: this.backoff.attempts }, 'Reconnecting');
        this.reconnectTimer = setTimeout(() => {
            if (this.currentProfile && !this.intentionalDisconnect) {
                // Create fresh client each time — old UDP socket may be stale
                this.createClient(this.currentProfile);
            }
        }, delay);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /** Disconnect from manager (intentional — no auto-reconnect). */
    disconnect(): void {
        this.intentionalDisconnect = true;
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }
        this.clearReconnectTimer();
        this.backoff.destroy();
        const wasConnected = this._isConnected;
        if (this.client) {
            this.client.destroy();
            this.client = null;
            this._isConnected = false;
        }
        // `Client.destroy()` is silent — no 'disconnected' event from the
        // underlying socket on intentional teardown — so emit ours here. Any
        // listener that mirrors connect-side resources (timers, watchers) on
        // 'connected'/'disconnected' would otherwise leak past shutdown.
        if (wasConnected) this.emit('disconnected');
    }

    /** Send a message to the manager. */
    send(topic: string, message: unknown, options?: { guaranteeDelivery?: boolean }): void {
        this.client?.send(topic, message, options);
    }

    /** Send module state update to manager. */
    sendState(
        moduleStates: Record<string, unknown>,
        options?: { guaranteeDelivery?: boolean },
    ): void {
        this.send('state', moduleStates, options);
    }

    /** Send VU data to manager. */
    sendVu(instanceId: string, vuData: number[]): void {
        this.send('vu', { instanceId, vuData });
    }
}

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
    /**
     * How long each client gets to complete the handshake before a rebuild is
     * scheduled. Must exceed the server's guaranteed 'connected' reply resend
     * window (~12.6s: 200+400+800+1600×7ms) plus RTT margin — the old 5s
     * window abandoned the session at 40% of it, discarding the UDP socket /
     * NAT mapping and session nonce on every retry (gate01 2026-07-18: flat
     * 5s reconnect hammer for hours on a lossy WAN). The path-level 1s
     * connect retries keep running underneath for the whole window.
     */
    private static readonly CONNECT_WINDOW_MS = 15_000;

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
            // Invariant: the client must detect a dead link BEFORE the server
            // (EngineConnectionManager: 5000/3, ~7.5-8.75s) so it re-handshakes
            // while the server still holds the session and re-acks the same
            // socketID — no churn, no config re-push.
            connectionTimeout: 3000,
            missedKeepaliveThreshold: 3,
        });

        // If the handshake doesn't complete within the window, schedule a
        // fresh client through the backoff — do NOT rebuild immediately, and
        // keep the current client alive meanwhile: its 1s connect retries
        // continue and may still land (the 'connected' handler then cancels
        // the rebuild).
        this.connectTimeout = setTimeout(() => {
            this.connectTimeout = null;
            if (!this._isConnected && !this.intentionalDisconnect && this.currentProfile) {
                log.warn('Connect window expired — scheduling fresh client');
                this.scheduleReconnect();
            }
        }, ManagerConnection.CONNECT_WINDOW_MS);

        this.client.on('connected', () => {
            if (this.connectTimeout) {
                clearTimeout(this.connectTimeout);
                this.connectTimeout = null;
            }
            this._isConnected = true;
            this.clearReconnectTimer();
            // markStable, not reset: attempts only zero after 60s of sustained
            // connection. A flapping link (connected 10s, dead again) must keep
            // escalating its delays, not restart from 3s every cycle.
            this.backoff.markStable();
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
}

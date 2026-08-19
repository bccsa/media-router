import type { EngineServices } from '@media-router/engine';

/**
 * SAP-discovered AES67 streams, surfaced to the GUI as a device list.
 *
 * The stream picker is the reason the SAP listener exists: an operator should
 * choose "Studio A" from a dropdown, not hand-type a multicast group, a port,
 * an encoding, a channel count and a payload type — five fields that produce
 * silence rather than an error when one is wrong.
 *
 * Lifetime, and why it is not an engine-wide daemon: the listener is owned by
 * the RUNNING aes67-input modules (one sidecar each, auto-reaped with the
 * module), and each publishes its latest snapshot here. A box with no AES67
 * input configured therefore joins no multicast group and runs no extra
 * process. The cost is that discovery only populates once at least one
 * aes67-input exists — which is exactly when anyone needs the picker.
 */

/** Device-type key the manager-UI dropdown looks up (`x-deviceType`). */
export const AES67_STREAM_DEVICE_TYPE = 'aes67-stream';

/** One session as announced over SAP — the subset the RX side configures from. */
export interface DiscoveredStream {
    key: string;
    name: string;
    address: string;
    port: number;
    encoding?: string;
    rate?: number;
    channels?: number;
    payloadType?: number;
    ptimeMs?: number;
    refclk?: string;
    origin?: string;
    sourceIp?: string;
}

/** The stored config value for a picked stream: what actually identifies a flow. */
export function streamId(stream: { address: string; port: number }): string {
    return `${stream.address}:${stream.port}`;
}

/**
 * Union of what every running listener currently sees, keyed by `address:port`.
 *
 * Per-instance snapshots (not a merged mutable table) so a listener that dies
 * or is reconfigured takes exactly its own entries with it — the stale-picker
 * failure mode of a shared table with no ownership.
 */
class Aes67Discovery {
    private byInstance = new Map<string, DiscoveredStream[]>();

    /** Replace one listener's contribution (the sidecar emits full snapshots). */
    publish(instanceId: string, streams: DiscoveredStream[]): void {
        this.byInstance.set(instanceId, streams);
    }

    /** Listener gone (module stopped) — drop its streams. */
    clear(instanceId: string): void {
        this.byInstance.delete(instanceId);
    }

    /** All streams, deduplicated by `address:port`, sorted by display name. */
    list(): DiscoveredStream[] {
        const merged = new Map<string, DiscoveredStream>();
        for (const streams of this.byInstance.values()) {
            for (const s of streams) {
                if (!s.address || !s.port) continue;
                merged.set(streamId(s), s);
            }
        }
        return Array.from(merged.values()).sort(
            (a, b) => a.name.localeCompare(b.name) || streamId(a).localeCompare(streamId(b)),
        );
    }

    /** The stream behind a stored picker value, if it is still being announced. */
    find(id: string): DiscoveredStream | undefined {
        return this.list().find((s) => streamId(s) === id);
    }

    /** True when at least one listener is publishing (empty ≠ "no discovery"). */
    hasListeners(): boolean {
        return this.byInstance.size > 0;
    }
}

export const aes67Discovery = new Aes67Discovery();

/** Device list for the picker: label carries the format so the choice is informed. */
export function discoveredStreamDevices(): Array<{
    name: string;
    label: string;
    meta: Record<string, unknown>;
}> {
    return aes67Discovery.list().map((s) => {
        const format = [s.encoding, s.channels ? `${s.channels}ch` : null]
            .filter(Boolean)
            .join(' ');
        return {
            name: streamId(s),
            label: format ? `${s.name} — ${streamId(s)} (${format})` : `${s.name} — ${streamId(s)}`,
            meta: { ...s },
        };
    });
}

/**
 * Register the `aes67-stream` device provider. Idempotent across instances
 * (same rationale as the network-interface provider: one host-global list).
 */
export function registerAes67StreamDeviceProvider(services: EngineServices): void {
    if (services.deviceProviders.getProvider(AES67_STREAM_DEVICE_TYPE)) return;
    services.deviceProviders.register({
        type: AES67_STREAM_DEVICE_TYPE,
        // Announcements arrive every ~30 s and the registry diffs before it
        // emits, so a 5 s poll costs one JSON compare and shows a new stream
        // within a tick of it being announced.
        pollMs: 5000,
        list: () => discoveredStreamDevices(),
    });
}

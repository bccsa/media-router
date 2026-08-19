import * as os from 'node:os';
import type { Device } from '@media-router/shared-types';
import type { EngineServices } from '../plugins/PluginModule.js';

/** Device-type key the manager-UI dropdown looks up for NIC fields. */
export const NETWORK_INTERFACE_DEVICE_TYPE = 'network-interface';

/**
 * Enumerate the host's network interfaces as `Device`s. One entry per
 * interface name (the value GStreamer's `multicast-iface` wants), labelled with
 * its first IPv4 address for operator recognition. Internal interfaces (e.g.
 * loopback) are excluded — multicast egress/ingress to the wire never uses them.
 */
export function listNetworkInterfaces(): Device[] {
    const ifaces = os.networkInterfaces();
    const devices: Device[] = [];
    for (const [name, entries] of Object.entries(ifaces)) {
        if (!entries) continue;
        if (entries.every((e) => e.internal)) continue;
        const v4 = entries.find((e) => e.family === 'IPv4' && !e.internal);
        devices.push({
            name,
            label: v4 ? `${name} (${v4.address})` : name,
            meta: { address: v4?.address },
        });
    }
    return devices;
}

/**
 * IPv4 address of one interface by NAME — the translation every module needs
 * between what the picker stores (`eth0`, what GStreamer's `multicast-iface`
 * wants) and what a raw socket API takes (an address, e.g. for a multicast
 * join or a SAP announcement's source). Empty string when the name is unknown
 * or the interface has no external IPv4.
 */
export function interfaceAddress(name: string): string {
    if (!name) return '';
    const entries = os.networkInterfaces()[name] ?? [];
    return entries.find((e) => e.family === 'IPv4' && !e.internal)?.address ?? '';
}

/**
 * Register the `network-interface` device provider so a config field with
 * `x-deviceType: "network-interface"` renders as a dropdown of the host's NICs.
 * Idempotent across plugins — the first registration wins; later ones are no-ops
 * so both `mpegts-ip-input` and `mpegts-ip-output` can call it safely.
 *
 * Call from a plugin's static `registerServices(services)` hook.
 */
export function registerNetworkInterfaceDeviceProvider(services: EngineServices): void {
    // Idempotent: both mpegts-ip plugins register this, but the list is
    // host-global. Skip if already present so we don't churn the registry
    // (which logs a "provider replaced" warning on every duplicate).
    if (services.deviceProviders.getProvider(NETWORK_INTERFACE_DEVICE_TYPE)) return;
    services.deviceProviders.register({
        // The registry diff-polls and pushes the list to the manager, which is
        // how the UI dropdown is populated. NICs rarely change, so poll slowly;
        // the lastJson diff means steady state emits nothing after the first.
        type: NETWORK_INTERFACE_DEVICE_TYPE,
        pollMs: 5000,
        list: () => listNetworkInterfaces(),
    });
}

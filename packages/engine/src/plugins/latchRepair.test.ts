import { describe, it, expect } from 'vitest';
import { effectiveLatchRepair } from './latchRepair.js';

/**
 * The latch-repair decision is a property of the SOURCE at the head of the
 * chain (ADR-0005 note 2026-09-05): a producer riding a live ingest repairs, a
 * producer riding — at any depth — one that declares itself delivery-lead
 * (`isDeliveryLeadProducer`, hls-player) must not, or the player's
 * per-segment burst would be read as a backlog.
 */
describe('effectiveLatchRepair', () => {
    const live = (pluginId: string) => ({ pluginId, deliveryLead: false });
    const lead = (pluginId: string) => ({ pluginId, deliveryLead: true });
    const services = (upstream: Array<{ pluginId: string; deliveryLead: boolean }>) => ({
        instanceId: 'mpegts-muxer-abc',
        mediaRouter: { getUpstreamBusProducers: () => upstream },
    });

    it('a live chain repairs: srt-input → ts-splitter → muxer', () => {
        expect(effectiveLatchRepair(services([live('ts-splitter'), live('srt-input')]))).toBe(true);
    });

    it('a source with no upstream at all repairs (a network ingest, a capture)', () => {
        expect(effectiveLatchRepair(services([]))).toBe(true);
    });

    it('a delivery-lead producer anywhere upstream turns it off — direct or through a splitter', () => {
        expect(effectiveLatchRepair(services([lead('hls-player')]))).toBe(false);
        expect(effectiveLatchRepair(services([live('ts-splitter'), lead('hls-player')]))).toBe(false);
    });

    it('goes by the declaration, not the name — the engine names no plugin', () => {
        expect(effectiveLatchRepair(services([lead('some-future-file-player')]))).toBe(false);
        expect(effectiveLatchRepair(services([live('hls-player')]))).toBe(true);
    });

    it('resolves to the live default without a router (test harnesses) or an id', () => {
        expect(effectiveLatchRepair({ instanceId: 'x' })).toBe(true);
        expect(effectiveLatchRepair({})).toBe(true);
        expect(effectiveLatchRepair(undefined)).toBe(true);
    });
});

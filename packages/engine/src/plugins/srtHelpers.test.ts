import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    formatBytes,
    formatBitrate,
    bitrateBadge,
    SrtStatPoller,
    type SrtStatPollerHost,
} from './srtHelpers.js';

describe('formatBytes', () => {
    it('renders bytes in the smallest fitting unit', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(1023)).toBe('1023 B');
        expect(formatBytes(1024)).toBe('1.0 KB');
        expect(formatBytes(2.5 * 1024)).toBe('2.5 KB');
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
        expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
        expect(formatBytes(5.5 * 1024 * 1024 * 1024)).toBe('5.50 GB');
    });
});

function makeHost(stats: Record<string, unknown> | undefined = undefined) {
    const host: SrtStatPollerHost & {
        setStatusData: ReturnType<typeof vi.fn>;
        setBadge: ReturnType<typeof vi.fn>;
        clearBadge: ReturnType<typeof vi.fn>;
        setSections: ReturnType<typeof vi.fn>;
        getElementStats: ReturnType<typeof vi.fn>;
    } = {
        isRunning: () => true,
        getElementStats: vi.fn(async () => stats),
        setStatusData: vi.fn(),
        setBadge: vi.fn(),
        clearBadge: vi.fn(),
        setSections: vi.fn(),
    };
    return host;
}

describe('SrtStatPoller.poll (listener mode)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('emits one section per caller with the right label and field set (receive)', async () => {
        const host = makeHost({
            callers: [
                { 'rtt-ms': 12, 'receive-rate-mbps': 4.5, 'bytes-received': 2048, 'packets-received': 100, 'packets-received-lost': 0 },
                { 'rtt-ms': 30, 'receive-rate-mbps': 2.1, 'bytes-received': 1024, 'packets-received': 50, 'packets-received-lost': 1 },
            ],
        });
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        expect(host.setSections).toHaveBeenCalledOnce();
        const sections = host.setSections.mock.calls[0][0];
        expect(sections.map((s: { label: string }) => s.label)).toEqual(['Caller 1', 'Caller 2']);
        expect(sections[0].fields.find((f: { key: string }) => f.key === 'bytesReceived')).toBeDefined();
        expect(host.setBadge).toHaveBeenCalledWith('callers', expect.objectContaining({ text: '2' }));
        // Aggregate live-bitrate face badge = sum across callers (4.5 + 2.1).
        expect(host.setBadge).toHaveBeenCalledWith('bitrate', {
            icon: 'activity',
            text: '6.6 Mbps',
            color: '#10b981',
        });
    });

    it('uses send-side field names when direction is "send"', async () => {
        const host = makeHost({
            callers: [
                { 'rtt-ms': 12, 'send-rate-mbps': 4.5, 'bytes-sent': 2048, 'packets-sent': 100, 'packets-sent-lost': 0 },
            ],
        });
        const poller = new SrtStatPoller(host, 'send');
        await poller.poll();
        const sections = host.setSections.mock.calls[0][0];
        expect(sections[0].fields.find((f: { key: string }) => f.key === 'bytesSent')).toBeDefined();
        expect(host.setStatusData).toHaveBeenCalledWith(
            'caller-0',
            expect.objectContaining({ bytesSent: '2.0 KB', bitrate: 4.5 }),
        );
    });

    it('shows the "Waiting" status badge for listener-with-zero-callers (fixes pre-extraction dead-code bug)', async () => {
        const host = makeHost({ callers: [] });
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        expect(host.setBadge).toHaveBeenCalledWith(
            'status',
            expect.objectContaining({ text: 'Waiting' }),
        );
        expect(host.setBadge).toHaveBeenCalledWith(
            'callers',
            expect.objectContaining({ text: '0', color: '#6b7280' }),
        );
        // No per-caller sections
        expect(host.setSections).toHaveBeenCalledWith([]);
        // No traffic → no bitrate badge on the face.
        expect(host.clearBadge).toHaveBeenCalledWith('bitrate');
        // …and no "Callers: 0" row — stats is emptied so the modal collapses
        // the whole Live Stats section for an idle listener.
        expect(host.setStatusData).toHaveBeenCalledWith('stats', {});
    });

    it('publishes the caller count in stats once callers connect', async () => {
        const host = makeHost({
            callers: [
                { 'receive-rate-mbps': 1, 'packets-received': 10, 'packets-received-lost': 0 },
                { 'receive-rate-mbps': 1, 'packets-received': 10, 'packets-received-lost': 0 },
            ],
        });
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        expect(host.setStatusData).toHaveBeenCalledWith('stats', { callers: 2 });
    });

    it('clears the status badge once at least one caller is connected', async () => {
        const host = makeHost({
            callers: [{ 'packets-received': 1, 'packets-received-lost': 0 }],
        });
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        expect(host.clearBadge).toHaveBeenCalledWith('status');
    });

    it('packet-loss EMA: first poll seeds, second computes 0.7*prev + 0.3*instant', async () => {
        let payload: Record<string, unknown> = {
            callers: [{ 'packets-received': 100, 'packets-received-lost': 0 }],
        };
        const host = makeHost();
        host.getElementStats = vi.fn(async () => payload);
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        // Δrecv = 900, Δlost = 100 → instant = 100 / (900+100) = 10% → EMA 0.3*10 = 3%
        payload = { callers: [{ 'packets-received': 1000, 'packets-received-lost': 100 }] };
        await poller.poll();
        const lastCallerCall = host.setStatusData.mock.calls
            .filter((c) => c[0] === 'caller-0')
            .pop();
        expect(lastCallerCall![1]).toMatchObject({ packetLoss: '3.00%' });
    });

    it('drops stale per-caller trackers when the caller list shrinks', async () => {
        let payload: Record<string, unknown> = {
            callers: [
                { 'packets-received': 100, 'packets-received-lost': 0 },
                { 'packets-received': 50, 'packets-received-lost': 0 },
            ],
        };
        const host = makeHost();
        host.getElementStats = vi.fn(async () => payload);
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        // Internal state — assert via reset behaviour: a poll with one caller
        // followed by the count returning to two should not reuse the stale
        // tracker from the original second caller.
        payload = { callers: [{ 'packets-received': 110, 'packets-received-lost': 0 }] };
        await poller.poll();
        const sections = host.setSections.mock.calls.pop()![0];
        expect(sections).toHaveLength(1);
    });
});

describe('SrtStatPoller.poll (caller mode)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('detects "Connected" via a bytes-received-total delta between polls', async () => {
        let payload: Record<string, unknown> = {
            'bytes-received-total': 5000,
            'packets-received': 100,
            'packets-received-lost': 0,
        };
        const host = makeHost();
        host.getElementStats = vi.fn(async () => payload);
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        expect(host.setBadge).toHaveBeenCalledWith(
            'status',
            expect.objectContaining({ text: 'Connected', color: '#10b981' }),
        );
        // Same total → Stalled
        host.setBadge.mockClear();
        await poller.poll();
        expect(host.setBadge).toHaveBeenCalledWith(
            'status',
            expect.objectContaining({ text: 'Stalled' }),
        );
    });

    it('shows "Connecting" before any bytes have arrived, with no bitrate badge', async () => {
        const host = makeHost({ 'bytes-received-total': 0 });
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        expect(host.setBadge).toHaveBeenCalledWith(
            'status',
            expect.objectContaining({ text: 'Connecting' }),
        );
        expect(host.clearBadge).toHaveBeenCalledWith('bitrate');
    });

    it('shows a live-bitrate face badge while Connected', async () => {
        const host = makeHost({
            'bytes-received-total': 5000,
            'receive-rate-mbps': 8.4,
            'packets-received': 100,
            'packets-received-lost': 0,
        });
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        expect(host.setBadge).toHaveBeenCalledWith('bitrate', {
            icon: 'activity',
            text: '8.4 Mbps',
            color: '#10b981',
        });
    });

    it('clears caller-mode sections and the callers badge', async () => {
        const host = makeHost({ 'bytes-sent': 100, 'packets-sent': 10 });
        const poller = new SrtStatPoller(host, 'send');
        await poller.poll();
        expect(host.setSections).toHaveBeenCalledWith([]);
        expect(host.clearBadge).toHaveBeenCalledWith('callers');
    });

    it('rolls the per-caller fields into the "stats" section in caller mode', async () => {
        const host = makeHost({
            'bytes-sent': 2048,
            'packets-sent': 50,
            'packets-sent-lost': 0,
            'send-rate-mbps': 3.5,
            'rtt-ms': 8,
        });
        const poller = new SrtStatPoller(host, 'send');
        await poller.poll();
        expect(host.setStatusData).toHaveBeenCalledWith(
            'stats',
            expect.objectContaining({
                bitrate: 3.5,
                rtt: 8,
                bytesSent: '2.0 KB',
                callers: '—',
            }),
        );
    });
});

describe('formatBitrate', () => {
    it('stays in kbps below 1 Mbps and switches to one-decimal Mbps above', () => {
        expect(formatBitrate(0)).toBe('0 kbps');
        expect(formatBitrate(512)).toBe('512 kbps');
        expect(formatBitrate(999)).toBe('999 kbps');
        expect(formatBitrate(1000)).toBe('1.0 Mbps');
        expect(formatBitrate(4500)).toBe('4.5 Mbps');
        expect(formatBitrate(12500)).toBe('12.5 Mbps');
    });
});

describe('bitrateBadge', () => {
    it('formats kbps below 1 Mbps and Mbps above, grey at zero', () => {
        expect(bitrateBadge(512)).toEqual({ icon: 'activity', text: '512 kbps', color: '#10b981' });
        expect(bitrateBadge(12500)).toEqual({
            icon: 'activity',
            text: '12.5 Mbps',
            color: '#10b981',
        });
        expect(bitrateBadge(0)).toEqual({ icon: 'activity', text: '0 kbps', color: '#6b7280' });
    });
});

describe('SrtStatPoller misc', () => {
    beforeEach(() => vi.clearAllMocks());

    it('is a no-op when isRunning() returns false', async () => {
        const host = makeHost({ callers: [] });
        host.isRunning = () => false;
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        expect(host.getElementStats).not.toHaveBeenCalled();
        expect(host.setBadge).not.toHaveBeenCalled();
    });

    it('swallows getElementStats failures (best-effort polling)', async () => {
        const host = makeHost();
        host.getElementStats = vi.fn(async () => {
            throw new Error('IPC failed');
        });
        const poller = new SrtStatPoller(host, 'receive');
        await expect(poller.poll()).resolves.toBeUndefined();
    });

    it('ignores undefined stats (e.g. element not present)', async () => {
        const host = makeHost(undefined);
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        expect(host.setBadge).not.toHaveBeenCalled();
        expect(host.setStatusData).not.toHaveBeenCalled();
    });

    it('reset() clears tracker + lastBytes so a fresh start doesn\'t inherit old deltas', async () => {
        const host = makeHost();
        host.getElementStats = vi.fn(async () => ({
            'bytes-received-total': 5000,
            'packets-received': 100,
            'packets-received-lost': 0,
        }));
        const poller = new SrtStatPoller(host, 'receive');
        await poller.poll();
        // Without reset, a poll with the same byte count would be "Stalled"
        poller.reset();
        host.setBadge.mockClear();
        await poller.poll();
        // After reset, the same byte count is treated as a fresh connection
        expect(host.setBadge).toHaveBeenCalledWith(
            'status',
            expect.objectContaining({ text: 'Connected' }),
        );
    });

    it('reset() drops the live-bitrate face badge', async () => {
        const host = makeHost();
        const poller = new SrtStatPoller(host, 'receive');
        poller.reset();
        expect(host.clearBadge).toHaveBeenCalledWith('bitrate');
    });
});

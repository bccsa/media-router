import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EngineCommandService } from './EngineCommandService.js';

describe('EngineCommandService', () => {
    let service: EngineCommandService;
    let mockConfigStore: any;
    let mockEngineManager: any;
    let sentMessages: Array<{ engineId: string; topic: string; data: any }>;
    let profileConfig: Record<string, unknown>;

    beforeEach(() => {
        vi.useFakeTimers();
        sentMessages = [];
        profileConfig = { modules: {}, connections: [], running: false };

        mockConfigStore = {
            getEngine: vi.fn().mockReturnValue({ engine_id: 'eng-1', active_profile: 'default' }),
            getProfile: vi.fn(() => ({ ...profileConfig })),
            modifyProfileConfig: vi.fn((_eid: string, _prof: string, fn: (c: any) => any) => {
                fn(profileConfig);
                return profileConfig;
            }),
        };

        mockEngineManager = {
            isEngineOnline: vi.fn().mockReturnValue(true),
            sendToEngine: vi.fn((_eid: string, topic: string, data: any) => {
                sentMessages.push({ engineId: 'eng-1', topic, data });
            }),
        };

        service = new EngineCommandService(mockConfigStore, mockEngineManager);
    });

    afterEach(() => {
        service.cancelAll();
        vi.useRealTimers();
    });

    it('sends start command with config', () => {
        service.setRunning('eng-1', true);
        service.sendCommand('eng-1', 'start');

        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[0].topic).toBe('config');
        expect(sentMessages[1].topic).toBe('command');
        expect(sentMessages[1].data).toEqual({ command: 'start' });
    });

    it('sends stop command without config', () => {
        service.setRunning('eng-1', false);
        service.sendCommand('eng-1', 'stop');

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].topic).toBe('command');
        expect(sentMessages[0].data).toEqual({ command: 'stop' });
    });

    it('cancels previous command when new one arrives', () => {
        service.setRunning('eng-1', true);
        mockEngineManager.isEngineOnline.mockReturnValue(false);

        service.sendCommand('eng-1', 'start');
        expect(sentMessages).toHaveLength(0);

        // Stop cancels the pending start retry
        service.setRunning('eng-1', false);
        mockEngineManager.isEngineOnline.mockReturnValue(true);
        service.sendCommand('eng-1', 'stop');

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].data).toEqual({ command: 'stop' });

        // Start retry should NOT fire
        vi.advanceTimersByTime(10000);
        expect(sentMessages).toHaveLength(1);
    });

    it('retries when engine is offline', () => {
        service.setRunning('eng-1', true);
        mockEngineManager.isEngineOnline
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);

        service.sendCommand('eng-1', 'start');
        expect(sentMessages).toHaveLength(0);

        vi.advanceTimersByTime(2000);
        expect(sentMessages).toHaveLength(0);

        vi.advanceTimersByTime(2000);
        expect(sentMessages).toHaveLength(2); // config + command
    });

    it('gives up after max retries', () => {
        service.setRunning('eng-1', true);
        mockEngineManager.isEngineOnline.mockReturnValue(false);

        service.sendCommand('eng-1', 'start');

        for (let i = 0; i < 10; i++) {
            vi.advanceTimersByTime(2000);
        }

        expect(sentMessages).toHaveLength(0);
    });

    it('aborts if running state changed before retry', () => {
        service.setRunning('eng-1', true);
        mockEngineManager.isEngineOnline.mockReturnValueOnce(false).mockReturnValueOnce(true);

        service.sendCommand('eng-1', 'start');

        // Externally change running to false
        profileConfig.running = false;

        vi.advanceTimersByTime(2000);
        expect(sentMessages).toHaveLength(0); // aborted
    });

    it('isRunning reads from profile config', () => {
        profileConfig.running = true;
        expect(service.isRunning('eng-1')).toBe(true);

        profileConfig.running = false;
        expect(service.isRunning('eng-1')).toBe(false);
    });

    it('isRunning defaults to false when no profile', () => {
        mockConfigStore.getEngine.mockReturnValue(null);
        expect(service.isRunning('missing')).toBe(false);
    });

    it('cancelAll clears pending timers', () => {
        service.setRunning('eng-1', true);
        mockEngineManager.isEngineOnline.mockReturnValue(false);

        service.sendCommand('eng-1', 'start');
        service.cancelAll();

        mockEngineManager.isEngineOnline.mockReturnValue(true);
        vi.advanceTimersByTime(10000);

        expect(sentMessages).toHaveLength(0);
    });
});

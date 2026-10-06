import { describe, it, expect } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import type { ModuleServices, PipelineDescription } from './PluginModule.js';

class TestModule extends GstPluginBase {
    buildPipeline(): PipelineDescription | null {
        return null;
    }
}

/** onInit re-runs on the start after a pending non-live change (ADR-0029). */
describe('GstPluginBase.onInit — safe to re-run', () => {
    it('keeps one per-instance logger: a re-init pipes nothing more into stderr', async () => {
        const mod = new TestModule() as any;
        const services = { instanceId: 'out-1' } as ModuleServices;
        await mod.onInit({ device: 'card2' }, services);
        const log = mod.log;
        const pipes = process.stderr.listenerCount('unpipe');

        const config = { device: 'card3' };
        await mod.onInit(config, services);

        expect(mod.log).toBe(log);
        expect(process.stderr.listenerCount('unpipe')).toBe(pipes);
        expect(mod.config).toBe(config);
    });
});

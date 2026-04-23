import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

/**
 * Note plugin — pure text, no audio path.
 *
 * Exists so users can annotate the routing graph. The note text renders on
 * the module's face (via the `setting-text` faceWidget) and on the LCP
 * (via `lcpType: "note-strip"`). Engine side is a no-op.
 */
export class NoteModule extends GstPluginBase {
    protected liveUpdatableParams = ['note'];

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    async onStart(): Promise<void> {
        // No pipeline; mark as running so UI shows a healthy green dot.
        this.running = true;
        this.ready = true;
        this.health = 'ok';
        this.emit('stateChange', this.getState());
    }

    async onStop(): Promise<void> {
        this.running = false;
        this.ready = false;
        this.health = 'stopped';
        this.emit('stateChange', this.getState());
    }

    /** No GStreamer pipeline — note is display-only. */
    buildPipeline(_config: Record<string, unknown>): PipelineDescription | null {
        return null;
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
    }
}

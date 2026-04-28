import type { GstChildProcess } from '../child-process/GstChildProcess.js';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { ProcessManager } from '../child-process/ProcessManager.js';
import type { DeviceProviderRegistry } from '../system/DeviceProviderRegistry.js';

/** Services passed to a plugin's static `registerServices` hook (once per plugin class). */
export interface EngineServices {
    pipeWire: PipeWireManager;
    mediaRouter: MediaRouter;
    processManager: ProcessManager;
    deviceProviders: DeviceProviderRegistry;
}

/** Services passed to each module instance's `onInit` — `EngineServices` plus the instance id. */
export interface ModuleServices extends EngineServices {
    instanceId: string;
}

/**
 * Interface that every plugin's engine module must implement.
 */
export interface PluginModule {
    /** Initialise with config and engine services. Called once before start. */
    onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void>;
    /** Start the module (begin processing). */
    onStart(): Promise<void>;
    /** Stop the module (halt processing, release resources). */
    onStop(): Promise<void>;
    /** Destroy the module (final cleanup). */
    onDestroy(): Promise<void>;
    /** Return current runtime state. */
    getState(): import('@media-router/shared-types').ModuleRuntimeState;
    /** Return list of config params that can be changed without restart. */
    getLiveUpdatableParams(): string[];
    /** Apply live config changes (only for params in getLiveUpdatableParams). */
    onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void>;
    /** Return PipeWire node names for audio routing (single-port modules). */
    getPipeWireNodes?(): { source?: string; sink?: string };
    /** Return PipeWire node names for a specific port (multi-port modules like N-1 mixer). */
    getPipeWireNodeForPort?(portId: string): { source?: string; sink?: string };
    /** Return dynamic ports based on config (overrides manifest ports). */
    getDynamicPorts?(): Array<{
        id: string;
        direction: 'input' | 'output';
        streamType: string;
        label: string;
        maxConnections?: number;
    }>;
    /** Return the GStreamer child process (for MPEG-TS piping). */
    getChildProcess?(): GstChildProcess | null;
    /** Count of running child processes owned by this module. */
    getProcessCount?(): number;
}

/**
 * Pipeline description returned by GstPluginBase.buildPipeline().
 * Phase 3 (gst-runner) will consume this to spawn GStreamer.
 */
export interface PipelineDescription {
    /** GStreamer pipeline string (for gst-launch style). */
    pipeline: string;
    /** Elements that should have a `level` element for VU metering. */
    vuElements?: string[];
    /** Elements whose properties can be changed live. */
    liveElements?: Record<string, string[]>;
    /** When true, gst-runner pipes stdin/stdout for data (MPEG-TS) instead of bus messages. */
    useStdioForData?: boolean;
    /** When true, pipeline auto-restarts on GStreamer bus error or EOS (like v1 reload behaviour). */
    restartOnError?: boolean;
    /**
     * Rules for linking sometimes-pads (tsdemux, decodebin, …) to dynamically
     * created branches at runtime. Each rule listens for `pad-added` on a
     * named element in the pipeline and instantiates one fresh branch per
     * matched pad — capped by the length of `branches`. See `PadLinkRule`.
     */
    linkOnPadAdded?: PadLinkRule[];
}

export interface PadLinkRule {
    /** Element name in the pipeline whose `pad-added` is observed. */
    from: string;
    /** Caps filter — only match pads whose first caps structure starts with `${media}/`. */
    media: 'video' | 'audio';
    /**
     * One parse_launch fragment per matched pad, in pad-added order. The Nth
     * matching pad is linked to `branches[N]`; pads beyond the list length
     * are ignored.
     */
    branches: string[];
    /**
     * Optional — name of an outer-pipeline element to request a sink pad on
     * after each branch is built. The branch's auto-ghosted src pad is
     * linked to this element's freshly-requested `sink_%d`. Used to bridge
     * dynamically-built branches into a named muxer.
     */
    linkTo?: string;
}

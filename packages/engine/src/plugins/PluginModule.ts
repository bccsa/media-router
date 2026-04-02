import type { GstChildProcess } from '../child-process/GstChildProcess.js';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { ProcessManager } from '../child-process/ProcessManager.js';

/**
 * Services injected into plugins on init.
 * Provides access to engine subsystems without tight coupling.
 */
export interface ModuleServices {
    /** PipeWire manager for creating null-sinks and controlling volume. */
    pipeWire: PipeWireManager;
    /** Media router for querying UDP endpoints. */
    mediaRouter: MediaRouter;
    /** Process manager for spawning external CLI tools (RIST, SRT, etc.). */
    processManager: ProcessManager;
    /** The module's instance ID (unique per module instance). */
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
    getDynamicPorts?(): Array<{ id: string; direction: 'input' | 'output'; streamType: string; label: string; maxConnections?: number }>;
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
}

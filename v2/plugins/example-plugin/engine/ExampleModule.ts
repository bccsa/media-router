/**
 * Example plugin module — minimal implementation of the PluginModule interface.
 * Use this as a template when creating new plugins.
 *
 * The PluginModule interface will be defined in @media-router/engine (Phase 2).
 * For now this is a standalone stub demonstrating the expected shape.
 */
export class ExampleModule {
    private config: Record<string, unknown> = {};

    async onInit(config: Record<string, unknown>): Promise<void> {
        this.config = config;
        console.log(`[ExampleModule] Initialised with config:`, config);
    }

    async onStart(): Promise<void> {
        console.log(`[ExampleModule] Started`);
    }

    async onStop(): Promise<void> {
        console.log(`[ExampleModule] Stopped`);
    }

    async onDestroy(): Promise<void> {
        console.log(`[ExampleModule] Destroyed`);
    }

    getState() {
        return {
            running: false,
            ready: false,
            health: 'stopped' as const,
            pendingRestart: false,
        };
    }

    getLiveUpdatableParams(): string[] {
        return [];
    }

    async onLiveConfigUpdate(_changes: Record<string, unknown>): Promise<void> {
        // No live-updatable params in this example
    }
}

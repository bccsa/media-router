// v104 F3's PipeWire stand-in: PA modules loaded and unloaded by ID and name, a load that fails on
// demand, and the count of each node name loaded now.
export function fakeOwnPipeWire() {
    let nextId = 100;
    const loaded = new Map<number, string>();
    const state = { failLoadAt: -1, loads: 0 };
    const load = (name: string) => {
        if (state.loads++ === state.failLoadAt) throw new Error('load failed (test)');
        const id = nextId++;
        loaded.set(id, name);
        return id;
    };
    return {
        state,
        /** How many PA modules of each name are loaded now. */
        counts(): Record<string, number> {
            const c: Record<string, number> = {};
            for (const n of loaded.values()) c[n] = (c[n] ?? 0) + 1;
            return c;
        },
        loadNullSink: async (name: string) => load(`MR_PW_${name}`),
        loadLoopback: async (connId: string) => load(`MR_PW_CONN_${connId}`),
        unloadModule: async (id: number, name?: string) => {
            if (loaded.get(id) === (name ?? loaded.get(id))) loaded.delete(id);
        },
        setSinkVolume: async () => {},
        waitForSink: async () => true,
        releaseAll: async () => {},
    };
}

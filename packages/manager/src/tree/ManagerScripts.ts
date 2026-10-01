import {
    ScriptRuns,
    absolutePath,
    abortableSleep,
    createLogger,
    dashboardsOf,
    joinPath,
    runArgs,
    runKey,
    splitPath,
    type Dashboard,
    type ScriptEnv,
} from '@media-router/shared-types';
import { TreeCallError, type TopicBus, type TreeCaller } from '@media-router/topic-tree';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { ManagerTree } from './ManagerTree.js';
import type { TreeCalls } from './TreeCalls.js';
import type { TreeWrites } from './TreeWrites.js';

const log = createLogger('ButtonRuns');

/**
 * Button runs pressed on a manager page (ADR-0027): manager dashboards
 * (`/dashboards/<id>`, scope `_`) and router dashboards seen through the
 * manager (`/engines/<id>/dashboards/<did>`, scope = the engine). The manager
 * runs the stored script against its own tree — each step a write or call as
 * a browser makes it — and publishes `/runs/<scope>/<dashboard>/<widget>`.
 */
export class ManagerScripts {
    readonly runs: ScriptRuns;
    private writes: TreeWrites | null = null;
    private calls: TreeCalls | null = null;

    constructor(private readonly d: { tree: ManagerTree; bus: Pick<TopicBus, 'publish'>; configStore: ConfigStore }) {
        this.runs = new ScriptRuns(
            (key, state) => d.bus.publish([{ op: 'add', path: joinPath(['runs', ...key.split('/')]), value: state }]),
            Date.now,
            (key, state) => log.info({ key, ...state }, 'Button run'),
        );
    }

    /** Wired after both exist: steps go through the same writes and calls a browser uses. */
    attach(writes: TreeWrites, calls: TreeCalls): void {
        this.writes = writes;
        this.calls = calls;
    }

    /** `run` / `stop`; undefined when `path`/`method` is not one. */
    call(caller: TreeCaller, path: string, method: string, raw: unknown): unknown {
        if (method !== 'run' && method !== 'stop') return undefined;
        const seg = splitPath(path);
        let scope: string;
        let dashboard: Dashboard | undefined;
        let prefix: string;
        if (seg.length === 2 && seg[0] === 'dashboards') {
            scope = '_';
            prefix = '';
            dashboard = method === 'run' ? this.d.configStore.getDashboard(seg[1]) : undefined;
        } else if (seg.length === 4 && seg[0] === 'engines' && seg[2] === 'dashboards') {
            scope = seg[1];
            prefix = joinPath(['engines', seg[1]]);
            if (method === 'run') {
                const profile = this.d.configStore.getEngine(seg[1])?.active_profile as string | undefined;
                dashboard = profile ? dashboardsOf(this.d.configStore.getProfile(seg[1], profile))[seg[3]] : undefined;
            }
        } else return undefined;

        const args = runArgs(raw);
        if (!args) throw new TreeCallError('invalid arguments');
        const key = runKey(scope, seg.at(-1)!, args.widget);
        if (method === 'stop') return { stopped: this.runs.stop(key) };

        const script = dashboard?.widgets.find((w) => w.id === args.widget)?.script;
        if (!script) throw new TreeCallError('This button has no actions');
        const { writes, calls } = this;
        if (!writes || !calls) throw new TreeCallError('not ready');
        const abs = (p: string) => absolutePath(prefix, p);
        const env: ScriptEnv = {
            read: (p) => this.d.tree.get(splitPath(abs(p))),
            write: async (p, value) => {
                const { rejected } = await writes.handle(caller, [{ op: 'replace', path: abs(p), value }], 0);
                if (rejected.length > 0) throw new Error(`${p}: ${rejected[0].reason}`);
            },
            call: async (p, m) => calls.handle(caller, abs(p), m, undefined),
            sleep: abortableSleep,
            now: Date.now,
        };
        if (!this.runs.start(key, script, env)) throw new TreeCallError('Already running');
        return {};
    }
}

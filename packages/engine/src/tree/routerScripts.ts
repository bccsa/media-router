import {
    ScriptRuns,
    abortableSleep,
    createLogger,
    joinPath,
    runArgs,
    runKey,
    scriptReboots,
    splitPath,
    type Dashboard,
    type RunState,
    type ScriptEnv,
} from '@media-router/shared-types';
import { TreeCallError } from '@media-router/topic-tree';
import type { RouterTree } from './RouterTree.js';
import { rebootNeedsConfirm, routerCall, routerWrites, type RouterActions } from './routerWrites.js';

const log = createLogger('ButtonRuns');


export function runsTree(publish: (path: string, state: RunState) => void): ScriptRuns {
    return new ScriptRuns(
        (key, state) => publish(joinPath(['runs', ...key.split('/')]), state),
        Date.now,
        (key, state) => log.info({ key, ...state }, 'Button run'),
    );
}

/**
 * `run` / `stop` on `/dashboards/<id>` (ADR-0027): the router runs the button's
 * stored script against its own tree, each step through the checks a browser
 * write or call gets. Undefined = not a script call.
 */
export function routerScriptCall(
    tree: RouterTree,
    actions: RouterActions,
    runs: ScriptRuns,
    path: string,
    method: string,
    raw: unknown,
): unknown {
    const [branch, dashboardId, ...rest] = splitPath(path);
    if (branch !== 'dashboards' || dashboardId === undefined || rest.length > 0) return undefined;
    if (method !== 'run' && method !== 'stop') return undefined;
    const args = runArgs(raw);
    if (!args) throw new TreeCallError('invalid arguments');
    // Scope `_`: this router's own dashboards.
    const key = runKey('_', dashboardId, args.widget);
    if (method === 'stop') return { stopped: runs.stop(key) };

    const dashboard = tree.view.get(['dashboards', dashboardId]) as Dashboard | undefined;
    const script = dashboard?.widgets.find((w) => w.id === args.widget)?.script;
    if (!script) throw new TreeCallError('This button has no actions');
    if (scriptReboots(script.steps) && !actions.managerConnected() && !args.confirm) throw rebootNeedsConfirm();
    const origin = `button:${key}`;
    const env: ScriptEnv = {
        read: (p) => tree.view.get(splitPath(p)),
        write: async (p, value) => {
            const { rejected } = routerWrites(tree, actions, origin, [{ op: 'replace', path: p, value }], 0);
            if (rejected.length > 0) throw new Error(`${p}: ${rejected[0].reason}`);
        },
        // A reboot was confirmed above, when the manager is down.
        call: async (p, m) => routerCall(actions, p, m, m === 'reboot' ? { confirm: true } : undefined),
        sleep: abortableSleep,
        now: Date.now,
    };
    if (!runs.start(key, script, env)) throw new TreeCallError('Already running');
    return {};
}

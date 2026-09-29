import { createLogger, diffConfig, GRAPH_KEYS, type PatchOp } from '@media-router/shared-types';
import type { ConfigPush, LocalChanges } from './LocalChanges.js';

const log = createLogger('ConfigPush');

type Obj = Record<string, unknown>;

export interface ConfigPushDeps {
    localChanges: LocalChanges;
    getConfig: () => Obj | null;
    setConfig: (config: Obj) => void;
    isRunning: () => boolean;
    /** Manager-sourced ops through the engine's patch router (live apply + LCP). */
    applyOps: (ops: PatchOp[]) => void;
    /** Tell the LCP and router tree the whole config changed. */
    broadcastConfig: (config: Obj) => void;
    /** Rebuild every module from the current config. */
    restartAll: () => void;
}

/**
 * A config from the manager (ADR-0025). A `connect` push of the profile this
 * router is running is merged with its outage journal and only the
 * difference is applied to the running modules — live values at once,
 * modules and connections added or removed, non-live settings flagged
 * pendingRestart. Anything else replaces the config; a profile switched
 * during an outage rebuilds the modules.
 */
export function applyConfigPush(deps: ConfigPushDeps, raw: Obj): void {
    const { _push, ...pushed } = raw as Obj & { _push?: ConfigPush };
    const current = deps.getConfig();
    const runningProfile = deps.localChanges.profile;
    const { config, replay } = deps.localChanges.merge(pushed, _push);
    const reconnect = _push?.reason === 'connect';
    const profileSwitched = reconnect && runningProfile !== undefined && _push?.profile !== runningProfile;

    if (current && reconnect && !profileSwitched && deps.isRunning()) {
        const ops = diffConfig(current, config);
        if (ops.length > 0) {
            const paths = ops.slice(0, 20).map((o) => `${o.op} ${o.path}`);
            log.info({ opCount: ops.length, paths }, 'Reconnect: applying the difference to the running modules');
            deps.applyOps(ops);
        }
        for (const [key, value] of Object.entries(config)) if (!GRAPH_KEYS.includes(key)) current[key] = value;
    } else {
        deps.setConfig(config);
        deps.broadcastConfig(config);
        if (profileSwitched && deps.isRunning()) {
            log.info({ profile: _push?.profile }, 'Profile switched during the outage: rebuilding modules');
            deps.restartAll();
        }
    }
    deps.localChanges.markSynced(replay);
}

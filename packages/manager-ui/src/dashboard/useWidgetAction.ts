// A widget's press: a button's action or script, its confirm, progress and failure.
import { computed, inject, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { DashboardWidget, RunState } from '@media-router/shared-types';
import * as wire from '@media-router/shared-types/browser';
import { errorCode } from '@/tree/TreeClient';
import { ASK, DASHBOARD_ID } from './keys';
import { scriptSummary } from './scriptText';
import { routerOf } from './paths';
import { useSubscription } from './useValue';
import { useTimed } from './useTimed';
import type { DashboardSource } from './source';

const NO_MANAGER = 'The manager is unreachable: after the reboot this router stays stopped until the manager is back.';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { absolutePath } = wire;

/** A flag that is set for a moment: a refused write flashes the widget's border. */
export function useFlash(ms = 1200): { on: Ref<boolean>; flash: () => void } {
    const { value, set } = useTimed(false, ms);
    return { on: value, flash: () => set(true) };
}

/** What a single action does, for its confirmation. */
export function consequence(a: DashboardWidget['action']): string | undefined {
    if (a?.kind === 'call' && a.method === 'reboot') return 'The router reboots now; its outputs stop until it is back.';
    if (a?.kind === 'call' && a.method === 'reset') return 'Audio and every module restart; outputs drop for a few seconds.';
    if (a?.kind === 'call') return 'The module restarts; its output drops briefly.';
    if (a?.path.endsWith('/info/running')) return a.value === true ? 'All modules start.' : 'All modules stop.';
    return undefined;
}

/**
 * A button press: its single action here, or its script on the server this
 * page talks to (ADR-0027), whose run state every viewer sees under `/runs`.
 */
export function useWidgetAction(opts: {
    source: DashboardSource;
    widget: () => DashboardWidget;
    interactive: () => boolean;
    /** The confirm question's title; undefined = no confirm. */
    confirmTitle: () => string | undefined;
    flash: () => void;
}): { busy: ComputedRef<boolean>; progress: ComputedRef<string | undefined>; failure: Ref<string>; press: () => Promise<void> } {
    const { source } = opts;
    const ask = inject(ASK, async () => false);
    const dashboardId = inject(DASHBOARD_ID, ref(undefined));
    const calling = ref(false);

    const script = computed(() => opts.widget().script);
    const at = () => `${source.prefix}/dashboards/${dashboardId.value}`;
    const runPath = computed(() =>
        script.value && dashboardId.value ? `/runs/${routerOf(source.prefix) ?? '_'}/${dashboardId.value}/${opts.widget().id}` : undefined,
    );
    useSubscription(source, () => (runPath.value ? [runPath.value] : []));
    const runState = computed(() => (runPath.value ? source.get<RunState>(runPath.value) : undefined));
    const running = computed(() => runState.value?.state === 'running');
    const progress = computed(() => {
        const s = runState.value;
        if (!running.value || !s) return undefined;
        return s.of > 1 ? `${s.step}/${s.of}` : 'running';
    });

    const { value: failure, set: showFailure } = useTimed('', 8000);
    function fail(message: string) {
        showFailure(message);
        opts.flash();
    }
    const openedAt = Date.now();
    watch(runState, (s, prev) => {
        if (s?.state === 'failed' && s.at >= openedAt && s.at !== prev?.at) fail(`Step ${s.step}: ${s.error ?? 'failed'}`);
    });

    /** A reboot with the manager down is refused once: ask, then send it with confirm. */
    async function confirming(send: (confirm: boolean) => Promise<unknown>, onError: (err: unknown) => void) {
        try {
            await send(false);
        } catch (err) {
            if (errorCode(err) !== 'needs-confirm') onError(err);
            else if (await ask('Reboot anyway?', NO_MANAGER)) await send(true).catch(onError);
        }
    }

    async function runScript() {
        const w = opts.widget().id;
        await confirming(
            (confirm) => source.call(at(), 'run', { widget: w, ...(confirm ? { confirm: true } : {}) }),
            (err) => fail(String((err as Error)?.message ?? err)),
        );
    }

    async function runAction() {
        const a = opts.widget().action;
        if (!a) return;
        const path = absolutePath(source.prefix, a.path);
        // Busy while a request is out, not while a question is open.
        const busyWhile = <T>(p: Promise<T>) => {
            calling.value = true;
            return p.finally(() => (calling.value = false));
        };
        if (a.kind === 'call') {
            await confirming((confirm) => busyWhile(source.call(path, a.method, confirm ? { confirm: true } : undefined)), opts.flash);
            return;
        }
        try {
            if ((await busyWhile(source.write([{ op: 'replace', path, value: a.value }]))).rejected.length > 0) opts.flash();
        } catch {
            opts.flash();
        }
    }

    async function press() {
        if (!opts.interactive()) return;
        const title = opts.confirmTitle();
        if (script.value) {
            if (running.value) {
                if (await ask('Stop the running actions?')) await source.call(at(), 'stop', { widget: opts.widget().id }).catch(() => {});
                return;
            }
            if (title && !(await ask(title, scriptSummary(script.value)))) return;
            await runScript();
            return;
        }
        if (title && !(await ask(title, consequence(opts.widget().action)))) return;
        await runAction();
    }

    return { busy: computed(() => calling.value || running.value), progress, failure, press };
}

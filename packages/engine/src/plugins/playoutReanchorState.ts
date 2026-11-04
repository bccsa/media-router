import type { createLogger } from '@media-router/shared-types';
import type { ModuleServices } from './PluginModule.js';
import { effectivePlayoutOffsetMs } from './playoutOffset.js';
import {
    PLAYOUT_BADGE,
    PLAYOUT_SECTION,
    REANCHOR_HOLD_MS,
    judgeCause,
    readReanchorRequest,
    type PlayoutLegOffset,
    type PlayoutRaise,
    type PlayoutRebaseNote,
} from './playoutReanchor.js';
import {
    HEAD_PLAYOUT_SECTION,
    LEG_PLAYOUT_SECTION,
    ceilingWarning,
    headPlayoutStatus,
    heldWarningLeg,
    legPlayoutAt,
    legPlayoutStatus,
    legReanchorWarning,
    raiseWarningHead,
    raiseWarningLeg,
    reanchorBadge,
    rebaseWarningHead,
    rebaseWarningLeg,
    type LegPlayout,
    type PlayoutSection,
} from './playoutReanchorText.js';

export type PlayoutWarningKind = 'reanchor' | 'rebase';

/** What a module lends its re-anchor display (`GstPluginBase`). */
export interface PlayoutDisplayHost {
    services(): ModuleServices | null;
    log(): ReturnType<typeof createLogger>;
    /** The head's configured D (config, else the engine default). */
    configuredOffsetMs(): number;
    showSection(section: PlayoutSection, status: Record<string, unknown>): void;
    /** Drop the playout section, if shown. */
    clearSection(id: string): void;
    setBadge(id: string, badge: { icon: string; text: string; color: string } | null): void;
    /** Taken only over `ok` or our own re-anchor/rebase text (ADR-0010 rule 2). */
    warn(kind: PlayoutWarningKind, text: string): void;
    clearWarnings(): void;
    /** The leg's raise is held or no longer is (B-210): a sink-paced reading is not silence. */
    heldChanged?(held: boolean): void;
}

/** A leg's standing state: `held` (a raise cannot help it) and `own` (re-anchored on its own,
 *  its route not raised) keep their warning while they last; `settled`: the raise it asked for
 *  landed and it plays on time again, so the raise is state, not news (B-206). */
interface LegState {
    kind: PlayoutWarningKind;
    text: string;
    status: Record<string, unknown>;
    settled?: boolean;
    mode?: 'held' | 'own';
    excessMs?: number;
}

/**
 * Playout re-anchor display, both ends (ADR-0005 amendment 2026-10-08): the
 * LEG asks for budget (or reports a rebase) and shows what it asked; the HEAD
 * shows the raise it carries (section, badge, warning). Both read the router's
 * standing state again at a start or a PLAYING, so a restarted module shows it (B-210).
 */
export class PlayoutReanchorState {
    private leg: LegState | null = null;
    /** Head: the route's raise on this head, and a rebase reported below it. */
    private head: { raise: PlayoutRaise | null; rebase: PlayoutRebaseNote | null } = {
        raise: null,
        rebase: null,
    };

    constructor(private readonly host: PlayoutDisplayHost) {}

    /** Runner `playout_reanchor`: ask the route head for budget, or report a rebase. */
    async onEvent(payload: unknown): Promise<void> {
        const ev = readReanchorRequest(payload);
        const services = this.host.services();
        const id = services?.instanceId;
        const router = services?.mediaRouter;
        if (!ev || !id || !router) return;
        const headLabel = router.getRoutePlayoutHead(id)?.label ?? 'the route head';
        if (ev.kind === 'rebase') {
            this.host
                .log()
                .warn(
                    { playoutReanchor: ev },
                    'Playout re-anchor: implausible timeline — this output rebased onto arrival + D',
                );
            const status = legPlayoutStatus(ev, { ...this.at(headLabel), raisedToMs: null });
            this.setLeg('rebase', rebaseWarningLeg(ev, headLabel), status);
            router.notePlayoutRebase(id, undefined, ev);
            return;
        }
        // The display's cause as the engine judges it: a queue the standing raise filled is no backlog.
        const standing =
            router.getRoutePlayoutRaiseMs(id) + (router.getPlayoutLegOffsetMs?.(id) ?? 0);
        const shown = { ...ev, cause: judgeCause(ev, standing) };
        const outcome = await router.requestPlayoutRaise(id, undefined, ev);
        if (outcome === 'off') return;
        const toMs = effectivePlayoutOffsetMs(this.host.services());
        const raiseMs = router.getRoutePlayoutRaiseMs(id);
        const wasHeld = this.leg?.mode === 'held';
        if (outcome !== 'held' || !wasHeld) {
            this.host
                .log()
                .warn(
                    { playoutReanchor: ev, outcome, raisedToMs: toMs },
                    `Playout re-anchor: ${Math.round(ev.excessMs)} ms late for ${ev.holdMs} ms — route ${outcome}, nothing dropped`,
                );
        }
        const status = legPlayoutStatus(shown, this.at(headLabel));
        if (outcome === 'held') {
            this.setLeg('reanchor', heldWarningLeg(ev.excessMs, headLabel, toMs), status, {
                mode: 'held',
                excessMs: ev.excessMs,
            });
        } else if (outcome === 'leg') {
            const own = router.getPlayoutLegOffsetMs?.(id) ?? 0;
            this.setLeg('reanchor', legReanchorWarning(ev, own, headLabel), status, {
                mode: 'own',
                excessMs: ev.excessMs,
            });
        } else {
            const text =
                outcome === 'ceiling'
                    ? ceilingWarning(raiseMs, toMs - raiseMs)
                    : raiseWarningLeg(ev, headLabel, toMs - raiseMs, toMs);
            this.setLeg('reanchor', text, status);
        }
        if (wasHeld !== (outcome === 'held')) this.host.heldChanged?.(outcome === 'held');
    }

    /** Head: this route's raise (`null` = cleared). Leg: its route's raise reset to 0. */
    onRouteRaised(raise: PlayoutRaise | null): void {
        if (raise && raise.headId !== this.host.services()?.instanceId) {
            if (raise.raiseMs !== 0 || this.leg?.kind !== 'reanchor') return;
            // Held or re-anchored on its own, it stands; held, its text gives the D it is held at now.
            if (!this.leg.mode) this.setLeg(null);
            else if (this.leg.mode === 'held') this.refreshHeld();
            return;
        }
        // `null` clears all three (section, badge, warning), a rebase note too.
        this.head = { raise, rebase: raise ? this.head.rebase : null };
        this.renderHead();
    }

    /** Head: a leg below it rebased itself — a producer timeline fault (`null`: withdrawn). */
    onRouteRebased(note: PlayoutRebaseNote | null): void {
        this.head = { ...this.head, rebase: note };
        this.renderHead();
    }

    /** Leg: its own re-anchor (B-210), `null` once it cleared. */
    onLegOffset(offset: PlayoutLegOffset | null): void {
        if (offset || this.leg?.mode !== 'own') return;
        this.leg = null;
        this.clearDisplay();
        this.pull();
        this.show();
    }

    /**
     * PLAYING sets health `ok` directly — put the re-anchor state back. A leg's
     * rebase lived in the old pipeline's pad offset, so it is gone; a head's
     * rebase note goes too (a restarted producer is the fix). Raises stay, read
     * again from the router: a new instance (a profile restart) shows them too.
     * Silent for a module that never re-anchored.
     */
    reassert(): void {
        if (this.leg?.kind === 'rebase') this.leg = null;
        this.head = { ...this.head, rebase: null };
        this.pull();
        this.show();
    }

    /** Show the standing state again, nothing dropped (another warning of the module withdrew). */
    show(): void {
        if (this.leg?.settled) this.host.showSection(LEG_PLAYOUT_SECTION, this.leg.status);
        else if (this.leg) this.setLeg(this.leg.kind, this.leg.text, this.leg.status, this.leg);
        else this.renderHead();
    }

    /** Leg: its sink plays on time again (a module that watches it). A raise it asked for is
     *  then its section alone: the warning goes, and no later PLAYING or `show` posts it again.
     *  A hold is over (its device lateness went); its own re-anchor stands while it lasts. */
    onPlayoutOnTime(): void {
        const services = this.host.services();
        if (services?.instanceId) services.mediaRouter?.notePlayoutOnTime?.(services.instanceId);
        if (this.leg?.kind !== 'reanchor' || this.leg.settled || this.leg.mode === 'own') return;
        const wasHeld = this.leg.mode === 'held';
        this.leg = { ...this.leg, settled: true, mode: undefined };
        this.host.clearWarnings();
        this.host.showSection(LEG_PLAYOUT_SECTION, this.leg.status);
        if (wasHeld) this.host.heldChanged?.(false);
    }

    /** Leg: its content lateness without D, each timing tick (null: no reading) — what brings
     *  a raise or its own re-anchor back down (B-210). */
    onContentLateness(lateMs: number | null): void {
        const services = this.host.services();
        const id = services?.instanceId;
        if (id) services?.mediaRouter?.notePlayoutLateness?.(id, undefined, lateMs);
    }

    /** A raise could not help this leg: its sink's lateness is how it plays, not silence. */
    held(): boolean {
        return this.leg?.mode === 'held';
    }

    /** Where this leg's D stands now, for its section: configured, raised to, since when. */
    private at(headLabel: string): LegPlayout {
        const services = this.host.services();
        const id = services?.instanceId ?? '';
        const router = services?.mediaRouter;
        const view = router?.getLegPlayout?.(id);
        const toMs = effectivePlayoutOffsetMs(services);
        const raised = router
            ? router.getRoutePlayoutRaiseMs(id) + (router.getPlayoutLegOffsetMs?.(id) ?? 0)
            : 0;
        return {
            headLabel,
            configuredMs: view?.baseMs ?? toMs - raised,
            raisedToMs: toMs,
            since: view?.own?.since ?? view?.raise?.since ?? null,
        };
    }

    /** The router's standing state for this module, when it keeps none of its own (B-210). */
    private pull(): void {
        const services = this.host.services();
        const id = services?.instanceId;
        const router = services?.mediaRouter;
        if (!id || !router) return;
        // The runner's rebase notes died with the pipeline; a leg's own re-anchor stands (B-210).
        if (router.getHeadPlayoutRaise) {
            const raise = router.getHeadPlayoutRaise(id);
            this.head = { raise, rebase: router.getHeadPlayoutNote?.(id) ?? this.head.rebase };
        }
        if (this.leg) return;
        const view = router.getLegPlayout?.(id);
        if (!view?.asked && !view?.own) return;
        const status = legPlayoutStatus(null, this.at(view.headLabel));
        if (view.own) {
            const req = { excessMs: view.own.excessMs, holdMs: REANCHOR_HOLD_MS };
            const text = legReanchorWarning(req, view.own.offsetMs, view.headLabel);
            this.leg = { kind: 'reanchor', text, status, mode: 'own', excessMs: view.own.excessMs };
        } else if (view.raise) {
            this.leg = { kind: 'reanchor', text: '', status, settled: true };
        }
    }

    /** A held leg's text and section with the D it is held at now (its raise came down). */
    private refreshHeld(): void {
        const services = this.host.services();
        const id = services?.instanceId;
        const leg = this.leg;
        if (!id || !leg || leg.excessMs === undefined) return;
        const headLabel = services?.mediaRouter?.getRoutePlayoutHead(id)?.label ?? 'the route head';
        const at = this.at(headLabel);
        const status = { ...leg.status, ...legPlayoutAt(at) };
        this.setLeg(
            'reanchor',
            heldWarningLeg(leg.excessMs, headLabel, at.raisedToMs ?? 0),
            status,
            leg,
        );
    }

    /** Set (or with `null`, drop) this leg's re-anchor warning and section. */
    private setLeg(
        kind: PlayoutWarningKind | null,
        text = '',
        status: Record<string, unknown> = {},
        keep: Pick<LegState, 'mode' | 'excessMs'> = {},
    ): void {
        this.leg = kind ? { kind, text, status, mode: keep.mode, excessMs: keep.excessMs } : null;
        if (!kind) {
            this.clearDisplay();
            return;
        }
        this.host.showSection(LEG_PLAYOUT_SECTION, status);
        this.host.warn(kind, text);
    }

    private renderHead(): void {
        const { raise, rebase } = this.head;
        this.host.setBadge(PLAYOUT_BADGE, raise && raise.raiseMs > 0 ? reanchorBadge(raise) : null);
        if (!raise && !rebase) {
            this.clearDisplay();
            return;
        }
        this.host.showSection(
            HEAD_PLAYOUT_SECTION,
            headPlayoutStatus(raise, rebase, this.host.configuredOffsetMs()),
        );
        if (rebase) this.host.warn('rebase', rebaseWarningHead(rebase));
        else if (raise) {
            this.host.warn(
                'reanchor',
                raise.atCeiling
                    ? ceilingWarning(raise.raiseMs, raise.baseMs)
                    : raiseWarningHead(raise),
            );
        }
    }

    /** Drop the playout section and our re-anchor warning (only ours). */
    private clearDisplay(): void {
        this.host.clearSection(PLAYOUT_SECTION);
        this.host.clearWarnings();
    }
}

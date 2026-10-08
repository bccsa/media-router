import type { createLogger } from '@media-router/shared-types';
import type { ModuleServices } from './PluginModule.js';
import { effectivePlayoutOffsetMs } from './playoutOffset.js';
import {
    PLAYOUT_BADGE,
    PLAYOUT_SECTION,
    readReanchorRequest,
    type PlayoutRaise,
    type PlayoutRebaseNote,
} from './playoutReanchor.js';
import {
    HEAD_PLAYOUT_SECTION,
    LEG_PLAYOUT_SECTION,
    ceilingWarning,
    headPlayoutStatus,
    legPlayoutStatus,
    raiseWarningHead,
    raiseWarningLeg,
    reanchorBadge,
    rebaseWarningHead,
    rebaseWarningLeg,
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
}

/**
 * Playout re-anchor display, both ends (ADR-0005 amendment 2026-10-08): the
 * LEG asks for budget (or reports a rebase) and shows what it asked; the HEAD
 * shows the raise it carries (section, badge, warning).
 */
export class PlayoutReanchorState {
    /** Leg: what this leg asked for, or did (its warning text and section). */
    private leg: {
        kind: PlayoutWarningKind;
        text: string;
        status: Record<string, unknown>;
    } | null = null;
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
            this.setLeg(
                'rebase',
                rebaseWarningLeg(ev, headLabel),
                legPlayoutStatus(ev, headLabel, null),
            );
            router.notePlayoutRebase(id, undefined, ev);
            return;
        }
        const outcome = await router.requestPlayoutRaise(id, undefined, ev);
        if (outcome === 'off') return;
        const toMs = effectivePlayoutOffsetMs(this.host.services());
        const raiseMs = router.getRoutePlayoutRaiseMs(id);
        this.host
            .log()
            .warn(
                { playoutReanchor: ev, outcome, raisedToMs: toMs },
                `Playout re-anchor: ${Math.round(ev.excessMs)} ms late for ${ev.holdMs} ms — route ${outcome}, nothing dropped`,
            );
        const text =
            outcome === 'ceiling'
                ? ceilingWarning(raiseMs, toMs - raiseMs)
                : raiseWarningLeg(ev, headLabel, toMs - raiseMs, toMs);
        this.setLeg('reanchor', text, legPlayoutStatus(ev, headLabel, toMs));
    }

    /** Head: this route's raise (`null` = cleared). Leg: its route's raise reset to 0. */
    onRouteRaised(raise: PlayoutRaise | null): void {
        if (raise && raise.headId !== this.host.services()?.instanceId) {
            if (raise.raiseMs === 0 && this.leg?.kind === 'reanchor') this.setLeg(null);
            return;
        }
        // `null` clears all three (section, badge, warning), a rebase note too.
        this.head = { raise, rebase: raise ? this.head.rebase : null };
        this.renderHead();
    }

    /** Head: a leg below it rebased itself — a producer timeline fault. */
    onRouteRebased(note: PlayoutRebaseNote): void {
        this.head = { ...this.head, rebase: note };
        this.renderHead();
    }

    /**
     * PLAYING sets health `ok` directly — put the re-anchor state back. A leg's
     * rebase lived in the old pipeline's pad offset, so it is gone; a head's
     * rebase note goes too (a restarted producer is the fix). Raises stay.
     * Silent for a module that never re-anchored.
     */
    reassert(): void {
        if (this.leg?.kind === 'rebase') this.leg = null;
        this.head = { ...this.head, rebase: null };
        if (this.leg) this.setLeg(this.leg.kind, this.leg.text, this.leg.status);
        else this.renderHead();
    }

    /** Set (or with `null`, drop) this leg's re-anchor warning and section. */
    private setLeg(
        kind: PlayoutWarningKind | null,
        text = '',
        status: Record<string, unknown> = {},
    ): void {
        this.leg = kind ? { kind, text, status } : null;
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

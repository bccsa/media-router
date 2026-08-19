/**
 * Connection-reject reporting — what a failed `createConnection` means for the
 * operator.
 *
 * `MediaRouter.createConnection` throws for two very different reasons. Some
 * failures are transient (a PipeWire node not visible yet) and the applier's
 * retries are exactly the right answer. Others are the graph refusing itself —
 * a stream type the input doesn't accept, a port at capacity, a port that isn't
 * there — and no number of retries can change the answer.
 *
 * The second kind used to end in an engine log line and nothing else: the sink
 * stayed up, healthy-looking and silent, and the operator had to read journals
 * to learn the leg was never wired (the transcoder `acceptsStreamTypes` case,
 * 2026-07-23 DEPLOY NOTE). So those rejects are classified here and turned into
 * a message that names the cause on the sink's own card.
 */

/**
 * Markers of a settled refusal from `MediaRouter.createConnection`. Matched on
 * the thrown message rather than a typed error because the throw sites are
 * plain `Error`s spread across the router and registry; each marker below is
 * anchored to one of them.
 *
 * Deliberately NOT a loose match: a transient pw-link failure that happened to
 * mention "port" must keep its retries and must not park a warning on a card
 * that is about to come good on its own.
 */
const REJECT_MARKERS = [
    // PortRegistry.validateCompatibility, via `Incompatible ports: <reason>` —
    // stream-type mismatch, `acceptsStreamTypes` exact-match list, channel count.
    'Incompatible ports:',
    // Port referenced by the stored connection isn't registered by the running module.
    'Source port not found:',
    'Sink port not found:',
    // Direction is wrong for the end it was wired to.
    'is not an output',
    'is not an input',
    // maxConnections: hard zero, or already at capacity.
    'does not allow connections',
    'connections', // `Port <id> already has <n>/<max> connections`
] as const;

/**
 * True when the message is a settled refusal rather than a transient failure.
 *
 * The bare `connections` marker above would over-match on its own, so capacity
 * is matched on its full shape instead.
 */
export function isConnectionReject(message: string): boolean {
    if (/already has \d+\/\d+ connections/.test(message)) return true;
    return REJECT_MARKERS.filter((m) => m !== 'connections').some((m) => message.includes(m));
}

/**
 * The operator-facing message for a rejected connection, shown on the SINK
 * module — the end that goes silent, and the end whose card the operator is
 * looking at when they ask why there is no audio.
 *
 * The router's own reason is quoted verbatim (it is the single source of truth
 * for *why* the ports don't fit); only the `Incompatible ports:` prefix is
 * dropped, since "Not connected" already says that much.
 */
export function connectionRejectMessage(
    message: string,
    sourceModuleId: string,
    sourcePortId: string,
): string {
    const reason = message.replace(/^Incompatible ports:\s*/, '');
    return `Not connected: ${reason} (from ${sourceModuleId}:${sourcePortId})`;
}

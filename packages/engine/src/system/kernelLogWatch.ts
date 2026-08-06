import * as fs from 'fs';
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('kernelLogWatch');

/**
 * Process-wide watch for the handful of kernel-log lines a module has to react
 * to, because nothing else in userspace will tell it.
 *
 * WHY THIS EXISTS. The Pi HEVC driver latches on its first phase-1 wedge:
 *
 *   rpi-hevc-dec: phase1 stuck - hardware decode disabled until reboot
 *
 * and from that moment fails every hardware decode job with
 * `VB2_BUF_STATE_ERROR`. GStreamer's `v4l2codecs` decoder does not look at
 * `V4L2_BUF_FLAG_ERROR` — it pushes the buffer on regardless — so the pipeline
 * neither errors nor stops: it renders garbage or a frozen frame, forever, and
 * no element posts anything on the bus for a module to notice. The only place
 * the failure is stated at all is the kernel log, so that is where we read it.
 *
 * APPEAR-ONCE. Every signal here is a latch by nature — the kernel says
 * "until reboot", and the driver ratelimits the line to one per 5 s anyway. A
 * signal is therefore emitted at most once per engine process, and a subscriber
 * that arrives AFTER the line was seen is called immediately with the latched
 * event (see `onKernelLogSignal`). That is what makes the backlog scan below
 * safe: it can fire before the video-player plugin is even loaded.
 *
 * COST. Nothing is watched until someone subscribes, and the watch stops for
 * good once every known signal has latched, so a healthy box pays one
 * non-blocking read per `KMSG_POLL_INTERVAL_MS` and a wedged one pays nothing
 * at all after the event.
 */

/** Signals this module knows how to spot. */
export type KernelLogSignalId = 'hevc-decode-disabled';

/** Where a line was read from — carried on the event for the operator log. */
export type KernelLogSource = 'kmsg' | 'dmesg';

export interface KernelLogSignalEvent {
    signal: KernelLogSignalId;
    /** The matched kernel-log line, message text only (kmsg envelope stripped). */
    line: string;
    source: KernelLogSource;
}

export type KernelLogSignalHandler = (event: KernelLogSignalEvent) => void;

interface SignalRule {
    id: KernelLogSignalId;
    match: (line: string) => boolean;
}

/**
 * Match rules, one per signal.
 *
 * The HEVC rule accepts either half of the driver's line on its own: the
 * message text is what the patch prints today, and the `rpi-hevc-dec` +
 * "disabled until reboot" pairing survives a reword of the middle of the
 * sentence. `v4l2_err` prefixes the v4l2_dev name, so the device name is on the
 * same line as the message and no cross-line state is needed.
 */
const SIGNAL_RULES: readonly SignalRule[] = [
    {
        id: 'hevc-decode-disabled',
        match: (line) =>
            /hardware decode disabled until reboot/i.test(line) ||
            (/rpi-hevc-dec/i.test(line) && /disabled until reboot/i.test(line)),
    },
];

/** Every signal id, in rule order. Exported so a test can assert coverage. */
export const KERNEL_LOG_SIGNALS: readonly KernelLogSignalId[] = SIGNAL_RULES.map((r) => r.id);

/** How often the `/dev/kmsg` reader looks for new records. */
export const KMSG_POLL_INTERVAL_MS = 5000;

/**
 * How often the fallback re-runs `dmesg`. Slower than the kmsg poll because it
 * spawns a process: the signal is a permanent condition, so seeing it ten
 * seconds late costs nothing, and a spawn every 5 s on a box that never wedges
 * would not be free.
 */
export const DMESG_POLL_INTERVAL_MS = 10_000;

/** Read buffer. One `/dev/kmsg` read returns one whole record; 8 KiB clears the
 *  kernel's `CONSOLE_EXT_LOG_MAX` with room to spare. */
const READ_BUFFER_BYTES = 8192;

/** Cap on `dmesg` output we are willing to hold — the ring buffer is ~1 MiB. */
const DMESG_MAX_BUFFER = 4 * 1024 * 1024;

export interface KernelLogWatchOptions {
    /** Override the kmsg device. Tests point this at a plain file. */
    kmsgPath?: string;
    /** Override the backlog/fallback reader. Tests inject canned output. */
    readDmesg?: () => Promise<string>;
    kmsgPollMs?: number;
    dmesgPollMs?: number;
}

const emitter = new EventEmitter();
// Subscribers are few (one plugin class per signal today) but the default limit
// would warn on a box running many plugin classes rather than fail usefully.
emitter.setMaxListeners(0);

/** Signals seen this process, with the event each subscriber is replayed. */
const latched = new Map<KernelLogSignalId, KernelLogSignalEvent>();

type WatchMode = 'off' | 'kmsg' | 'dmesg';
let mode: WatchMode = 'off';
let kmsgFd: number | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let options: KernelLogWatchOptions = {};
/** Partial record left over from a read that split a line. Always empty on a
 *  real `/dev/kmsg`, which hands out whole records; a plain file can split. */
let carry = '';

/**
 * Message text of one `/dev/kmsg` record.
 *
 * Record syntax is `priority,sequence,timestamp,flags[,key=value…];message`,
 * so everything up to the FIRST `;` is envelope. A line without one (a `dmesg`
 * line, or a continuation) is already message text and is returned as-is.
 */
export function kmsgMessageText(record: string): string {
    const semi = record.indexOf(';');
    return (semi === -1 ? record : record.slice(semi + 1)).trim();
}

/** The signal a kernel-log line announces, or `undefined` for the other 99.9%. */
export function matchKernelLogSignal(line: string): KernelLogSignalId | undefined {
    return SIGNAL_RULES.find((rule) => rule.match(line))?.id;
}

/** Has `signal` been seen this process? The latched event, or `undefined`. */
export function kernelLogSignalEvent(signal: KernelLogSignalId): KernelLogSignalEvent | undefined {
    return latched.get(signal);
}

/**
 * Subscribe to a kernel-log signal, starting the watch if nobody had yet.
 *
 * Fires the handler SYNCHRONOUSLY when the signal already latched — the line
 * routinely predates the subscriber (it can predate the engine process
 * entirely), and a subscriber that only heard about future occurrences would
 * miss the one occurrence there will ever be.
 */
export function onKernelLogSignal(
    signal: KernelLogSignalId,
    handler: KernelLogSignalHandler,
): void {
    emitter.on(signal, handler);
    const already = latched.get(signal);
    if (already) {
        handler(already);
        return;
    }
    startKernelLogWatch();
}

export function offKernelLogSignal(
    signal: KernelLogSignalId,
    handler: KernelLogSignalHandler,
): void {
    emitter.off(signal, handler);
}

/**
 * Begin reading the kernel log. Idempotent; `onKernelLogSignal` calls it, so
 * an engine whose plugins care about none of this never opens anything.
 *
 * The kmsg reader doubles as the BACKLOG SCAN: a fresh open of `/dev/kmsg`
 * starts at the oldest record still in the ring, so the first drain sees lines
 * printed long before the engine started — the case that matters most here,
 * since the driver latches on the first wedge and the engine may well be
 * restarting *because* of it.
 */
export function startKernelLogWatch(opts: KernelLogWatchOptions = {}): void {
    if (mode !== 'off') return;
    options = opts;
    if (startKmsgReader()) return;
    startDmesgPolling();
}

/** Stop reading. Latched signals are kept — they are facts about this boot. */
export function stopKernelLogWatch(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (kmsgFd !== null) {
        try {
            fs.closeSync(kmsgFd);
        } catch {
            /* already gone */
        }
        kmsgFd = null;
    }
    carry = '';
    mode = 'off';
}

/** Which reader is running — exposed for status/logging and tests. */
export function kernelLogWatchMode(): 'off' | 'kmsg' | 'dmesg' {
    return mode;
}

/**
 * Open `/dev/kmsg` non-blocking and drain what is already in the ring.
 *
 * Returns false when the device can't be read — `dmesg_restrict=1` denies a
 * non-root engine, and a container may not have the node at all — which is the
 * whole reason the `dmesg` fallback exists.
 */
function startKmsgReader(): boolean {
    const path = options.kmsgPath ?? '/dev/kmsg';
    try {
        kmsgFd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch (err) {
        log.debug({ err, path }, 'kernel log: /dev/kmsg not readable, falling back to dmesg');
        kmsgFd = null;
        return false;
    }
    mode = 'kmsg';
    carry = '';
    drainKmsg();
    // `mode` can already be back to 'off' here: a signal that latched during the
    // backlog drain stops the watch, and arming a timer after that would revive it.
    if (mode !== 'kmsg') return true;
    pollTimer = setInterval(drainKmsg, options.kmsgPollMs ?? KMSG_POLL_INTERVAL_MS);
    pollTimer.unref?.();
    return true;
}

/**
 * Read every record available right now, then stop. Non-blocking, so "nothing
 * new" is an `EAGAIN` on the very first read — the steady-state cost of the
 * watch on a healthy box, once per poll.
 */
function drainKmsg(): void {
    if (kmsgFd === null) return;
    const buf = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    for (;;) {
        let bytes: number;
        try {
            bytes = fs.readSync(kmsgFd, buf, 0, buf.length, null);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            // EAGAIN: caught up with the ring — the normal way out of this loop.
            if (code === 'EAGAIN') return;
            // EPIPE: records we had not read yet were overwritten. The kernel has
            // already moved our position to the oldest surviving record, so the
            // next read succeeds; we lost lines, not the reader.
            if (code === 'EPIPE') continue;
            log.warn({ err }, 'kernel log: /dev/kmsg read failed, falling back to dmesg');
            stopKernelLogWatch();
            startDmesgPolling();
            return;
        }
        if (bytes <= 0) return; // EOF (only reachable on a plain file)
        ingest(buf.toString('utf8', 0, bytes), 'kmsg');
        if (mode !== 'kmsg') return; // latched and stopped mid-drain
    }
}

/**
 * Fallback reader: re-scan the whole of `dmesg` on a slow timer.
 *
 * No cursor, deliberately. Every signal latches on first sight, so re-reading
 * the same buffer is idempotent and the alternative — remembering a sequence
 * number across spawns — would be state to get wrong for no gain.
 */
function startDmesgPolling(): void {
    mode = 'dmesg';
    void scanDmesg();
    if (mode !== 'dmesg') return; // latched on the first scan
    pollTimer = setInterval(() => void scanDmesg(), options.dmesgPollMs ?? DMESG_POLL_INTERVAL_MS);
    pollTimer.unref?.();
}

async function scanDmesg(): Promise<void> {
    let out: string;
    try {
        out = await (options.readDmesg ?? runDmesg)();
    } catch (err) {
        // No dmesg, or it is restricted too. Nothing more to try: the watch stays
        // armed in case a later poll succeeds (a container gaining the capability
        // is far-fetched, but a poll that costs one failed spawn is cheaper than
        // reasoning about when to give up).
        log.debug({ err }, 'kernel log: dmesg read failed');
        return;
    }
    ingest(out, 'dmesg');
}

function runDmesg(): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('dmesg', [], { timeout: 5000, maxBuffer: DMESG_MAX_BUFFER }, (err, stdout) =>
            err ? reject(err) : resolve(stdout),
        );
    });
}

/** Feed a chunk of kernel log through the rules, line by line. */
function ingest(chunk: string, source: KernelLogSource): void {
    const lines = (carry + chunk).split('\n');
    // A chunk that did not end on a newline leaves a partial line behind. Real
    // /dev/kmsg records always do, so this only ever carries on a plain file.
    carry = lines.pop() ?? '';
    for (const raw of lines) {
        const line = kmsgMessageText(raw);
        if (!line) continue;
        const signal = matchKernelLogSignal(line);
        if (signal) emitSignal(signal, line, source);
    }
}

function emitSignal(signal: KernelLogSignalId, line: string, source: KernelLogSource): void {
    if (latched.has(signal)) return;
    const event: KernelLogSignalEvent = { signal, line, source };
    latched.set(signal, event);
    log.error({ signal, source, line }, `Kernel log signal: ${line}`);
    emitter.emit(signal, event);
    // Nothing left to learn from the kernel log — stop reading it. A signal is
    // a permanent condition, so this is the end of the watch, not a pause.
    if (KERNEL_LOG_SIGNALS.every((id) => latched.has(id))) stopKernelLogWatch();
}

/** Test hook: stop the watch and forget every latched signal and subscriber. */
export function resetKernelLogWatch(): void {
    stopKernelLogWatch();
    latched.clear();
    emitter.removeAllListeners();
    options = {};
}

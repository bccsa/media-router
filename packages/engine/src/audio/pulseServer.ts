import { join } from 'node:path';

// With no server named, libpulse starts a PulseAudio daemon of its own (`pulseaudio --start`)
// when none answers; a set PULSE_SERVER turns that autospawn off (libpulse client-conf.c, B-199).

/** The per-user socket libpulse tries first, where pipewire-pulse listens. */
export function pulseServerAddress(env: NodeJS.ProcessEnv, uid = process.getuid?.() ?? 0): string {
    const dir = env.PULSE_RUNTIME_PATH || join(env.XDG_RUNTIME_DIR || `/run/user/${uid}`, 'pulse');
    return `unix:${join(dir, 'native')}`;
}

/** Names that socket in `env` unless a server is named already. Every pactl and runner the
 *  engine starts copies `process.env` (the default), so none of them can start a daemon. */
export function pinPulseServer(env: NodeJS.ProcessEnv = process.env): void {
    if (!env.PULSE_SERVER) env.PULSE_SERVER = pulseServerAddress(env);
}

/**
 * `pactl list sinks` / `pactl list sources` from 10.37.7.24 (Pi 5, PipeWire
 * 1.6.3) with two Shure MVX2U attached, 2026-10-04. Node names, the sinks'
 * Description / api.alsa.card / device.bus_path and every device.serial are
 * verbatim from the box (mic descriptions from its pw-dump); the other lines
 * follow pactl's layout.
 */
export const MVX2U_UNITS = [
    { card: 2, hash: 'efece7ff193b505fbe969dc2c1c535bf', port: 'platform-xhci-hcd.1-usb-0:1:1.1' },
    { card: 3, hash: 'c7555f279c87c75188277333d4fadb32', port: 'platform-xhci-hcd.0-usb-0:1:1.1' },
] as const;

type Unit = (typeof MVX2U_UNITS)[number];

const node = (u: Unit) => `usb-Shure_Inc_Shure_MVX2U_MVX2U_3-${u.hash}-01`;
export const MVX2U_SINK_NAMES = MVX2U_UNITS.map((u) => `alsa_output.${node(u)}.analog-stereo`);
export const MVX2U_MIC_NAMES = MVX2U_UNITS.map((u) => `alsa_input.${node(u)}.mono-fallback`);

/** The card properties pipewire-pulse folds into every sink and source of a unit. */
const cardProps = (u: Unit) => [
    '\tProperties:',
    `\t\talsa.card = "${u.card}"`,
    `\t\tapi.alsa.card = "${u.card}"`,
    '\t\tdevice.bus = "usb"',
    `\t\tdevice.bus-id = "usb-Shure_Inc_Shure_MVX2U_MVX2U#3-${u.hash}-01"`,
    `\t\tdevice.bus_path = "${u.port}"`,
    '\t\tdevice.description = "Shure MVX2U"',
    `\t\tdevice.serial = "Shure_Inc_Shure_MVX2U_MVX2U#3-${u.hash}"`,
];

const block = (head: string, name: string, desc: string, mono: boolean, props: string[] = []) =>
    [
        head,
        '\tState: SUSPENDED',
        `\tName: ${name}`,
        `\tDescription: ${desc}`,
        '\tDriver: PipeWire',
        mono
            ? '\tSample Specification: s16le 1ch 48000Hz'
            : '\tSample Specification: s24le 2ch 48000Hz',
        mono ? '\tChannel Map: mono' : '\tChannel Map: front-left,front-right',
        '\tMute: no',
        ...props,
    ].join('\n');

/** A Media Router null-sink or its monitor: no card behind it, so no card properties. */
const mrPw = (head: string, name: string) => block(head, name, name, false);

export const PACTL_SINKS = [
    ...MVX2U_UNITS.map((u, i) =>
        block(`Sink #${2759 + 229 * i}`, MVX2U_SINK_NAMES[i], 'Shure MVX2U Analog Stereo', false, [
            ...cardProps(u),
            `\t\tnode.name = "${MVX2U_SINK_NAMES[i]}"`,
        ]),
    ),
    mrPw('Sink #3169', 'MR_PW_audio-decoder-mur0flzrqh5c'),
    mrPw('Sink #3346', 'MR_PW_audio-output-mur0lln4jh3r'),
].join('\n\n');

export const PACTL_SOURCES = [
    ...MVX2U_UNITS.flatMap((u, i) => [
        block(
            `Source #${2760 + 229 * i}`,
            `${MVX2U_SINK_NAMES[i]}.monitor`,
            'Monitor of Shure MVX2U Analog Stereo',
            false,
            [...cardProps(u), '\t\tdevice.class = "monitor"'],
        ),
        block(`Source #${2761 + 229 * i}`, MVX2U_MIC_NAMES[i], 'Shure MVX2U Mono', true, [
            ...cardProps(u),
            `\t\tnode.name = "${MVX2U_MIC_NAMES[i]}"`,
        ]),
    ]),
    mrPw('Source #3170', 'MR_PW_audio-decoder-mur0flzrqh5c.monitor'),
    mrPw('Source #3347', 'MR_PW_audio-output-mur0lln4jh3r.monitor'),
].join('\n\n');

/** A `PaCommandQueue` stand-in that answers `pactl list sources|sinks` with this listing. */
export const pactlTwinQueue = () => ({
    execImmediate: (args: string[]) => (args[1] === 'sources' ? PACTL_SOURCES : PACTL_SINKS),
    onMutation: null as (() => void) | null,
});

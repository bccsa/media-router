import type { PortInfo } from '@/stores/engines';

/**
 * Compact one-value pin label, by priority:
 *   in-band/operator name (KLV) → ISO 639 language → decimal PID.
 * Ports without `streamInfo` (plain role pins like "MPEG-TS In") keep their
 * full label. The codec never rides in the text — it renders as a chip
 * (`codecChip`) so the label stays one short value.
 */
export function compactPortLabel(port: Pick<PortInfo, 'id' | 'label' | 'streamInfo'>): string {
    const si = port.streamInfo;
    const name = si?.name?.trim();
    if (name) return name;
    if (si?.language) return si.language;
    if (si?.pid !== undefined) return String(si.pid);
    return port.label || port.id;
}

export interface CodecChip {
    text: string;
    /** Tailwind classes for the chip — tinted by media type. */
    classes: string;
}

const MEDIA_CHIP_CLASSES: Record<string, string> = {
    video: 'bg-violet-500/15 text-violet-400',
    audio: 'bg-emerald-500/15 text-emerald-400',
    subtitle: 'bg-sky-500/15 text-sky-400',
};
const DEFAULT_CHIP_CLASSES = 'bg-white/10 text-muted';

/** Space-saving codec chip for a port, or null when the codec is unknown. */
export function codecChip(
    port: Pick<PortInfo, 'streamInfo'>,
): CodecChip | null {
    const codec = port.streamInfo?.codec?.trim();
    if (!codec) return null;
    return {
        text: codec,
        classes: MEDIA_CHIP_CLASSES[port.streamInfo?.media ?? ''] ?? DEFAULT_CHIP_CLASSES,
    };
}

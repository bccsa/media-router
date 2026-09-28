const EDITABLE_SELECTOR =
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Vue Flow pan-activation key filter: Space, but never pressed in an editable field.
 * The default "Space" filter swallows Shift+Space in inputs page-wide (#728).
 * Keyup always matches so a pan started on the canvas can't get stuck on.
 */
export function panActivationKey(e: KeyboardEvent): boolean {
    if (e.code !== 'Space' && e.key !== ' ') return false;
    if (e.type === 'keyup') return true;
    return !(e.target as Element | null)?.closest?.(EDITABLE_SELECTOR);
}

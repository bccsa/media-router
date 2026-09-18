/**
 * Heading for a schema-driven settings field.
 *
 * JSON Schema `title` wins when the plugin sets one; otherwise the camelCase
 * key is split into words (`playoutOffsetMs` → "Playout Offset Ms"). Shared by
 * the settings form, array-item fields and the module context menu so a field
 * is named the same everywhere.
 */
function humanizeKey(key: string): string {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

export function fieldLabel(key: string, prop?: { title?: unknown }): string {
    const title = prop?.title;
    return typeof title === 'string' && title.trim() ? title : humanizeKey(key);
}

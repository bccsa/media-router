/** The manifest fields a module node carries (the manager and every router overlay the same). */
export interface ModuleManifestLike {
    ports?: unknown[];
    configSchema?: unknown;
    color?: unknown;
    icon?: unknown;
    statusSections?: unknown;
    faceWidgets?: unknown;
    interlock?: unknown;
    resizable?: unknown;
    uploads?: unknown;
}

/**
 * Stamp a plugin's manifest fields onto a module value, in place. `schema` is
 * the host's effective schema when known (issue #661).
 */
export function overlayManifest(mod: Record<string, unknown>, manifest: ModuleManifestLike, schema?: unknown): void {
    if ((manifest.ports ?? []).length > 0) mod.ports = manifest.ports;
    mod.configSchema = schema ?? manifest.configSchema ?? {};
    mod.color = manifest.color;
    mod.icon = manifest.icon;
    mod.statusSections = manifest.statusSections;
    mod.faceWidgets = manifest.faceWidgets;
    mod.interlock = manifest.interlock === true;
    mod.resizable = manifest.resizable ?? false;
    mod.uploads = manifest.uploads;
}

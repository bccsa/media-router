export function newModuleInstanceId(pluginId: string): string {
    return `${pluginId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newInterlockId(): string {
    return `ilk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

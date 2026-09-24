import type { ModuleState } from '@/stores/engines';
import type { MenuItem } from '@/components/common/MrContextMenu.vue';
import { matchShowWhen } from '@/utils/showWhen';
import { fieldLabel } from '@/utils/fieldLabel';

// SVG icon paths (stroke-based, 24×24 viewBox)
export const menuIcons = {
    editLabel:
        '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    channelMap:
        '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
    restart:
        '<polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />',
    settings:
        '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    clone: '<rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />',
    disable: '<circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />',
    enable: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />',
    focus: '<circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />',
    delete: '<polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />',
};

const icons = menuIcons;
const divider: MenuItem = { label: '', action: '', divider: true };

/** Inline sliders/toggles for configSchema fields marked `x-contextMenu`. */
function contextSettingItems(mod: ModuleState): MenuItem[] {
    const items: MenuItem[] = [];
    const props = ((mod.configSchema as any)?.properties ?? {}) as Record<string, any>;
    for (const [key, schema] of Object.entries(props)) {
        if (!schema['x-contextMenu']) continue;
        if (!matchShowWhen(schema['x-showWhen'] as string | undefined, (k) => mod.settings?.[k]))
            continue;
        if (schema.type === 'boolean') {
            items.push({
                label: fieldLabel(key, schema),
                action: `setting:${key}`,
                toggle: { value: !!(mod.settings?.[key] ?? schema.default ?? false) },
            });
        } else if (schema['x-widget'] === 'slider' || schema.type === 'number') {
            const maxFrom = schema['x-maxFrom'];
            const maxVal =
                maxFrom && mod.settings?.[maxFrom] != null
                    ? Number(mod.settings[maxFrom])
                    : (schema.maximum ?? 100);
            items.push({
                label: fieldLabel(key, schema),
                action: `setting:${key}`,
                slider: {
                    min: schema.minimum ?? 0,
                    max: maxVal,
                    step: schema['x-step'] ?? 1,
                    value: Number(mod.settings?.[key] ?? schema.default ?? 0),
                    unit: schema['x-unit'] as string | undefined,
                },
            });
        }
    }
    return items;
}

/** Right-click menu for one module. */
export function buildModuleMenuItems(mod: ModuleState | undefined, isFocused: boolean): MenuItem[] {
    const isEnabled = mod?.enabled !== false;
    const items: MenuItem[] = [];
    const settings = mod ? contextSettingItems(mod) : [];
    if (settings.length > 0) items.push(...settings, divider);
    items.push(
        {
            label: 'Restart',
            action: 'restart',
            icon: icons.restart,
            tooltip: 'Stop and restart the module pipeline',
        },
        {
            label: 'Settings',
            action: 'settings',
            icon: icons.settings,
            tooltip: 'Open module configuration panel',
        },
        {
            label: 'Clone',
            action: 'clone',
            icon: icons.clone,
            tooltip: 'Create a copy of this module with the same settings',
        },
        divider,
        isEnabled
            ? {
                  label: 'Disable',
                  action: 'disable',
                  icon: icons.disable,
                  tooltip: 'Stop the module and disconnect all links',
              }
            : {
                  label: 'Enable',
                  action: 'enable',
                  icon: icons.enable,
                  tooltip: 'Start the module and reconnect links',
              },
        divider,
        isFocused
            ? {
                  label: 'Default',
                  action: 'unfocus',
                  icon: icons.focus,
                  tooltip: 'Remove from focus group',
              }
            : {
                  label: 'Focus',
                  action: 'focus',
                  icon: icons.focus,
                  tooltip: 'Highlight this module in focus mode',
              },
        divider,
        {
            label: 'Delete',
            action: 'delete',
            danger: true,
            icon: icons.delete,
            tooltip: 'Permanently remove this module and its connections',
        },
    );
    return items;
}

/** Right-click menu for a multi-selection (2+ modules). */
export function buildGroupMenuItems(mods: ModuleState[], allFocused: boolean): MenuItem[] {
    const n = mods.length;
    return [
        { label: `${n} modules selected`, action: '', disabled: true },
        divider,
        {
            label: 'Restart all',
            action: 'restart',
            icon: icons.restart,
            tooltip: 'Stop and restart every selected module',
        },
        divider,
        {
            label: 'Enable all',
            action: 'enable',
            icon: icons.enable,
            disabled: mods.every((m) => m.enabled !== false),
            tooltip: 'Start every selected module',
        },
        {
            label: 'Disable all',
            action: 'disable',
            icon: icons.disable,
            disabled: mods.every((m) => m.enabled === false),
            tooltip: 'Stop every selected module and disconnect its links',
        },
        divider,
        allFocused
            ? {
                  label: 'Default all',
                  action: 'unfocus',
                  icon: icons.focus,
                  tooltip: 'Remove every selected module from the focus group',
              }
            : {
                  label: 'Focus all',
                  action: 'focus',
                  icon: icons.focus,
                  tooltip: 'Add every selected module to the focus group',
              },
        divider,
        {
            label: `Delete ${n} modules`,
            action: 'delete',
            danger: true,
            icon: icons.delete,
            tooltip: 'Permanently remove the selected modules and their connections',
        },
    ];
}

/** Right-click / click menu for one connection. */
export function buildEdgeMenuItems(isAudio: boolean): MenuItem[] {
    const items: MenuItem[] = [
        {
            label: 'Edit Label',
            action: 'editLabel',
            icon: icons.editLabel,
            tooltip: 'Add or edit a text label on this connection',
        },
    ];
    if (isAudio) {
        items.push({
            label: 'Channel Map',
            action: 'channelMap',
            icon: icons.channelMap,
            tooltip: 'Configure per-channel audio routing between modules',
        });
    }
    items.push(divider, {
        label: 'Delete Connection',
        action: 'delete',
        danger: true,
        icon: icons.delete,
        tooltip: 'Remove this connection',
    });
    return items;
}

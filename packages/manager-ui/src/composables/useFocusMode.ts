import { ref, computed, watch, provide, type Ref, type ComputedRef } from 'vue';
import type { EngineState, ModuleState } from '@/stores/engines';
import { patch } from '@/composables/usePatch';

export interface FocusModeReturn {
    /** Whether focus mode is active (toolbar toggle) */
    focusMode: Ref<boolean>;
    /** Set of module IDs that are marked as focused */
    focusedModules: ComputedRef<Set<string>>;
    /** Toggle focus on a module (persists to server) */
    setModuleFocused: (engineId: string, moduleId: string, focused: boolean) => void;
    /** Check if a module should be dimmed */
    isModuleDimmed: (moduleId: string) => boolean;
    /** Check if an edge should be dimmed (both endpoints must be focused) */
    isEdgeDimmed: (sourceModuleId: string, sinkModuleId: string) => boolean;
    /** Inject focus state for child components (ModuleNode) */
    provideToChildren: () => void;
}

export function useFocusMode(engine: ComputedRef<EngineState | undefined>): FocusModeReturn {
    const focusMode = ref(false);

    const focusedModules = computed(() => {
        const modules = engine.value?.modules;
        if (!modules) return new Set<string>();
        const set = new Set<string>();
        for (const [id, mod] of Object.entries(modules)) {
            if (mod.focused) set.add(id);
        }
        return set;
    });

    // Auto-disable focus mode when no modules are focused
    watch(focusedModules, (set) => {
        if (focusMode.value && set.size === 0) focusMode.value = false;
    });

    function setModuleFocused(engineId: string, moduleId: string, focused: boolean) {
        patch.moduleField(engineId, moduleId, 'focused', focused);
    }

    function isModuleDimmed(moduleId: string): boolean {
        return (
            focusMode.value && focusedModules.value.size > 0 && !focusedModules.value.has(moduleId)
        );
    }

    function isEdgeDimmed(sourceModuleId: string, sinkModuleId: string): boolean {
        if (!focusMode.value || focusedModules.value.size === 0) return false;
        return !focusedModules.value.has(sourceModuleId) || !focusedModules.value.has(sinkModuleId);
    }

    function provideToChildren() {
        provide('focusMode', focusMode);
        provide('focusedModules', focusedModules);
    }

    return {
        focusMode,
        focusedModules,
        setModuleFocused,
        isModuleDimmed,
        isEdgeDimmed,
        provideToChildren,
    };
}

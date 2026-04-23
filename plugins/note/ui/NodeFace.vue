<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAutoFitText } from './useAutoFitText';

interface NoteModule {
    instanceId: string;
    settings?: Record<string, unknown>;
}

const props = defineProps<{ module: NoteModule }>();

const containerRef = ref<HTMLElement | null>(null);
const noteText = computed(() => {
    const raw = props.module.settings?.note;
    return typeof raw === 'string' ? raw : '';
});

// Auto-fit: text fills the card. Because the card is user-resizable (see
// manifest `resizable`), the user controls text size by dragging the grip.
// Large max lets short notes scale up with a big card; long notes shrink
// until they fit. Keeps the "drag = text size" mental model.
useAutoFitText(containerRef, noteText, { min: 9, max: 96 });
</script>

<template>
    <div class="note-face">
        <div ref="containerRef" class="note-box" :class="noteText ? 'has-text' : 'empty'">
            <div v-if="noteText" class="note-inner">{{ noteText }}</div>
            <div v-else class="note-empty">(empty — edit in settings)</div>
        </div>
    </div>
</template>

<style scoped>
/* Face fills the wrapper slot that ModuleNode gives us (flex column, bounded
 * height when the card is resizable). That's what lets useAutoFitText see a
 * real container and shrink the text when it doesn't fit. */
.note-face {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    padding: 6px 10px 10px;
}
.note-box {
    position: relative;
    flex: 1 1 auto;
    min-height: 60px;
    width: 100%;
    padding: 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
}
.note-inner {
    width: 100%;
    text-align: center;
    font-weight: 400;
    line-height: 1.3;
    /* One shade darker than full white — blend a bit of card background in. */
    color: color-mix(in srgb, var(--text-primary) 82%, var(--bg-card));
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
}
.note-empty {
    font-size: 10px;
    font-style: italic;
    color: var(--text-muted);
}
</style>

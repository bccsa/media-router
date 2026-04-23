<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAutoFitText } from './useAutoFitText';

interface NoteModule {
    instanceId: string;
    displayName: string;
    health: string;
    settings?: Record<string, unknown>;
}

const props = defineProps<{ module: NoteModule }>();

const boxRef = ref<HTMLElement | null>(null);
const noteText = computed(() => {
    const raw = props.module.settings?.note;
    return typeof raw === 'string' ? raw : '';
});

// Vertical writing-mode doesn't change how scrollWidth/scrollHeight report —
// still the laid-out content box. Text auto-scales to fill the strip; on a
// tall tablet LCP a short note may run very large, which is intentional
// (the LCP is glance-readable, big text is a feature).
useAutoFitText(boxRef, noteText, { min: 10, max: 120 });
</script>

<template>
    <div class="note-strip">
        <div class="strip-header">
            <div class="health-dot" :class="module.health === 'ok' ? 'ok' : 'stopped'" />
            <div class="module-name">{{ module.displayName }}</div>
        </div>
        <div ref="boxRef" class="note-body">
            <div v-if="noteText" class="note-text">{{ noteText }}</div>
            <div v-else class="note-placeholder">(empty)</div>
        </div>
    </div>
</template>

<style scoped>
.note-strip {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 120px;
    flex-shrink: 0;
    height: 100%;
    padding: 8px 4px;
    background: var(--bg-card, #232735);
    border-radius: 8px;
    border: 1px solid var(--border-primary, #2d3348);
    gap: 4px;
}
.strip-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 0 4px;
    min-height: 24px;
}
.health-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}
.health-dot.ok {
    background: var(--accent, #10b981);
}
.health-dot.stopped {
    background: var(--text-muted, #6b7280);
}
.module-name {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
    width: 100%;
}
.note-body {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    overflow: hidden;
    /* Generous top/bottom padding — the vertical writing-mode means "height"
     * is how tall the text column runs, so padding here directly constrains
     * how long a line can be before the fit algorithm has to shrink the
     * font. Without this the text runs edge-to-edge and only starts to
     * shrink once the container genuinely overflows. */
    padding: 60px 4px;
}
.note-text {
    /* Vertical text: bottom-up, like a mixing-console label. Font size set
     * imperatively by fit() so the text auto-scales. Longer notes wrap into
     * more vertical columns (writing-mode makes the "line" axis vertical and
     * the "block" axis horizontal, so pre-wrap wraps across columns). */
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-weight: 400;
    /* One shade darker than full white — blend a bit of card background in. */
    color: color-mix(in srgb, var(--text-primary) 82%, var(--bg-card));
    line-height: 1.3;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
    text-align: center;
    max-height: 100%;
    max-width: 100%;
    letter-spacing: 0.02em;
}
.note-placeholder {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 14px;
    font-style: italic;
    color: var(--text-muted, #6b7280);
}
@media (orientation: landscape) and (max-height: 500px) {
    .note-strip {
        width: 96px;
        padding: 4px;
    }
    .module-name {
        font-size: 14px;
    }
    .note-placeholder {
        font-size: 12px;
    }
}
</style>

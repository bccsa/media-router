<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';

const props = defineProps<{
    /** Array of dB levels per channel (e.g. [-12, -18]) */
    levels: number[];
    /** Orientation: 'horizontal' (default) or 'vertical' */
    orientation?: 'horizontal' | 'vertical';
    /** Number of discrete blocks */
    numBlocks?: number;
    /** Gap between blocks in pixels */
    blockGap?: number;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let prevBlocks: number[] = [];
let animFrame = 0;

const NUM_BLOCKS = props.numBlocks ?? 15;
const BLOCK_GAP = props.blockGap ?? 2;

// Color thresholds (block index based)
const GREEN_LIMIT = 10;  // blocks 0-9: green
const YELLOW_LIMIT = 13; // blocks 10-12: yellow/orange
// blocks 13-14: red

function getBlockColor(i: number): string {
    if (i < GREEN_LIMIT) return '#22c55e';   // green
    if (i < YELLOW_LIMIT) return '#eab308';  // yellow
    return '#ef4444';                          // red
}

/**
 * Convert level to number of lit blocks.
 * Input is already 0-15 block scale (converted by gst-runner using v1 formula:
 * Math.round(0.25 * (60 + dB)), clamped at -60dB).
 */
function toBlocks(level: number): number {
    return Math.min(Math.max(Math.round(level), 0), NUM_BLOCKS);
}

function paint() {
    if (!ctx || !canvasRef.value) return;

    const canvas = canvasRef.value;
    const w = canvas.width;
    const h = canvas.height;
    const channels = props.levels.length || 1;
    const isHorizontal = (props.orientation ?? 'horizontal') === 'horizontal';

    let needsRedraw = false;
    const currentBlocks = props.levels.map(toBlocks);

    // Only redraw if block counts changed
    if (currentBlocks.length !== prevBlocks.length) {
        needsRedraw = true;
    } else {
        for (let i = 0; i < currentBlocks.length; i++) {
            if (currentBlocks[i] !== prevBlocks[i]) {
                needsRedraw = true;
                break;
            }
        }
    }

    if (!needsRedraw) return;
    prevBlocks = [...currentBlocks];

    ctx.clearRect(0, 0, w, h);

    if (isHorizontal) {
        const blockWidth = (w - (NUM_BLOCKS - 1) * BLOCK_GAP) / NUM_BLOCKS;
        const chHeight = h / channels;

        for (let ch = 0; ch < channels; ch++) {
            const numFilled = currentBlocks[ch] ?? 0;
            const top = ch * chHeight;

            for (let i = 0; i < NUM_BLOCKS; i++) {
                const left = i * (blockWidth + BLOCK_GAP);
                if (i < numFilled) {
                    ctx.fillStyle = getBlockColor(i);
                    ctx.fillRect(left, top + 1, blockWidth, chHeight - 2);
                } else {
                    // Dim unfilled blocks (works on both light and dark backgrounds)
                    ctx.fillStyle = 'rgba(128,128,128,0.15)';
                    ctx.fillRect(left, top + 1, blockWidth, chHeight - 2);
                }
            }
        }
    } else {
        // Vertical: blocks go bottom to top
        const blockHeight = (h - (NUM_BLOCKS - 1) * BLOCK_GAP) / NUM_BLOCKS;
        const chWidth = w / channels;

        for (let ch = 0; ch < channels; ch++) {
            const numFilled = currentBlocks[ch] ?? 0;
            const left = ch * chWidth;

            for (let i = 0; i < NUM_BLOCKS; i++) {
                const top = h - (i + 1) * (blockHeight + BLOCK_GAP);
                if (i < numFilled) {
                    ctx.fillStyle = getBlockColor(i);
                    ctx.fillRect(left + 1, top, chWidth - 2, blockHeight);
                } else {
                    ctx.fillStyle = 'rgba(128,128,128,0.15)';
                    ctx.fillRect(left + 1, top, chWidth - 2, blockHeight);
                }
            }
        }
    }
}

let resizeObserver: ResizeObserver | null = null;

function resize() {
    if (!canvasRef.value) return;
    const parent = canvasRef.value.parentElement;
    if (parent) {
        canvasRef.value.width = parent.offsetWidth;
        canvasRef.value.height = parent.offsetHeight;
    }
    prevBlocks = []; // force repaint
    paint();
}

onMounted(() => {
    if (canvasRef.value) {
        ctx = canvasRef.value.getContext('2d');
        resizeObserver = new ResizeObserver(resize);
        if (canvasRef.value.parentElement) {
            resizeObserver.observe(canvasRef.value.parentElement);
        }
        resize();
    }
});

onUnmounted(() => {
    resizeObserver?.disconnect();
    if (animFrame) cancelAnimationFrame(animFrame);
});

// Watch levels reactively — uses requestAnimationFrame to batch
watch(() => props.levels, () => {
    if (animFrame) return; // already scheduled
    animFrame = requestAnimationFrame(() => {
        animFrame = 0;
        paint();
    });
}, { deep: true });
</script>

<template>
    <canvas ref="canvasRef" style="display: block; width: 100%; height: 100%; border-radius: 2px;" />
</template>

/** VU levels: per channel 0–VU_BLOCKS blocks, round((dBFS + 60) / 4); VU_BLOCKS ≈ 0 dBFS. */
export const VU_BLOCKS = 15;

/** The level, in dBFS, a VU block stands for. */
export const vuBlockDbfs = (block: number): number => block * 4 - 60;

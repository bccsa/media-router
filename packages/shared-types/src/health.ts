/** Overall module health for the state icon. */
export const MODULE_HEALTH = ['ok', 'warning', 'error', 'stopped'] as const;
export type ModuleHealth = (typeof MODULE_HEALTH)[number];

import { inject, type InjectionKey, type Ref } from 'vue';

// What a dashboard provides to its widgets.

/** Ask the dashboard's popup a yes/no question; resolves true on Yes. */
export type Ask = (question: string, detail?: string) => Promise<boolean>;
export const ASK: InjectionKey<Ask> = Symbol('dashboard-ask');

/** The dashboard's theme, for widgets that must keep text readable. */
export const THEME: InjectionKey<Ref<'dark' | 'light'>> = Symbol('dashboard-theme');

export function useTheme(): Ref<'dark' | 'light'> | undefined {
    return inject(THEME, undefined);
}

/** The shown dashboard's id: where its buttons' scripts run (ADR-0027). */
export const DASHBOARD_ID: InjectionKey<Ref<string | undefined>> = Symbol('dashboard-id');

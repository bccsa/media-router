import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useThemeStore = defineStore('theme', () => {
    const isDark = ref(localStorage.getItem('theme') !== 'light');

    function apply() {
        document.documentElement.classList.toggle('dark', isDark.value);
    }

    function toggle() {
        isDark.value = !isDark.value;
        localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
        apply();
    }

    // Apply on init
    apply();

    return { isDark, toggle };
});

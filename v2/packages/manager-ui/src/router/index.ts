import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/', redirect: '/engines' },
        {
            path: '/engines',
            name: 'engines',
            component: () => import('@/views/EnginesView.vue'),
        },
        {
            path: '/engines/:engineId',
            name: 'engine-detail',
            component: () => import('@/views/EngineDetailView.vue'),
            props: true,
        },
        {
            path: '/routing/:engineId',
            name: 'routing',
            component: () => import('@/views/RoutingView.vue'),
            props: true,
        },
        {
            path: '/profiles/:engineId',
            name: 'profiles',
            component: () => import('@/views/ProfilesView.vue'),
            props: true,
        },
        {
            path: '/settings',
            name: 'settings',
            component: () => import('@/views/SettingsView.vue'),
        },
    ],
});

export default router;

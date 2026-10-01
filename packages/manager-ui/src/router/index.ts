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
            path: '/engines/:engineId/dashboards',
            name: 'router-dashboards',
            component: () => import('@/views/RouterDashboardsView.vue'),
            props: true,
        },
        {
            path: '/engines/:engineId/dashboards/:dashboardId',
            name: 'router-dashboard',
            component: () => import('@/views/DashboardPage.vue'),
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
            path: '/dashboards',
            name: 'manager-dashboards',
            component: () => import('@/views/ManagerDashboardsView.vue'),
        },
        {
            path: '/dashboards/:dashboardId',
            name: 'manager-dashboard',
            component: () => import('@/views/DashboardPage.vue'),
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

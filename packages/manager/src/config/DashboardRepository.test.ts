import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { newDashboard } from '@media-router/shared-types';
import { applySchema } from './ConfigSchema.js';
import { ConfigHistoryRepository } from './ConfigHistoryRepository.js';
import { DASHBOARD_HISTORY_OWNER, DashboardRepository } from './DashboardRepository.js';

describe('DashboardRepository', () => {
    let db: Database.Database;
    let repo: DashboardRepository;
    let history: ConfigHistoryRepository;

    beforeEach(() => {
        db = new Database(':memory:');
        applySchema(db);
        history = new ConfigHistoryRepository(db);
        repo = new DashboardRepository(db, history);
    });

    it('stores, updates and deletes a dashboard with its history', () => {
        repo.put('d1', newDashboard('Desk'));
        expect(repo.get('d1')?.name).toBe('Desk');
        repo.put('d1', { ...newDashboard('Desk 2'), rev: 2 });
        expect(repo.all()).toEqual({ d1: { ...newDashboard('Desk 2'), rev: 2 } });
        expect(history.list(DASHBOARD_HISTORY_OWNER, 'd1').length).toBeGreaterThan(0);
        repo.delete('d1');
        expect(repo.get('d1')).toBeUndefined();
        expect(history.list(DASHBOARD_HISTORY_OWNER, 'd1')).toEqual([]);
    });

    it('leaves out a row that is corrupt or not a valid dashboard', () => {
        repo.put('ok', newDashboard('Desk'));
        const insert = db.prepare('INSERT INTO manager_dashboards (id, config) VALUES (?, ?)');
        insert.run('corrupt', '{not json');
        insert.run('invalid', JSON.stringify({ name: '', widgets: 'x' }));
        expect(Object.keys(repo.all())).toEqual(['ok']);
    });

    it('reads a row again once it changes', () => {
        repo.put('d1', newDashboard('Desk'));
        expect(repo.get('d1')?.name).toBe('Desk');
        db.prepare('UPDATE manager_dashboards SET config = ? WHERE id = ?').run(JSON.stringify(newDashboard('Hand edited')), 'd1');
        expect(repo.get('d1')?.name).toBe('Hand edited');
    });
});

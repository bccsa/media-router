import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ManagerConnectionProfile } from '@media-router/shared-types';

/**
 * Simple file-based profile storage.
 * Profiles are stored as JSON at ~/.media-router/profiles.json
 */
export class ProfileStore {
    private filePath: string;
    private profiles: Record<string, ManagerConnectionProfile> = {};
    private activeProfile: string | null = null;

    constructor(filePath?: string) {
        const configDir = filePath
            ? path.dirname(filePath)
            : path.join(os.homedir(), '.media-router');

        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        this.filePath = filePath ?? path.join(configDir, 'profiles.json');
        this.loadFromDisk();
    }

    private loadFromDisk(): void {
        if (fs.existsSync(this.filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                this.profiles = data.profiles ?? {};
                this.activeProfile = data.active ?? null;
            } catch {
                this.profiles = {};
                this.activeProfile = null;
            }
        }
    }

    private saveToDisk(): void {
        fs.writeFileSync(
            this.filePath,
            JSON.stringify({ profiles: this.profiles, active: this.activeProfile }, null, 4),
        );
    }

    /** Get all profiles with active flag. */
    getAll(): Array<ManagerConnectionProfile & { active: boolean }> {
        return Object.values(this.profiles).map((p) => ({
            ...p,
            active: p.name === this.activeProfile,
        }));
    }

    /** Get a single profile by name. */
    get(name: string): (ManagerConnectionProfile & { active: boolean }) | null {
        const profile = this.profiles[name];
        if (!profile) return null;
        return { ...profile, active: profile.name === this.activeProfile };
    }

    /** Create a new profile. */
    create(profile: ManagerConnectionProfile): void {
        this.profiles[profile.name] = profile;
        this.saveToDisk();
    }

    /** Update an existing profile. */
    update(name: string, changes: Record<string, unknown>): void {
        const existing = this.profiles[name];
        if (!existing) throw new Error(`Profile not found: ${name}`);
        Object.assign(existing, changes);
        this.saveToDisk();
    }

    /** Delete a profile. */
    delete(name: string): void {
        delete this.profiles[name];
        if (this.activeProfile === name) {
            this.activeProfile = null;
        }
        this.saveToDisk();
    }

    /** Set a profile as active. */
    activate(name: string): void {
        if (!this.profiles[name]) throw new Error(`Profile not found: ${name}`);
        this.activeProfile = name;
        this.saveToDisk();
    }

    /** Get the currently active profile, or null. */
    getActive(): ManagerConnectionProfile | null {
        if (!this.activeProfile) return null;
        return this.profiles[this.activeProfile] ?? null;
    }
}

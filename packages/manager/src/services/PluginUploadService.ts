import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@media-router/shared-types';
import type { PluginRegistry } from '../plugins/PluginRegistry.js';

const log = createLogger('PluginUploadService');

/**
 * Generic per-plugin file-upload backend. Plugins that need to accept user
 * files (logo images, audio cues, fallback cards, etc.) opt in by:
 *
 *   1. Marking the schema field with a widget that emits an upload —
 *      e.g. `"x-widget": "imageUpload"` — and storing the result as a
 *      string path. The widget emits to this service via `plugin:upload`
 *      and writes the returned absolute path back into the field.
 *   2. Declaring `uploads: { extensions, maxBytes }` on the manifest.
 *      This is mandatory: without it the service rejects every upload
 *      request for that plugin, so adding video support to one plugin
 *      doesn't widen the policy for any other plugin in the registry.
 *
 * Storage layout: `<root>/<pluginId>/<moduleId>.<ext>`. One file per module
 * — re-uploading overwrites; switching extension on re-upload deletes the
 * prior file so we don't accumulate orphans.
 *
 * Single-host note: the file lands on whichever host the *manager* runs on.
 * For deployments where the engine is on a different host, the engine
 * plugin still reads the absolute path baked into its config, so the file
 * has to be reachable from there. Co-located deployments (today's hosts)
 * "just work" since both processes see the same `/data` mount.
 */

const DEFAULT_UPLOAD_ROOT = '/data/media-router/uploads';

/**
 * Per-plugin upload policy is sourced exclusively from each plugin's manifest
 * (`uploads: { extensions, maxBytes }`). The service holds no built-in
 * allowlist — a plugin without an `uploads` block on its manifest simply
 * can't upload. Keeps the service plugin-agnostic and lets a video plugin
 * accept `.mp4` without widening every other plugin's whitelist.
 */

/** Used to gate IDs that go into filesystem paths. No slashes, no dots leading. */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface UploadRequest {
    pluginId: string;
    moduleId: string;
    filename: string;
    bytes: Buffer;
}

export interface UploadResult {
    /** Absolute path on the manager host. Plugins store this in their config. */
    path: string;
    /** Filename only — UI passes this back via `plugin:upload-get` to load a preview. */
    filename: string;
}

export interface UploadFetch {
    /** Raw bytes — caller renders as data URL or hands to a downstream consumer. */
    bytes: Buffer;
    /** Best-guess MIME type from the file extension; sufficient for `data:<type>;base64,…`. */
    contentType: string;
}

const EXT_MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
};

export class PluginUploadService {
    private readonly root: string;

    constructor(
        private readonly pluginRegistry: PluginRegistry,
        opts: { root?: string } = {},
    ) {
        this.root = opts.root ?? DEFAULT_UPLOAD_ROOT;
    }

    /** Subdir for a specific plugin — created lazily on first upload. */
    getPluginDir(pluginId: string): string {
        return path.join(this.root, pluginId);
    }

    /**
     * Validate, persist, and return the absolute path. Throws on:
     *   - unsafe pluginId or moduleId (filesystem traversal guards),
     *   - pluginId with no `uploads` block on its manifest,
     *   - empty body,
     *   - extension not in the plugin's declared whitelist,
     *   - body larger than the plugin's declared cap,
     *   - filesystem failure.
     */
    save(req: UploadRequest): UploadResult {
        if (!SAFE_ID_RE.test(req.pluginId)) {
            throw new Error(`unsafe pluginId: ${req.pluginId}`);
        }
        const policy = this.policyFor(req.pluginId);
        if (!policy) {
            throw new Error(
                `plugin "${req.pluginId}" has no uploads policy on its manifest`,
            );
        }
        if (!SAFE_ID_RE.test(req.moduleId)) {
            throw new Error(`unsafe moduleId: ${req.moduleId}`);
        }
        if (!req.bytes || req.bytes.length === 0) {
            throw new Error('empty body');
        }
        if (req.bytes.length > policy.maxBytes) {
            throw new Error(`body too large: ${req.bytes.length} > ${policy.maxBytes}`);
        }
        const ext = path.extname(req.filename).toLowerCase();
        if (!policy.extensions.has(ext)) {
            throw new Error(
                `unsupported extension: ${ext || '(none)'} — accepted: ${[...policy.extensions].join(', ')}`,
            );
        }

        const pluginDir = this.getPluginDir(req.pluginId);
        fs.mkdirSync(pluginDir, { recursive: true });
        const filename = `${req.moduleId}${ext}`;
        const target = path.join(pluginDir, filename);

        // Clear any previous extension for this module so png → jpg doesn't
        // leave both files around. Cheap walk over a per-plugin dir.
        try {
            for (const entry of fs.readdirSync(pluginDir)) {
                if (entry === filename) continue;
                if (entry.startsWith(`${req.moduleId}.`)) {
                    try {
                        fs.unlinkSync(path.join(pluginDir, entry));
                    } catch {
                        /* best effort */
                    }
                }
            }
        } catch {
            /* directory just created — nothing to clean */
        }

        fs.writeFileSync(target, req.bytes);
        log.info(
            { pluginId: req.pluginId, moduleId: req.moduleId, bytes: req.bytes.length },
            'Plugin upload saved',
        );
        return { path: target, filename };
    }

    /**
     * Read a previously-uploaded file back so the UI can render a preview.
     * Scoped by pluginId so a widget can't reach across plugin subdirs;
     * filename is treated as a basename only (no `..` or slashes) to keep
     * the lookup inside the per-plugin storage root.
     */
    read(pluginId: string, filename: string): UploadFetch {
        if (!SAFE_ID_RE.test(pluginId)) {
            throw new Error(`unsafe pluginId: ${pluginId}`);
        }
        if (!this.policyFor(pluginId)) {
            throw new Error(
                `plugin "${pluginId}" has no uploads policy on its manifest`,
            );
        }
        if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
            throw new Error(`unsafe filename: ${filename}`);
        }
        const target = path.join(this.getPluginDir(pluginId), filename);
        const bytes = fs.readFileSync(target);
        const ext = path.extname(filename).toLowerCase();
        const contentType = EXT_MIME[ext] ?? 'application/octet-stream';
        return { bytes, contentType };
    }

    /**
     * Resolve the per-plugin upload policy from the manifest. Returns
     * `undefined` when the plugin isn't registered or hasn't declared an
     * `uploads` block — both treated as "uploads disabled for this plugin"
     * at the call sites. Extensions are normalised to lowercase here so
     * the manifest doesn't have to.
     */
    private policyFor(
        pluginId: string,
    ): { extensions: Set<string>; maxBytes: number } | undefined {
        const manifest = this.pluginRegistry.find(pluginId) as
            | { uploads?: { extensions?: string[]; maxBytes?: number } }
            | undefined;
        const declared = manifest?.uploads;
        if (!declared || !declared.extensions || declared.extensions.length === 0) {
            return undefined;
        }
        return {
            extensions: new Set(declared.extensions.map((e) => e.toLowerCase())),
            maxBytes: declared.maxBytes ?? 10 * 1024 * 1024,
        };
    }
}

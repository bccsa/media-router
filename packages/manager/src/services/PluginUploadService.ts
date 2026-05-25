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
 *      string path. The widget POSTs / emits to this service and writes
 *      the returned absolute path back into the field.
 *   2. Optionally declaring `x-uploads` on the manifest to widen the
 *      extension whitelist or raise the size cap for that plugin
 *      (future work — defaults cover the image-upload case today).
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

/** Sensible default for the `imageUpload` widget. Widen per-plugin via manifest later. */
const DEFAULT_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
]);

/** 10 MB — generous for a "no signal" card, tight enough to fail loudly on accidents. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

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
     *   - unknown / unsafe pluginId or moduleId,
     *   - empty body,
     *   - extension not in the (per-plugin or default) whitelist,
     *   - body larger than the (per-plugin or default) cap,
     *   - filesystem failure.
     */
    save(req: UploadRequest): UploadResult {
        if (!SAFE_ID_RE.test(req.pluginId)) {
            throw new Error(`unsafe pluginId: ${req.pluginId}`);
        }
        if (!this.pluginRegistry.find(req.pluginId)) {
            throw new Error(`unknown plugin: ${req.pluginId}`);
        }
        if (!SAFE_ID_RE.test(req.moduleId)) {
            throw new Error(`unsafe moduleId: ${req.moduleId}`);
        }
        if (!req.bytes || req.bytes.length === 0) {
            throw new Error('empty body');
        }
        const { extensions, maxBytes } = this.policyFor(req.pluginId);
        if (req.bytes.length > maxBytes) {
            throw new Error(`body too large: ${req.bytes.length} > ${maxBytes}`);
        }
        const ext = path.extname(req.filename).toLowerCase();
        if (!extensions.has(ext)) {
            throw new Error(
                `unsupported extension: ${ext || '(none)'} — accepted: ${[...extensions].join(', ')}`,
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
        if (!this.pluginRegistry.find(pluginId)) {
            throw new Error(`unknown plugin: ${pluginId}`);
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
     * Per-plugin policy: future hook for manifest-driven extension lists and
     * size caps via `x-uploads` on the plugin manifest. For now the defaults
     * cover the image-upload widget; switch on the manifest when the second
     * upload widget arrives.
     */
    private policyFor(_pluginId: string): {
        extensions: Set<string>;
        maxBytes: number;
    } {
        return { extensions: DEFAULT_EXTENSIONS, maxBytes: DEFAULT_MAX_BYTES };
    }
}

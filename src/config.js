import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
export const CLIP_DIR = path.join(DATA_DIR, 'clips');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Limits
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // what we accept from Discord
export const CLIP_SECONDS = 10;                  // what we keep and play
export const COOLDOWN_SECONDS = 60;              // per member, per server
export const LOUDNESS_LUFS = -18;                 // every clip is normalized to this
export const FFMPEG_TIMEOUT_MS = 30_000;

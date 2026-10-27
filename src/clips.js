// Download an upload, cut the chosen part, normalize loudness and store it as a small Ogg Opus clip.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import {
  CLIP_DIR, MAX_UPLOAD_BYTES, CLIP_SECONDS, LOUDNESS_LUFS, FFMPEG_TIMEOUT_MS,
} from './config.js';

export class ClipError extends Error {}

export function clipPath(guildId, userId) {
  return path.join(CLIP_DIR, guildId, `${userId}.ogg`);
}

export function hasClip(guildId, userId) {
  return fs.existsSync(clipPath(guildId, userId));
}

export async function removeClip(guildId, userId) {
  try {
    await fsp.unlink(clipPath(guildId, userId));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// "83", "83.5", "1:23", "0:01:23" -> seconds
export function parseStart(text) {
  if (!text) return 0;
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    throw new ClipError('Start time should look like `45`, `1:23` or `1:23.5`.');
  }
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new ClipError(`Couldn't download the file (HTTP ${res.status}).`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) cb(new ClipError('File is larger than 8 MB.'));
      else cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), limit, fs.createWriteStream(dest));
}

async function probe(file) {
  let info;
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file',
      '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file,
    ]);
    info = JSON.parse(stdout);
  } catch {
    throw new ClipError("That doesn't look like an audio file I can read.");
  }
  if (!info.streams?.some((s) => s.codec_type === 'audio')) {
    throw new ClipError('That file has no audio in it.');
  }
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ClipError("Couldn't work out how long that file is.");
  }
  return duration;
}

// Returns the length in seconds of the stored clip.
export async function saveClip(guildId, userId, attachment, startText) {
  if (attachment.size > MAX_UPLOAD_BYTES) throw new ClipError('File is larger than 8 MB.');
  const start = parseStart(startText);

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'walkon-'));
  try {
    const input = path.join(work, 'input');
    const output = path.join(work, 'clip.ogg');
    await download(attachment.url, input);

    const duration = await probe(input);
    if (start >= duration - 0.5) {
      throw new ClipError(`The file is only ${duration.toFixed(1)} s long, so it can't start at ${start} s.`);
    }
    const length = Math.min(CLIP_SECONDS, duration - start);
    const fadeOut = Math.min(0.75, length / 4);

    const cut = ['-ss', String(start), '-t', String(length), '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn'];
    try {
      // Measure the whole cut first, then apply one fixed gain. loudnorm's own adjustment
      // rides the volume up and down during playback, which sounds like a fade on short clips.
      const { stderr } = await run('ffmpeg', [
        '-nostdin', '-hide_banner', '-protocol_whitelist', 'file', ...cut,
        '-af', `loudnorm=I=${LOUDNESS_LUFS}:print_format=json`, '-f', 'null', '-',
      ]);
      const measured = Number(JSON.parse(stderr.slice(stderr.lastIndexOf('{'))).input_i);
      const gain = Number.isFinite(measured) ? Math.max(-20, Math.min(20, LOUDNESS_LUFS - measured)) : 0;

      await run('ffmpeg', [
        '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', ...cut,
        '-af', [
          `volume=${gain.toFixed(2)}dB`,
          'alimiter=limit=0.79:attack=5:release=50:level=false', // about -2 dBFS, only catches peaks
          'afade=t=in:d=0.05',
          `afade=t=out:st=${(length - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`,
        ].join(','),
        '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k', '-f', 'ogg', output,
      ]);
    } catch (err) {
      console.error('ffmpeg failed:', err.stderr || err.message);
      throw new ClipError("Couldn't convert that file.");
    }

    const dest = clipPath(guildId, userId);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(output, dest + '.tmp');
    await fsp.rename(dest + '.tmp', dest);
    return length;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

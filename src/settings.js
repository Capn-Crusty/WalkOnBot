// Per-server settings (which role may set walk-ons), kept in one small JSON file.
import fs from 'node:fs';
import { SETTINGS_FILE } from './config.js';

let settings = { guilds: {} };

export function load() {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    settings.guilds ??= {};
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function save() {
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}

export function getRoleId(guildId) {
  return settings.guilds[guildId]?.roleId ?? null;
}

export function setRoleId(guildId, roleId) {
  settings.guilds[guildId] = { ...settings.guilds[guildId], roleId };
  save();
}

// Members who switched their own walk-on off (clip kept, not played).
export function isOff(guildId, userId) {
  return settings.guilds[guildId]?.off?.includes(userId) ?? false;
}

export function setOff(guildId, userId, off) {
  const guild = { ...settings.guilds[guildId] };
  const list = new Set(guild.off ?? []);
  if (off) list.add(userId);
  else list.delete(userId);
  guild.off = [...list];
  settings.guilds[guildId] = guild;
  save();
}

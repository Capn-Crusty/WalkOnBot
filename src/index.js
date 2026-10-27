import fs from 'node:fs';
import {
  AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, MessageFlags,
  PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { CLIP_DIR, CLIP_SECONDS, COOLDOWN_SECONDS } from './config.js';
import * as settings from './settings.js';
import { ClipError, clipPath, hasClip, removeClip, saveClip } from './clips.js';
import { enqueue } from './player.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set (put it in .env).');
  process.exit(1);
}

fs.mkdirSync(CLIP_DIR, { recursive: true });
settings.load();

const commands = [
  new SlashCommandBuilder()
    .setName('walkon')
    .setDescription('Your walk-on sound for voice channels')
    .setDMPermission(false)
    .addSubcommand((sc) => sc
      .setName('set')
      .setDescription(`Upload a sound or song (max 8 MB); ${CLIP_SECONDS} s of it is kept`)
      .addAttachmentOption((o) => o.setName('file').setDescription('Audio or video file').setRequired(true))
      .addStringOption((o) => o.setName('start').setDescription('Where to start, e.g. 45 or 1:23 (default: beginning)')))
    .addSubcommand((sc) => sc.setName('preview').setDescription('Hear your current walk-on (only you see it)'))
    .addSubcommand((sc) => sc.setName('off').setDescription("Stop your walk-on playing (it's kept)"))
    .addSubcommand((sc) => sc.setName('on').setDescription('Play your walk-on again'))
    .addSubcommand((sc) => sc.setName('clear').setDescription('Remove your walk-on'))
    .addSubcommand((sc) => sc.setName('help').setDescription('How walk-ons work and your current status')),
  new SlashCommandBuilder()
    .setName('walkon-admin')
    .setDescription('Walk-on settings for this server')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) => sc
      .setName('role')
      .setDescription('Set the role that may set walk-ons')
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('remove')
      .setDescription("Remove a member's walk-on")
      .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true)))
    .addSubcommand((sc) => sc.setName('show').setDescription('Show the current settings')),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

// Guild commands appear immediately; global ones can take an hour.
async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
  } catch (err) {
    console.error(`Couldn't register commands in ${guild.name}:`, err.message);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
  for (const guild of c.guilds.cache.values()) await registerCommands(guild);
});
client.on(Events.GuildCreate, registerCommands);

function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function mayUseWalkOn(member) {
  const roleId = settings.getRoleId(member.guild.id);
  return isAdmin(member) || (roleId !== null && member.roles.cache.has(roleId));
}

function notAllowedMessage(guildId) {
  const roleId = settings.getRoleId(guildId);
  return roleId
    ? `You need the <@&${roleId}> role to set a walk-on.`
    : 'No walk-on role is set yet. A server admin can set one with `/walkon-admin role`.';
}

const busy = new Set(); // members whose upload is being processed

async function handleWalkOn(interaction) {
  const { guildId, member, user } = interaction;
  const sub = interaction.options.getSubcommand();

  if (sub === 'clear') {
    const removed = await removeClip(guildId, user.id);
    return interaction.reply({ content: removed ? 'Walk-on removed.' : "You don't have a walk-on.", flags: MessageFlags.Ephemeral });
  }

  if (sub === 'help') {
    const roleId = settings.getRoleId(guildId);
    let status;
    if (!mayUseWalkOn(member)) status = roleId ? `You need the <@&${roleId}> role to have a walk-on.` : 'Walk-ons aren\'t open to members yet.';
    else if (!hasClip(guildId, user.id)) status = 'You can set a walk-on but haven\'t yet.';
    else status = settings.isOff(guildId, user.id) ? 'Your walk-on is saved but switched **off**.' : 'Your walk-on is **on**.';
    return interaction.reply({
      content: [
        'When you join a voice channel, the bot plays your walk-on clip there.',
        '',
        `\`/walkon set\`: upload a sound or song (up to 8 MB). ${CLIP_SECONDS} s is kept, from \`start\` if you give one (e.g. \`1:23\`).`,
        '`/walkon preview`: hear your walk-on',
        '`/walkon off` / `/walkon on`: stop or resume it without deleting it',
        '`/walkon clear`: delete it',
        '',
        `Each walk-on plays at most once every ${COOLDOWN_SECONDS} s. If several people join at once, they play in turn.`,
        `Who can set one: ${roleId ? `members with <@&${roleId}>` : 'admins only (no role set yet)'}.`,
        '',
        status,
      ].join('\n'),
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'off' || sub === 'on') {
    if (!hasClip(guildId, user.id)) {
      return interaction.reply({ content: "You don't have a walk-on yet. Use `/walkon set`.", flags: MessageFlags.Ephemeral });
    }
    settings.setOff(guildId, user.id, sub === 'off');
    return interaction.reply({
      content: sub === 'off' ? 'Walk-on off. Use `/walkon on` to turn it back on.' : 'Walk-on on.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'preview') {
    if (!hasClip(guildId, user.id)) {
      return interaction.reply({ content: "You don't have a walk-on yet. Use `/walkon set`.", flags: MessageFlags.Ephemeral });
    }
    const file = new AttachmentBuilder(clipPath(guildId, user.id), { name: 'walkon.ogg' });
    return interaction.reply({ files: [file], flags: MessageFlags.Ephemeral });
  }

  // set
  if (!mayUseWalkOn(member)) {
    return interaction.reply({ content: notAllowedMessage(guildId), flags: MessageFlags.Ephemeral });
  }
  if (busy.has(user.id)) {
    return interaction.reply({ content: 'Still working on your last upload.', flags: MessageFlags.Ephemeral });
  }
  busy.add(user.id);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const length = await saveClip(guildId, user.id, interaction.options.getAttachment('file'), interaction.options.getString('start'));
    const file = new AttachmentBuilder(clipPath(guildId, user.id), { name: 'walkon.ogg' });
    const offNote = settings.isOff(guildId, user.id) ? '\nIt\'s switched off right now. Use `/walkon on` to play it.' : '';
    await interaction.editReply({ content: `Walk-on saved (${length.toFixed(1)} s). This is what people will hear:${offNote}`, files: [file] });
  } catch (err) {
    if (!(err instanceof ClipError)) console.error('Saving clip failed:', err);
    await interaction.editReply(err instanceof ClipError ? err.message : 'Something went wrong saving that. Try another file.');
  } finally {
    busy.delete(user.id);
  }
}

async function handleAdmin(interaction) {
  const { guildId } = interaction;
  const sub = interaction.options.getSubcommand();

  if (sub === 'role') {
    const role = interaction.options.getRole('role');
    settings.setRoleId(guildId, role.id);
    return interaction.reply({ content: `Members with ${role} can now set walk-ons.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'remove') {
    const target = interaction.options.getUser('member');
    const removed = await removeClip(guildId, target.id);
    return interaction.reply({ content: removed ? `Removed ${target}'s walk-on.` : `${target} has no walk-on.`, flags: MessageFlags.Ephemeral });
  }

  // show
  const roleId = settings.getRoleId(guildId);
  const dir = `${CLIP_DIR}/${guildId}`;
  const count = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.ogg')).length : 0;
  return interaction.reply({
    content: [
      `Role: ${roleId ? `<@&${roleId}>` : 'not set (only admins can set walk-ons)'}`,
      `Walk-ons saved: ${count}`,
      `Clip length: ${CLIP_SECONDS} s · upload limit: 8 MB · cooldown: ${COOLDOWN_SECONDS} s per member`,
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  try {
    if (interaction.commandName === 'walkon') await handleWalkOn(interaction);
    else if (interaction.commandName === 'walkon-admin') await handleAdmin(interaction);
  } catch (err) {
    console.error('Command failed:', err);
    const reply = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

const lastPlayed = new Map(); // `${guildId}:${userId}` -> ms

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const { member, channel, guild } = newState;
  if (!member || member.user.bot || !channel) return;
  if (oldState.channelId === newState.channelId) return; // mute/deafen/stream changes
  if (channel.type !== ChannelType.GuildVoice) return;   // skip stage channels
  if (channel.id === guild.afkChannelId) return;
  if (!hasClip(guild.id, member.id) || settings.isOff(guild.id, member.id) || !mayUseWalkOn(member)) return;

  const me = guild.members.me;
  if (!channel.permissionsFor(me).has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) return;
  if (channel.full && !me.permissions.has(PermissionFlagsBits.MoveMembers)) return;

  const key = `${guild.id}:${member.id}`;
  const now = Date.now();
  if (now - (lastPlayed.get(key) ?? 0) < COOLDOWN_SECONDS * 1000) return;
  lastPlayed.set(key, now);

  enqueue(channel, clipPath(guild.id, member.id));
});

client.login(process.env.DISCORD_TOKEN);

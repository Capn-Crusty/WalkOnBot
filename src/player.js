// One queue per server: join the member's channel, play their clip, leave when the queue is empty.
import fs from 'node:fs';
import {
  AudioPlayerStatus, StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, entersState, getVoiceConnection, joinVoiceChannel,
} from '@discordjs/voice';
import { CLIP_SECONDS } from './config.js';

const queues = new Map(); // guildId -> [{ channel, file }]

export function enqueue(channel, file) {
  const guildId = channel.guild.id;
  if (!queues.has(guildId)) {
    queues.set(guildId, [{ channel, file }]);
    drain(guildId).catch((err) => console.error(`Playback failed in ${channel.guild.name}:`, err));
  } else {
    queues.get(guildId).push({ channel, file });
  }
}

async function drain(guildId) {
  const queue = queues.get(guildId);
  try {
    while (queue.length) {
      const { channel, file } = queue.shift();
      if (!fs.existsSync(file)) continue;
      try {
        await play(channel, file);
      } catch (err) {
        console.error(`Couldn't play in #${channel.name}:`, err.message);
        getVoiceConnection(guildId)?.destroy();
      }
    }
  } finally {
    queues.delete(guildId);
    getVoiceConnection(guildId)?.destroy();
  }
}

async function play(channel, file) {
  let connection = getVoiceConnection(channel.guild.id);
  if (connection?.joinConfig.channelId !== channel.id) {
    connection?.destroy();
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
  }
  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

  const player = createAudioPlayer();
  connection.subscribe(player);
  player.play(createAudioResource(fs.createReadStream(file), { inputType: StreamType.OggOpus }));

  await new Promise((resolve) => {
    const timer = setTimeout(done, (CLIP_SECONDS + 5) * 1000);
    function done() {
      clearTimeout(timer);
      player.stop(true);
      resolve();
    }
    player.on(AudioPlayerStatus.Idle, done);
    player.on('error', (err) => {
      console.error('Player error:', err.message);
      done();
    });
  });
}

# Walk-on bot

A small Discord bot that plays a member's walk-on clip when they join a voice channel.

## Commands

- `/walkon set file:<upload> [start:1:23]`: upload up to 8 MB of audio or video. The bot keeps 10 s from the
  start time, levels the volume, fades the end and replies with what people will hear.
- `/walkon preview`: hear your walk-on.
- `/walkon off` / `/walkon on`: silence your own walk-on without deleting it.
- `/walkon clear`: delete it.
- `/walkon help`: how it works, the limits and your own status.
- `/walkon-admin role|remove|show`: only visible to members with Manage Server.

Who can set one: members with the role chosen via `/walkon-admin role`, plus anyone with Manage Server. Losing the
role silences the clip without deleting it. Each member's clip plays at most once a minute; if several people join
at once the clips play in turn. AFK and stage channels are skipped.

Limits live in `src/config.js`.

## Requirements

- Node.js 22.12 or newer (needed for Discord's encrypted voice)
- ffmpeg and ffprobe on the PATH

## Discord setup (https://discord.com/developers/applications)

1. **New Application**, then on the **Bot** tab **Reset Token** and copy it. No privileged intents are needed.
2. Optional: to stop others adding your bot, set **Installation → Install Link** to **None**, then switch off
   **Bot → Public Bot**.
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; bot permissions `View Channels`, `Connect`,
   `Speak`. Open the generated link and add the bot to your server.
4. In Discord, create a role with no permissions (e.g. "walkon"), give it to whoever should have walk-ons, then run
   `/walkon-admin role` and pick it.

## Running it

```sh
npm install --omit=dev
cp .env.example .env    # paste the bot token after DISCORD_TOKEN=
npm start
```

To run it as a systemd user service, copy the folder to `~/walkon-bot`, check the Node path in
`walkon-bot.service`, then:

```sh
mkdir -p ~/.config/systemd/user
cp walkon-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now walkon-bot
```

Clips are stored in `data/clips/<server id>/<member id>.ogg`, settings in `data/settings.json`.

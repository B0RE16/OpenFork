# OpenFork

A real-time browser strategy game about fighting over provinces with movable unit tokens,
inspired by OpenFront but written from scratch. Friends play together in a private lobby,
and bots take the other countries. The rules are in **[DESIGN.md](DESIGN.md)**.

Status: first playable. Everyone starts at peace; bots go to war when attacked or when they
see a weak neighbour (by difficulty). You can play a land war on mainland Europe (319 regions from real
provinces) with infantry and tanks, forts, entrenchment, supply, production, and
easy/normal/hard bots. Naval, air, alliances and fog of war come later.

## Run it

```bash
npm install
npm start          # builds the client, then serves http://localhost:8090
npm test           # rules, bots, lobbies
npm run typecheck
```

Requires Node 22.18+ (the server runs `.ts` files directly through Node's type stripping).
Set `PORT` and `HOST` to change where it listens.

Open the page, enter a name and **Create a private lobby**. **Copy invite link** and send it
to your friends, pick countries, and start. Bots fill the empty seats.

## Controls

| | |
|---|---|
| Left click / drag | select a unit or region / box-select your units (Shift adds) |
| Click a stack | expand it into its units, to pick single ones (click elsewhere closes it) |
| Double-click | a stack of yours: all of its units; elsewhere: all your units in that region |
| Right click | send the selected units to a region (they path there, fighting and capturing on the way) |
| Right drag, WASD, arrows | pan |
| Wheel | zoom |
| X / G / H | split in half / merge (any amounts, up to 100) / halt the selected units; the unit panel splits off a batch or any number |
| 1–9 or the build bar | placement mode: farm, mine, oil well, market, city (found or expand), fort, barracks, factory, road. Click one of your regions (roads: drag across regions); Shift places more, Esc / right click stops; a busy region queues it |
| Q / E | queue infantry / tanks at the selected region's barracks / factory |
| V | supply overlay: hubs, reach, cut-off regions, load per region |
| M / Sound button | sound on or off (remembered) |
| FX button | effects full or reduced (reduced drops the ambient water, clouds, smoke and traffic; it switches itself on a struggling machine) |
| Minimap (bottom right) | click or drag to move the view |
| Player list (top right) | declare war, offer or accept peace |
| Space | back to your capital |

On phones: tap a unit, then tap a region to send it; drag to pan, pinch to zoom.

## Layout

```
shared/            used by client and server
  rules.ts         every gameplay number (tune here)
  map.ts           map format (region grid + region table)
  protocol.ts      every WebSocket message
server/
  core/            game logic: no sockets, no timers
    sim.ts         the rules: movement, battles, capture, supply, economy, production
    bot.ts         bots
    game.ts        one match: sim + bots + snapshots, bot stand-ins for dropped players
    game-server.ts sessions, private lobbies, starting games
    parse.ts       checks client messages
    ports.ts       what a host must provide (transport, auth, clock)
  adapters/        guest identities in memory
  main.ts          standalone HTTP + WebSocket host
client/            browser game (bundled to public/app.js by esbuild)
public/            index.html, style.css, maps/
scripts/
  build-map.ts     builds public/maps/europe.* from open data (npm run build:map)
  preview-map.ts   debug picture of a built map
  bot-match.ts     a headless all-bot match, for balancing
test/
```

The server is authoritative: it runs the simulation at 10 ticks/s and sends each client a
snapshot 5 times a second (plus its own production queues). Clients only send orders.

## Hosting it elsewhere (e.g. as a Kernel module)

`server/core` has no I/O. Implement the ports in [`server/core/ports.ts`](server/core/ports.ts)
and drive `GameServer`:

```ts
const game = new GameServer({ transport, auth, clock: { now: () => Date.now() }, maps, matches });
onConnect(id)        -> game.handleConnect(id)
onMessage(id, json)  -> game.handleMessage(id, JSON.parse(json))
onClose(id)          -> game.handleDisconnect(id)
setInterval(() => game.tick(), TICK_MS);
```

`matches.recordMatch(result)` is told about every finished match.

## Map data

`public/maps/` is generated and committed; `npm run build:map` rebuilds it (downloads about
330 MB of source data into `.cache/`). Sources:

- Borders, rivers, lakes, places and land cover: [Natural Earth](https://www.naturalearthdata.com/) (public domain).
- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen/Tilezen), built from
  SRTM, GMTED2010 and ETOPO1 (public domain) and EU-DEM (produced using Copernicus data and
  information funded by the European Union).

## Font

[Pixelify Sans](https://github.com/eifetx/Pixelify-Sans) by the Pixelify Sans Project Authors,
under the SIL Open Font License 1.1 (`public/fonts/OFL.txt`).

## Known limits / next steps

- Balance is first-pass. Bot-only matches end in 17–40 minutes, but two evenly matched hard
  bots can stall into a long war; tune `shared/rules.ts` from real games.
- Guest identities live in memory: a server restart forgets who was who (and running games).
- Not built yet: naval, air, alliances, fog of war, procedural maps, the Kernel module.

# OpenFork: game design

OpenFork is a browser strategy game inspired by OpenFront and written from scratch. Instead of
free pixel borders and a troop flood, it has **provinces you fight over with movable unit
tokens**, and the focus is on **defense**: forts, digging in, slow enemy ground and supply.
It's played with friends, with bots filling the empty countries.

The numbers in "Starting tunables" are first guesses for playtesting; they all live in
`shared/rules.ts`.

## 1. Match
- Real-time and continuous. Target length is 15–25 min. No time limit and no pause.
- 4–8 countries per match. Humans join a **private lobby link**; bots fill the rest. The host
  sets lobby size, starting resources (low/normal/high), country pick (free or random) and
  bot difficulty (easy/normal/hard).
- Spectating is allowed for eliminated players and visitors.
- On disconnect a **bot takes over** the country until the player rejoins.
- **Win:** hold every capital. Alliances come after v1; allies who hold all remaining
  capitals will win together.
- **Losing your capital** eliminates you: your land goes neutral and empty, and your blobs
  disband.

## 2. Map
- v1 map: **Europe, modern countries, mainland only, Atlantic to the Urals** (no UK, Ireland,
  Iceland or islands until naval exists). About 300 land regions built from **real provinces**, with admin borders merged or split to that count (denser in the west, coarser in Russia).
- A map has **more start countries than lobby slots**. Humans pick, bots fill up to the lobby
  size, and the other countries start as empty neutral land.
- **Spawn spacing:** bots and randomly dealt countries keep their capitals at least 600 km
  from the ones already taken. Countries people pick themselves aren't restricted.
- **Small start:** capital + about 4 neighbouring regions, 2–3 infantry blobs, and a barracks in
  the capital. Neutral land is empty.
- Each region has:
  - **Terrain:** plains, forest, hills or mountains. Borders crossing a **river** give the
    defender a bonus.
  - **Traits:** city, industry, oil field and farmland. Cities are supply hubs.
  - **Size:** affects capture time and the stack cap.
- Procedural maps come after v1.
- **Look:** like OpenFront's detailed pixel map, with **terrain clearly visible**, territory
  tinted in the owner's colour, and province borders and blob counters drawn on top.

## 3. Economy
- Resources: **money, manpower, oil, steel**.
- **Yields:** every region gives a little money + manpower. Traits add the rest: industry →
  steel, oil field → oil, farmland → manpower, city → money.
- **Upkeep:** each blob costs money per minute, scaled by its size and type. If income goes
  below upkeep, **blobs wither**: they lose strength and training until you're back in the
  plus.
- **Buildings (v1):** barracks, factory, fort (levels), infrastructure (levels).
  - Placement is limited by region type: factories only in industry or city regions, and so
    on.
  - You pick what and where, pay, and it **builds over time in the background**. No builder
    units.
  - A captured region's buildings go **intact to the captor**.

## 4. Units (blobs)
- A blob is a token with a **type**, a **strength** (a small number, capped per type: infantry
  20, tanks 10) and a **training** level. v1 types: **infantry and tanks**. Naval and air come
  later.
- **Stat-based:** each type has attack, defense, speed, cost and upkeep. **Terrain matters
  a lot:** tanks are strong on plains and weak in forest and mountains.
- **Production:** you order a blob at a barracks (infantry) or factory (tanks), and a "repeat"
  toggle keeps producing. A new blob appears in the building's region.
- **Training:**
  - **Gained** from combat veterancy and from drilling: any idle blob in supply slowly trains
    up to a cap.
  - **Effect:** more damage dealt, less damage taken, faster capture.
- **Merging and splitting:**
  - Only same-type blobs merge. The merged blob's training is the size-weighted average minus
    a penalty, and its strength stops at the type cap.
  - Splitting is free; both halves keep their training.
- **Refill:** a damaged blob in supply slowly refills, paying manpower (plus steel for tanks).
- **Stack cap:** each region holds a limited number of tokens per player. The cap depends on
  region size and terrain and goes up with infrastructure. Units only passing through their
  own land don't count; without that, armies jam behind the front.

## 5. Movement
- **RTS controls:** click or box-select blobs, right-click a region to send them, and use keys
  for split, merge and build.
- **Pathing:** blobs path through any region. Infantry takes about 5.5 s to cross one plains
  region; terrain changes that, and infrastructure makes it faster.
- **Zone of control:** crossing enemy-owned land is slower than crossing your own, and forts
  there slow it more. A fort without units in it only slows; it can't stop anything.
- **Running into enemies:** if an enemy region on the path holds enemy blobs, the blob stops
  and a battle starts.
- **Capturing:** an empty enemy or neutral region is captured after the blob **holds it for a
  while**. The time scales with the region's size and terrain, forts make it longer, and
  training makes it shorter.
- **Retreat:** a blob can leave a battle, but it loses strength and training while
  disengaging.

## 6. Battles (contested regions)
- A region with hostile blobs in it is **contested**. Fighting is **continuous attrition**:
  every tick each side deals damage = strength × attack × training × terrain/type modifiers.
- **Defender bonus = fort + entrenchment + river crossing**, added together.
  **Entrenchment** builds up while a blob holds still and is lost when it moves.
- Anyone can reinforce either side mid-battle. With 3 or more sides, **each side spreads its
  damage over all hostile sides in proportion to their strength**.
- The battle ends when only one side has blobs left. If the winner isn't the owner, the
  capture timer starts.

## 7. Supply
- **Hubs:** your capital and every **city** region you own. A region is in supply if it
  connects to a hub through your land within reach.
- **Capacity:** each region has a supply capacity, raised by infrastructure. More blobs than
  capacity means partial supply.
- **Out of supply:**
  - blobs weaken and slowly die;
  - they can't refill or drill;
  - the region gives no income or production;
  - a cut-off region with 0 units turns **neutral**.
- Otherwise empty regions stay yours until an enemy captures them.

## 8. Bots
Bots have **easy, normal and hard** difficulty. They use the same orders as humans:
- expand into neutral land;
- build forts and infrastructure on threatened borders;
- produce blobs;
- attack weak neighbours;
- defend their capital.

They also take over for players who disconnect.

## Later (not in v1)
- **Naval:** ports, sea lanes between ports (no sea zones), transports that carry land blobs,
  and warship blobs that fight on lanes and sink transports.
- **Air:** air blobs that are fast, ignore terrain and ZoC, and return to airfields.
  Bombers hit forts, buildings and supply; fighters and AA defenses counter them.
- **Alliances** (shared win) and **fog of war** (see your own regions and their neighbours,
  last-known state elsewhere).
- Procedural maps, other real-world maps, islands.
- The Kernel module (copy of flowrace: install/update from GitHub, kernel-host.ts,
  `/kernel/status`, Tailscale share, `openfork.match.*` events).

---

## Starting tunables (proposed; all in `shared/rules.ts`)
| Thing | Start value |
|---|---|
| Server tick | 10/s |
| Infantry: max strength / speed / attack / defense | 20 / 1.0 / 1.0 / 1.2 |
| Tanks: max strength / speed / attack / defense | 10 / 1.8 / 2.5 / 1.5 |
| Crossing one plains region (speed 1.0) | 5.5 s |
| Terrain move ×: plains / forest / hills / mountains | 1 / 0.7 / 0.6 / 0.4 |
| Tank attack ×: plains / forest / hills / mountains | 1.2 / 0.6 / 0.7 / 0.4 |
| Enemy-land move × / per fort level | 0.7 / −0.1 |
| Fort levels / defender bonus each | 3 / +0.5 |
| Entrenchment: max / time to full | +0.5 / 60 s |
| River defender bonus | +0.25 |
| Training range / drill rate / cap from drill | 0–100 / +1 per 6 s / 50 (combat can go to 100) |
| Training effect at 100 | ×1.5 damage dealt, ×0.67 damage taken |
| Merge penalty | −10 training |
| Capture time, empty plains, medium size | 4 s (× terrain/size/fort, ÷ training) |
| Supply reach from a hub | 6 regions |
| Base yield per region (money / manpower) | 0.25 / 0.15 per s |
| Stack cap | 2–4 tokens by size/terrain, +1 per infrastructure level (max 3) |
| Retreat cost | −15% strength, −10 training |

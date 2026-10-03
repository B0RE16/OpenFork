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
  steel, oil field → oil, farmland → manpower. Cities pay tax: +0.6 money and +0.15 manpower
  per level, every second.
- **Upkeep:** each blob costs money per minute, scaled by its size and type. If income goes
  below upkeep, **blobs wither**: they lose strength and training until you're back in the
  plus.
- **Cities** (levels 1–5) are the heart of development.
  - The map's cities are the real ones with a million people or more (about 50); their
    starting level comes from the population (1–2M: 1 … 8M+: 4, so Paris, Moscow and
    Istanbul start at 4). Level 5 only comes from expanding.
  - Your capital starts at level 3 or more; cities of countries nobody plays start at 1, so
    nobody gets a free metropolis.
  - **Expand city** (a build, cost and time grow with the level) gives more tax, a slot, +1
    stack cap and one more hop of supply reach.
  - **Found a city** in a region of yours that's in supply and not next to another city
    ($1600, 240 steel, 4 minutes): a rare, big decision. It starts at level 1 and is a
    supply hub. Expanding to level L costs $240·L and 40·(L−1) steel and takes L minutes.
- **Slots:** a region has 1 (2 if large), plus its city level. Every
  building but cities and roads takes one (a fort takes one for all its levels). Choosing
  what a region is for is the trade-off; demolishing frees a slot at once, with no refund.
- **Economic buildings** go only within 2 regions of one of your cities:
  - Farm (+0.3 manpower/s): farmland or plains.
  - Mine (+0.4 steel/s on industry, +0.25 on hills or mountains).
  - Oil well (+0.4 oil/s): oil fields.
  - Market (+0.4 money/s): anywhere.
  Several of the same kind per region are fine.
- **Military buildings:** fort (levels 1–3) anywhere you own; barracks and factory in cities.
- **Roads** join two of your regions across their border: crossing is 40% faster (for
  anyone, invaders too) and the border counts as half a hop for supply. Paint them by
  dragging across regions.
- You pick what and where, pay, and it **builds over time in the background**. No builder
  units.
  - **Placement mode:** pick a building in the build bar (or 1–9), then click one of your
    regions (roads: drag); Shift places more. Valid regions light up green, and the bar
    shows the exact cost of the next level and the free slots in the region under the
    cursor.
  - **Build queue:** a busy region queues up to 3 more builds behind the one under way. Each
    is paid when placed and can be cancelled for a full refund (cancelling a fort or city
    level also cancels the higher levels queued after it). A captured region's queue is
    lost.
  - Towns, fields, mines, derricks, market halls and roads are drawn into the map itself.
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
  region size and terrain and goes up by 1 per fort level and per city level. Units only passing through their
  own land don't count; without that, armies jam behind the front.

## 5. Movement
- **RTS controls:** click or box-select blobs, right-click a region to send them, and use keys
  for split, merge and build.
- **Pathing:** blobs path through any region. Infantry takes about 5.5 s to cross one plains
  region; terrain changes that, and roads make it faster.
- **Zone of control:** crossing enemy-owned land is slower than crossing your own, and forts
  there slow it more. A fort without units in it only slows; it can't stop anything.
- **Running into enemies:** if an enemy region on the path holds enemy blobs, the blob stops
  and a battle starts.
- **Capturing:** an empty enemy or neutral region is captured after the blob **holds it for a
  while**. The time scales with the region's size and terrain, forts make it longer, and
  training makes it shorter.
- **How a fight looks:** units in their own region hold the middle (with a shield showing
  their fort level, whether they're dug in, and a river crossed by the attackers); units
  attacking or taking a region stand on the border they crossed, one group per border,
  with a big arrow in their colour pointing in. Borders between countries at war show as
  two-colour front lines; units pulling out of a fight get a grey arrow back.
- **Retreat:** a blob can leave a battle, but only backwards: to the region it came from or
  to a neighbouring region its owner holds, never on past the enemy. It loses strength and
  training while disengaging.

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
- **Hubs:** every **city** you own (your capital is one). A city reaches 3 + its level
  regions through your land (a level-3 capital: 6); a border with a road counts as half.
- **Capacity:** each region has a supply capacity by terrain, raised by a city in it. More
  blobs than capacity means partial supply.
- **Out of supply:**
  - blobs weaken and slowly die;
  - they can't refill or drill;
  - the region gives no income or production;
  - a cut-off region with 0 units turns **neutral**.
- Otherwise empty regions stay yours until an enemy captures them.

## 8. War and peace
- **Everyone starts at peace.** Units of countries at peace never fight; they can share
  neutral land (whoever started capturing a region first takes it).
- **A peaceful country's land is closed:** routes go around it. Sending units into it is an
  attack and declares war (the game asks you to confirm). You can also declare war from the
  player list.
- **Peace:** either side can offer it; the other accepts or refuses, and the offer lapses
  after 30 s. Peace starts a **3-minute truce** (no war between the two) and sends each
  side's units home.
- Zones of control (slow movement) apply only in the land of countries you're at war with.

## 9. Bots
Bots have **easy, normal and hard** difficulty. They use the same orders as humans:
- expand into neutral land;
- guard their borders and dig in with forts, also in peacetime;
- produce blobs;
- fight only countries they're at war with, and defend their capital.

**When bots go to war:** when they're attacked, or by difficulty against a bordering
country much weaker than them:
- **easy:** never;
- **normal:** from minute 5, against a neighbour with less than half their strength,
  sometimes;
- **hard:** from minute 3, against one with about 60% of their strength or less, more often.

Bots offer peace when a war goes badly or stalls, and accept offers when the war isn't
going their way. A bot playing for a disconnected person never starts a war.

## Later (not in v1)
- **Naval:** ports, sea lanes between ports (no sea zones), transports that carry land blobs,
  and warship blobs that fight on lanes and sink transports.
- **Air:** air blobs that are fast, ignore terrain and ZoC, and return to airfields.
  Bombers hit forts, buildings and supply; fighters and AA defenses counter them.
- **Alliances** (shared win; peace and war exist already) and **fog of war** (see your own regions and their neighbours,
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
| Capture time, empty plains, medium size | 6.5 s (× terrain/size/fort, ÷ training) |
| Infantry / tank production | 20 s / 30 s |
| Truce after peace / peace offer stands | 180 s / 30 s |
| Supply reach from a city | 3 + its level (roads: half a hop) |
| Base yield per region (money / manpower) | 0.12 / 0.15 per s |
| Starting resources (normal) | $120, 120 manpower, 25 steel, 20 oil |
| Build times | farm, market 60 s; mine, oil well 75 s; fort 60 s per level; barracks 60 s; factory 120 s; road 30 s |
| Stack cap | 2–4 tokens by size/terrain, +1 per fort level, +1 per city level |
| Slots | 1 (large: 2), + city level |
| Retreat cost | −15% strength, −10 training |

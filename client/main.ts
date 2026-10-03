// The app: home screen, lobby, and handing over to the game screen.
import type { GameMap } from '../shared/map.ts';
import type { LobbySettings, LobbyView, ServerMessage } from '../shared/protocol.ts';
import { MAX_PLAYERS, MIN_PLAYERS } from '../shared/rules.ts';
import { GameScreen } from './game-screen.ts';
import { Net, savedName } from './net.ts';
import { ICONS, spriteUrl } from './sprites.ts';
import { $, el, toast } from './ui.ts';

const net = new Net();
// The map canvas uses the pixel font too; make sure it's loaded early.
void document.fonts?.load('12px "Pixelify Sans"');
void document.fonts?.load('700 12px "Pixelify Sans"');
let me: { id: string; name: string } | null = null;
let lobby: LobbyView | null = null;
let game: GameScreen | null = null;
// Map data and terrain load once each (shared promises), and start loading on page load:
// the lobby only needs the small map data; the big terrain image is only needed in game.
const mapData = new Map<string, Promise<GameMap>>();
const terrains = new Map<string, Promise<HTMLImageElement>>();
/** Map data that has arrived, for drawing the lobby without waiting a frame. */
const loadedMaps = new Map<string, GameMap>();
let connected = false;
/** A game started and its map is still loading. */
let loadingGame = false;
/** The person already asked to create or join a lobby this visit. */
let asked = false;

const screens = ['home', 'lobby', 'game'] as const;
function show(screen: (typeof screens)[number]): void {
  for (const s of screens) $(`#${s}`).classList.toggle('hidden', s !== screen);
}

// -- home -------------------------------------------------------------------------------------

const nameInput = $('#name') as HTMLInputElement;
const codeInput = $('#code') as HTMLInputElement;
nameInput.value = savedName();
const invited = new URLSearchParams(location.search).get('lobby');
if (invited) codeInput.value = invited.toUpperCase();

function ensureConnected(): boolean {
  const name = nameInput.value.trim();
  if (!name) {
    toast('Pick a name first');
    nameInput.focus();
    return false;
  }
  if (!connected) {
    net.connect(name);
    connected = true;
  }
  return true;
}

$('#create').onclick = () => {
  if (!ensureConnected()) return;
  asked = true;
  net.send({ t: 'lobby.create' });
};
$('#join').onclick = () => {
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return toast('Enter a lobby code');
  if (!ensureConnected()) return;
  asked = true;
  net.send({ t: 'lobby.join', code });
};
codeInput.onkeydown = (e) => {
  if (e.key === 'Enter') $('#join').click();
};
// Coming back with a name already saved: reconnect, so a running game picks up again.
if (nameInput.value) ensureConnected();

// -- lobby ------------------------------------------------------------------------------------

$('#leave').onclick = () => net.send({ t: 'lobby.leave' });
$('#start').onclick = () => net.send({ t: 'lobby.start' });
$('#copy-link').onclick = async () => {
  if (!lobby) return;
  const link = `${location.origin}${location.pathname}?lobby=${lobby.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied', 'info');
  } catch {
    prompt('Send this link to your friends:', link);
  }
};

function loadMapData(id: string): Promise<GameMap> {
  let p = mapData.get(id);
  if (!p) {
    p = fetch(`maps/${id}.json`).then((r) => {
      if (!r.ok) throw new Error(`map ${id}: ${r.status}`);
      return r.json() as Promise<GameMap>;
    });
    p.then((map) => loadedMaps.set(id, map), () => {});
    // A failed load is retried next time instead of being remembered.
    p.catch(() => mapData.delete(id));
    mapData.set(id, p);
  }
  return p;
}

function loadTerrain(id: string): Promise<HTMLImageElement> {
  let p = terrains.get(id);
  if (!p) {
    p = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`terrain ${id} failed to load`));
      img.src = `maps/${id}-terrain.png`;
    });
    p.catch(() => terrains.delete(id));
    terrains.set(id, p);
  }
  return p;
}

async function loadMap(id: string): Promise<{ map: GameMap; terrain: HTMLImageElement }> {
  const [map, terrain] = await Promise.all([loadMapData(id), loadTerrain(id)]);
  return { map, terrain };
}

// Start fetching the only map while the person types their name: the small map data first,
// then (once the page has loaded, so it doesn't hold the page up) the big terrain image.
loadMapData('europe')
  .catch(() => {})
  .finally(() => {
    const terrain = () => loadTerrain('europe').catch(() => {});
    if (document.readyState === 'complete') terrain();
    else window.addEventListener('load', terrain, { once: true });
  });

async function renderLobby(): Promise<void> {
  if (!lobby || !me) return;
  $('#lobby-code').textContent = lobby.code;
  history.replaceState(null, '', `?lobby=${lobby.code}`);
  // Everything but the country list draws at once; the list waits for the map data.
  let map = loadedMaps.get(lobby.settings.map) ?? null;
  if (!map) {
    renderLobbyBody(null);
    try {
      map = await loadMapData(lobby.settings.map);
    } catch {
      $('#countries').replaceChildren(el('p', { class: 'hint' }, ['Could not load the map. Reload the page to try again.']));
      return;
    }
    if (!lobby) return; // left while the map loaded
  }
  renderLobbyBody(map);
}

function renderLobbyBody(map: GameMap | null): void {
  if (!lobby || !me) return;
  const host = lobby.host === me.id;
  const members = $('#members');
  members.replaceChildren(
    ...lobby.members.map((m) =>
      el('li', { class: m.connected ? '' : 'away' }, [
        el('span', {}, [`${m.name}${m.id === lobby?.host ? ' [HOST]' : ''}${m.id === me?.id ? ' [YOU]' : ''}`]),
        el('span', { class: 'hint' }, [m.country ? countryName(m.country) : m.connected ? 'no pick' : 'away']),
      ]),
    ),
  );

  const s = lobby.settings;
  const settings = $('#settings');
  const select = (key: keyof LobbySettings, options: Array<[string, string]>) => {
    const sel = el('select', { disabled: host ? undefined : 'true' }, options.map(([v, label]) => el('option', { value: v }, [label]))) as HTMLSelectElement;
    sel.value = String(s[key]);
    sel.onchange = () => {
      const value = key === 'size' ? Number(sel.value) : sel.value;
      net.send({ t: 'lobby.settings', settings: { [key]: value } as Partial<LobbySettings> });
    };
    return sel;
  };
  const sizes: Array<[string, string]> = [];
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) sizes.push([String(n), `${n} countries`]);
  settings.replaceChildren(
    el('span', {}, ['Map']),
    select('map', [['europe', 'Europe']]),
    el('span', {}, ['Countries']),
    select('size', sizes),
    el('span', {}, ['Starting resources']),
    select('starting', [
      ['low', 'Low'],
      ['normal', 'Normal'],
      ['high', 'High'],
    ]),
    el('span', {}, ['Countries are']),
    select('pick', [
      ['free', 'Picked freely'],
      ['random', 'Dealt at random'],
    ]),
    el('span', {}, ['Bots']),
    select('difficulty', [
      ['easy', 'Easy'],
      ['normal', 'Normal'],
      ['hard', 'Hard'],
    ]),
  );

  const start = $('#start') as HTMLButtonElement;
  start.disabled = !host || lobby.playing;
  $('#lobby-status').textContent = loadingGame
    ? 'Loading the map…'
    : lobby.playing
      ? 'A game is running.'
      : host
        ? `${lobby.members.length} ${lobby.members.length === 1 ? 'person' : 'people'} here; bots fill up to ${s.size}.`
        : 'Waiting for the host to start.';
  if (!map) {
    $('#countries').replaceChildren(el('p', { class: 'hint' }, ['Loading the map…']));
    return;
  }
  const capitalIcon = spriteUrl(ICONS.capital, 2);
  const mine = lobby.members.find((m) => m.id === me?.id)?.country ?? null;
  const takenBy = new Map(lobby.members.filter((m) => m.country).map((m) => [m.country as string, m.name]));
  $('#countries').replaceChildren(
    ...map.countries
      .filter((c) => c.playable)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => {
        const by = takenBy.get(c.id);
        const capital = map.regions[c.capital]?.name ?? '';
        const b = el('button', { class: c.id === mine ? 'mine' : by ? 'taken' : '' }, [
          el('img', { src: capitalIcon, alt: '' }),
          c.name,
          el('small', {}, [by && c.id !== mine ? by : capital]),
        ]);
        b.onclick = () => net.send({ t: 'lobby.pick', country: c.id === mine ? null : c.id });
        if (s.pick === 'random') (b as HTMLButtonElement).disabled = true;
        return b;
      }),
  );

  function countryName(id: string): string {
    return map?.countries.find((c) => c.id === id)?.name ?? id;
  }
}

// -- messages ---------------------------------------------------------------------------------

net.onStatus = (up) => $('#offline').classList.toggle('hidden', up || !connected);

net.onMessage = async (msg: ServerMessage) => {
  switch (msg.t) {
    case 'welcome':
      me = { id: msg.id, name: msg.name };
      return;
    case 'error':
      toast(msg.message);
      game?.onRefused();
      return;
    case 'lobby':
      lobby = msg.lobby;
      if (!lobby) {
        game?.destroy();
        game = null;
        history.replaceState(null, '', location.pathname);
        show('home');
        // Opened an invite link with a name already saved: join straight away, once.
        if (invited && !asked && codeInput.value) {
          asked = true;
          net.send({ t: 'lobby.join', code: codeInput.value });
        }
        return;
      }
      if (!game || game.finished) {
        if (!game) show('lobby');
        await renderLobby();
      }
      return;
    case 'game.start': {
      // The terrain may still be on its way: say so in the lobby meanwhile.
      loadingGame = true;
      if (!game) renderLobbyBody(await loadMapData(msg.map).catch(() => null));
      let loaded: { map: GameMap; terrain: HTMLImageElement };
      try {
        loaded = await loadMap(msg.map);
      } catch {
        loadingGame = false;
        toast('Could not load the map. Reload the page to try again.');
        return;
      }
      loadingGame = false;
      const { map, terrain } = loaded;
      game?.destroy();
      game = new GameScreen(net, map, terrain, msg.you, msg.players, () => {
        game?.destroy();
        game = null;
        show('lobby');
        void renderLobby();
      });
      show('game');
      game.start();
      return;
    }
    case 'snap':
      game?.onSnapshot(msg.snap);
      return;
    case 'game.over':
      game?.onOver(msg.winner);
      return;
  }
};

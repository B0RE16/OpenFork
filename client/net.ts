// The WebSocket connection: says hello with the saved token, reconnects on its own.
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';

const TOKEN_KEY = 'openfork.token';
const NAME_KEY = 'openfork.name';

export function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the identity just won't survive a reload
  }
}

export class Net {
  private ws: WebSocket | null = null;
  private name = '';
  private retry = 500;
  private queue: ClientMessage[] = [];
  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};

  connect(name: string): void {
    this.name = name;
    save(NAME_KEY, name);
    this.open();
  }

  private open(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      let token: string | undefined;
      try {
        token = localStorage.getItem(TOKEN_KEY) ?? undefined;
      } catch {
        token = undefined;
      }
      ws.send(JSON.stringify({ t: 'hello', name: this.name, token }));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
      this.onStatus(true);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      if (msg.t === 'welcome') save(TOKEN_KEY, msg.token);
      this.onMessage(msg);
    };
    ws.onclose = () => {
      this.onStatus(false);
      setTimeout(() => this.open(), this.retry);
      this.retry = Math.min(8000, this.retry * 2);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }
}

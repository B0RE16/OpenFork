// Standalone adapters: guest identities kept in memory (a browser keeps its token, so a
// reload or a dropped connection comes back as the same person until the server restarts).
import { randomBytes, randomUUID } from 'node:crypto';
import type { Auth, Identity } from '../core/ports.ts';

export class GuestAuth implements Auth {
  private readonly tokens = new Map<string, string>();

  async identify(hello: { token?: string; name: string }): Promise<Identity> {
    const known = hello.token ? this.tokens.get(hello.token) : undefined;
    if (known && hello.token) return { id: known, token: hello.token, name: hello.name };
    const token = randomBytes(24).toString('base64url');
    const id = randomUUID();
    this.tokens.set(token, id);
    return { id, token, name: hello.name };
  }
}

// Small DOM helpers.

export function $(selector: string): HTMLElement {
  const e = document.querySelector<HTMLElement>(selector);
  if (!e) throw new Error(`missing ${selector}`);
  return e;
}

export function el(tag: string, attrs: Record<string, string | undefined> = {}, children: Array<Node | string> = []): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

let toastTimer = 0;
export function toast(message: string, kind: 'error' | 'info' = 'error'): void {
  const t = $('#toast');
  t.textContent = message;
  t.style.background = kind === 'info' ? '#1d3a2a' : '';
  t.style.borderColor = kind === 'info' ? '#2f6b47' : '';
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), 2600);
}

export function fmt(n: number): string {
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.floor(n));
}

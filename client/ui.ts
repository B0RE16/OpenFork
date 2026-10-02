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
  t.classList.toggle('info', kind === 'info');
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), 2600);
}

/** The cyan classification strip at the top of a panel. */
export function classbar(left: string, right = ''): HTMLElement {
  return el('div', { class: 'classbar' }, [el('span', {}, [left]), el('span', {}, [right])]);
}

/** A segmented progress bar (10 cells). */
export function cellBar(v: number): HTMLElement {
  const on = Math.round(Math.min(1, Math.max(0, v)) * 10);
  return el(
    'div',
    { class: 'bar' },
    Array.from({ length: 10 }, (_, i) => el('i', { class: i < on ? 'on' : '' })),
  );
}

export function fmt(n: number): string {
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.floor(n));
}

/** A pixel-styled yes/no box. Resolves true when confirmed. */
export function confirmBox(head: string, text: string, yes: string): Promise<boolean> {
  const box = $('#confirm');
  $('#confirm-head').textContent = head;
  $('#confirm-text').textContent = text;
  $('#confirm-yes').textContent = yes;
  box.classList.remove('hidden');
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      box.classList.add('hidden');
      $('#confirm-yes').onclick = null;
      $('#confirm-no').onclick = null;
      resolve(v);
    };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
  });
}

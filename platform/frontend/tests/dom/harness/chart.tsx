/**
 * Driving the chart workspace the way a person does.
 *
 * Every helper here is a GESTURE — click this button, drag from here to there,
 * right-click that strip — expressed against the real DOM the product renders.
 * None of them reaches into a component's state, and none of them asserts a
 * pixel: what they return is what the product then did, in the product's own
 * terms (a drawing's stored price, a menu's label, a request's query string).
 *
 * The chart's own coordinate system is REAL. `lightweight-charts` runs
 * unmodified against the fixed 1280×800 box `register.ts` reports, so
 * `series.priceToCoordinate` and `timeScale().coordinateToLogical` do their
 * genuine arithmetic and a drag at y=300 lands on the price that is actually
 * at y=300. That is why these tests can tell a drawing's own level apart from
 * the pointer's price, which is the distinction a whole class of menu defects
 * lived in.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import TvWorkspace from "@/app/chart/page";
import { settle } from "./env";

export interface MountedChart {
  container: HTMLElement;
  /** The first pane's chart host — what the drawing layer listens on. */
  plot: HTMLElement;
  pane: (index?: number) => HTMLElement;
}

/** Render the chart workspace and wait for its first load to settle. */
export async function mountChart(): Promise<MountedChart> {
  const view = render(<TvWorkspace />);
  await settle();
  const pane = (index = 0): HTMLElement => {
    const panes = view.container.querySelectorAll<HTMLElement>("[data-pane-id]");
    const found = panes[index];
    if (!found) throw new Error(`no pane at index ${index}; ${panes.length} rendered`);
    return found;
  };
  return { container: view.container, plot: plotOf(pane(0)), pane };
}

/** The element the drawing layer and the context menu listen on. */
export function plotOf(pane: HTMLElement): HTMLElement {
  const el = pane.querySelector<HTMLElement>(".tv-lightweight-charts");
  if (!el) throw new Error("the pane has no chart host");
  return el;
}

const at = (x: number, y: number): { clientX: number; clientY: number; bubbles: boolean } =>
  ({ clientX: x, clientY: y, bubbles: true });

/** Press, move, release — one complete drawing gesture. */
export async function drag(
  el: HTMLElement, from: [number, number], to: [number, number]
): Promise<void> {
  fireEvent.mouseDown(el, { button: 0, ...at(...from) });
  fireEvent.mouseMove(el, at(...to));
  fireEvent.mouseUp(el, { button: 0, ...at(...to) });
  await settle();
}

/** A single click, which is how the one-anchor tools commit. */
export async function clickAt(el: HTMLElement, x: number, y: number): Promise<void> {
  fireEvent.mouseDown(el, { button: 0, ...at(x, y) });
  fireEvent.mouseUp(el, { button: 0, ...at(x, y) });
  await settle();
}

export async function rightClickAt(el: HTMLElement, x: number, y: number): Promise<void> {
  fireEvent.contextMenu(el, { button: 2, ...at(x, y) });
  await settle();
}

/** The open context menu, or null. Its accessible name is the menu's label. */
export function openMenu(): HTMLElement | null {
  return screen.queryByRole("menu");
}

export function menuLabel(): string | null {
  return openMenu()?.getAttribute("aria-label") ?? null;
}

/** Every item the open menu offers, as `label` → enabled. */
export function menuItems(): { label: string; disabled: boolean }[] {
  const menu = openMenu();
  if (!menu) return [];
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((el) => ({
    label: (el.textContent ?? "").trim(),
    disabled: el.getAttribute("aria-disabled") === "true",
  }));
}

/** Activate a menu item by its visible text. */
export async function chooseMenuItem(text: string | RegExp): Promise<void> {
  const menu = openMenu();
  if (!menu) throw new Error("no context menu is open");
  const item = within(menu).getByText(
    (content, element) => {
      if (!element || !element.getAttribute("role")?.startsWith("menuitem")) return false;
      const label = (element.textContent ?? "").trim();
      return typeof text === "string" ? label.includes(text) : text.test(label);
    },
    { selector: '[role^="menuitem"]' }
  );
  fireEvent.click(item);
  await settle();
}

/** The drawing tool currently armed, read from the rail's pressed button. */
export function armedTool(container: HTMLElement): string | null {
  const rail = container.querySelector<HTMLElement>('[data-drawing-rail="true"]')
    ?? container;
  const pressed = [...rail.querySelectorAll<HTMLElement>('button[aria-pressed="true"][title]')]
    .find((el) => el.getAttribute("title") !== null);
  return pressed?.getAttribute("title") ?? null;
}

/** The interval the focused pane is on, read from the toolbar's pressed key. */
export function armedInterval(container: HTMLElement): string | null {
  const pressed = [...container.querySelectorAll<HTMLElement>('button[aria-pressed="true"]')]
    .map((el) => (el.textContent ?? "").trim())
    // Seconds joined the resolutions a chart can be on; a helper that could not
    // see `30s` would report "no timeframe armed" on a perfectly good chart.
    .find((text) => /^\d+[smhd]$/.test(text));
  return pressed ?? null;
}

/** Arm a drawing tool through its toolbar button, as a user would. */
export async function selectTool(container: HTMLElement, title: string): Promise<void> {
  const button = container.querySelector<HTMLElement>(`button[title="${title}"]`);
  if (!button) throw new Error(`no drawing-tool button titled ${JSON.stringify(title)}`);
  fireEvent.click(button);
  await settle();
}

/** A keystroke aimed at whatever currently has focus. */
export async function press(
  key: string, init: Partial<KeyboardEventInit> = {}, target?: HTMLElement
): Promise<void> {
  fireEvent.keyDown(target ?? document.activeElement ?? window, {
    key, bubbles: true, ...init,
  });
  await settle();
}

/** Type a sequence of bare keys, the way an interval is typed. */
export async function pressAll(keys: string[]): Promise<void> {
  for (const key of keys) {
    await press(key);
  }
}

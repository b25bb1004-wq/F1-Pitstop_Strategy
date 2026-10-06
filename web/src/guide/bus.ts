/* Tiny app-wide event bus: views announce what the user did; the guide listens to verify tasks. */
export type PwEvent = { name: string; value?: string };
export const emit = (name: string, value?: string) => window.dispatchEvent(new CustomEvent<PwEvent>("pitwall", { detail: { name, value } }));
export const on = (fn: (e: PwEvent) => void) => {
  const h = (e: Event) => fn((e as CustomEvent<PwEvent>).detail);
  window.addEventListener("pitwall", h);
  return () => window.removeEventListener("pitwall", h);
};

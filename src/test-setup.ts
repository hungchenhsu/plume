// jsdom does not implement `window.matchMedia`. preferences.ts calls it at
// module load time (to watch the OS color scheme for the "system" theme),
// so any test that imports preferences.ts — even transitively — needs this
// stub in place before that module is first evaluated. Vitest runs
// `setupFiles` before test files are loaded, which is early enough.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const mql: MediaQueryList = {
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (typeof listener === "function") {
          listeners.add(listener as (event: MediaQueryListEvent) => void);
        }
      },
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (typeof listener === "function") {
          listeners.delete(listener as (event: MediaQueryListEvent) => void);
        }
      },
      dispatchEvent: () => false,
    };
    return mql;
  };
}

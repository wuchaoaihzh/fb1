/// <reference types="vite/client" />

interface Window {
  radarApi: {
    command: (command: string, payload?: unknown) => Promise<unknown>;
    onAlertSound: (callback: () => void) => void;
  };
}

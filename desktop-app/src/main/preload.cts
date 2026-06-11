const electron = require("electron") as typeof import("electron");

electron.contextBridge.exposeInMainWorld("radarApi", {
  command: (command: string, payload?: unknown) => electron.ipcRenderer.invoke("command", command, payload),
  onAlertSound: (callback: () => void) => {
    const listener = () => callback();
    electron.ipcRenderer.on("play-alert-sound", listener);
    return () => electron.ipcRenderer.removeListener("play-alert-sound", listener);
  }
});

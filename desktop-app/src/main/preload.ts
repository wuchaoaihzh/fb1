import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("radarApi", {
  command: (command: string, payload?: unknown) => ipcRenderer.invoke("command", command, payload),
  onAlertSound: (callback: () => void) => ipcRenderer.on("play-alert-sound", callback)
});

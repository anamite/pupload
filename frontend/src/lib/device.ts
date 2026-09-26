import { readLocal, writeLocal } from "./storage";

const ID_KEY = "pupload.device.id";
const NAME_KEY = "pupload.device.name";

/** crypto.randomUUID needs HTTPS; getRandomValues works on plain http LAN too. */
function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 1;
  let os = "Computer";
  if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) os = "iPad";
  else if (/Android/.test(ua)) os = /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  else if (/Windows/.test(ua)) os = "Windows PC";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "Mac";
  else if (/CrOS/.test(ua)) os = "Chromebook";
  else if (/Linux/.test(ua)) os = "Linux PC";

  let browser = "";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/SamsungBrowser/.test(ua)) browser = "Samsung Internet";
  else if (/Firefox|FxiOS/.test(ua)) browser = "Firefox";
  else if (/Chrome|CriOS/.test(ua)) browser = "Chrome";
  else if (/Safari/.test(ua)) browser = "Safari";
  return browser ? `${os} · ${browser}` : os;
}

export function deviceId(): string {
  let id = readLocal(ID_KEY);
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    id = randomId();
    writeLocal(ID_KEY, id);
  }
  return id;
}

export function deviceName(): string {
  return readLocal(NAME_KEY) || guessDeviceName();
}

export function setDeviceName(name: string): void {
  const clean = name.trim().slice(0, 60);
  writeLocal(NAME_KEY, clean && clean !== guessDeviceName() ? clean : null);
}

export function deviceHeaders(): Record<string, string> {
  return {
    "X-Device-Id": deviceId(),
    "X-Device-Name": encodeURIComponent(deviceName()),
  };
}

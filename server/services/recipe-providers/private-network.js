/**
 * Modul: Rezept-Provider - privates Netz
 * Zweck: EINE Stelle fuer das Opt-in RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK und
 *        fuer die Antwort, die ein Admin bekommt, wenn es fehlt.
 *
 *        Bis v2.64.0 rutschte eine base_url mit IP-Literal
 *        (`http://192.168.1.50:9925`) am SSRF-Hook vorbei, weil node:http den
 *        lookup-Hook fuer Literale nicht ruft. Seit GHSA-9jh6 fragt safeRequest
 *        den Hook auch dafuer - und die Route antwortete auf die Ablehnung mit
 *        "Could not connect ... with these credentials" (#1053). Der Admin erfaehrt
 *        den Schalter dort, wo er die URL eingibt (Vorbild:
 *        server/services/notification-channels.js), und die Ablehnung aus dem
 *        Hook ("URL resolves to a private IP address: x") traegt denselben Hinweis
 *        auf dem Verbindungstest, der Konto-Karte und im Sync.
 *
 *        Hier steht keine eigene Liste privater Netze - die Klassifikation kommt
 *        aus server/utils/ssrf.js, sonst gaebe es zwei.
 * Abhaengigkeiten: node:net, server/utils/ssrf.js
 */
import { isIP } from 'node:net';
import {
  isBlockedAddress, isBlockedHostname, normalizeHostname, readPrivateNetworkOptIn,
} from '../../utils/ssrf.js';

export const ENV_ALLOW_PRIVATE_NETWORK = 'RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK';

/**
 * Opt-in: erlaubt private/lokale Netzwerkziele fuer die base_url (z. B. ein
 * Docker-internes Compose-Hostname oder eine LAN-IP). Hebt den SSRF-Schutz
 * bewusst auf - nur in kontrollierten Umgebungen setzen. Wird zur Laufzeit
 * gelesen, damit Tests process.env vor dem Aufruf setzen koennen.
 */
export function isPrivateNetworkAllowed() {
  return readPrivateNetworkOptIn(ENV_ALLOW_PRIVATE_NETWORK);
}

export const PRIVATE_NETWORK_MESSAGE =
  `Recipe provider URL must not point to a private or local network address (set ${ENV_ALLOW_PRIVATE_NETWORK}=true to allow it).`;

/**
 * Was sich ohne DNS entscheiden laesst, faellt schon beim Speichern: localhost,
 * reservierte Suffixe (.local, .internal, ...) und ein IP-Literal aus einem
 * privaten Netz. Einen NAMEN, der privat aufloest, prueft erst der Lookup-Hook
 * im Adapter, je Verbindung (Anti-Rebinding) - siehe withPrivateNetworkHint().
 */
export function isBlockedBaseUrl(baseUrl) {
  if (isPrivateNetworkAllowed()) return false;
  let url;
  try { url = new URL(baseUrl); } catch { return false; }
  const host = normalizeHostname(url.hostname);
  return isBlockedHostname(host) || (isIP(host) !== 0 && isBlockedAddress(host));
}

/** True fuer die Ablehnung aus createGuardedLookup() ("URL resolves to a private IP address: x"). */
export function isPrivateNetworkRefusal(message) {
  return /private IP address/i.test(String(message ?? ''));
}

/**
 * Haengt der Lookup-Ablehnung den Schalter an; jede andere Meldung bleibt, wie
 * sie ist. Die nackte Hook-Meldung ist richtig, sagt aber nicht, was zu tun ist.
 */
export function withPrivateNetworkHint(message) {
  if (!isPrivateNetworkRefusal(message)) return message;
  return `${message} - ${PRIVATE_NETWORK_MESSAGE}`;
}

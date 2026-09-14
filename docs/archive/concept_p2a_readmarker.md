# P2a — setReadMarker nach dem Lesen

## Kontext
Nextcloud Talk setzt pro Raum einen Unge-Zaehler. Der Gateway pollt Chat-Nachrichten
via `OcsClient.chat.poll()`, ruft nach dem Lesen aber keinen ReadMarker. Resultat:
Nextcloud zeigt weiterhin "ungelesen", obwohl das Gateway alle Nachrichten gelesen hat.
Kosmetisch (P2), kein Produktiv-Blocker.

## Ziel
- `setReadMarker` im `OcsClient` implementieren (falls noch nicht vorhanden):
  OCS-Endpunkt fuer ReadMarker (`/chat/{token}/readMarker`, PUT/POST gemaess NC-API).
- Nach erfolgreichem Lesen (nach `chat.poll`-Verarbeitung im Poller/Adapter) den
  ReadMarker auf die letzte gelesene Message-ID setzen.
- Nur setzen, wenn eine gueltige letzte gelesene ID existiert.

## Hinweise
- NC-33-Semantics beachten (OCS `statuscode`-Regel aus S7: 200 vs. 100).
- Bestehende OCS-Methode/Nutzungsmuster in `src/adapters/nextcloud/` uebernehmen.
- Nichts an der Poll-Logik aendern, nur den Marker nach dem Lesen setzen.

## Qualität / Gates
- `vitest run` gruen, `tsc --noEmit` strict, eslint + prettier clean.
- Projektverzeichnis: ~/.pi/projects/pi-gateway

# P2b — autoDiscoverRooms / roomRefreshIntervalMs konsumieren

## Kontext
In `config`/`types` sind `autoDiscoverRooms` und `roomRefreshIntervalMs` konfiguriert,
aber im Code nicht konsumiert (Reserve fuer MVP/D2).

## Ziel
- `autoDiscoverRooms`: beim Start/Reload der Räume vorhandene Räume automatisch
  entdecken/zusätzlich überwachen (bisher nur konfiguriert).
- `roomRefreshIntervalMs`: bei Aktivierung in einem Interv Raum-Infos (/room) refreshen.
- Optionen sauber konsumieren, ohne bestehendes Verhalten zu brechen.

## Hinweise
- Bestehende Config-Integration (`config.ts`, `types.ts`) uebernehmen; Config-Override respektieren.
- Backwards-compat: Standardverhalten unveraendert, wenn Option deaktiviert/leer.
- Bestehende Poller-/Adapter-Patterns in `src/adapters/nextcloud*` uebernehmen.

## Qualität / Gates
- `vitest run` gruen, `tsc --noEmit` strict, eslint + prettier clean.
- Projektverzeichnis: ~/.pi/projects/pi-gateway

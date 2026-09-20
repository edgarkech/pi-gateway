# ADR — Bot-Allowlist & Group-Message Silence (2026-09-20)

**Status:** Umgesetzt + live verifiziert (2026-09-20)

## Kontext

Der Gateway filtert Bot-Nachrichten (actorType `bots`) seit dem Anti-Loop-Konzept
(D4/§5.3) stillschweigend — Pepe (Bot) war im Gruppenraum u4cmmzxu für den Agent
unsichtbar, obwohl Bot-zu-Bot-Kommunikation laut Gruppenraum-Regeln (SYSTEM-RPC.md
[0d]) ausdrücklich erlaubt und überwacht sein soll. Zusätzlich antwortete der
Security-Layer auf nicht-erlaubte User mit „You are not allowed to use this
agent…" — auch auf Bot-Nachrichten, was Lärm erzeugt und Antwort-Loops provozieren
kann.

## Entscheidung (Edgar, 2026-09-20)

1. **Bot-Allowlist:** Neues Config-Feld `platforms.nextcloudTalk.allowedBots`
   (Liste von Bot-ActorIds, initial Pepe `bot-2a9f834ad7c9e0462aff11033a6514dd4a45d802`).
   Gelistete Bots werden wie Menschen behandelt (Kontext + Antwort-Regel); fremde
   Bots bleiben gefiltert. Default `[]` erhält das bisherige Verhalten.
2. **Security-Layer:** Gelistete Bots umgehen den Allowlist-Check
   (message-pipeline.ts); fremde Bots werden **still verworfen** (keine Meldung —
   sie würde Lärm + Loops provozieren). `resolveUserId` löst Bots auf die stabile
   actorId auf (statt Displayname, der keine Allowlist matchen konnte).
3. **Strikte @-Adressierung:** Nur explizit `@Igor`/`@all` zählt als Adresse —
   Klartext-Nennungen („Igor") nicht (sonst würde „Hey Pepe, kannst Du Igor's
   Nachrichten lesen" als Adressierung zählen). SYSTEM-RPC.md [0d] Punkt 1
   präzisiert (Sprech-/Schweig-Disziplin).
4. **Prompt-Zeile:** Der Policy-Guard (tool-policy.ts) enthält eine
   GROUP MESSAGE RULE: Group message not addressed to you explicitly (@Igor/@all)
   → respond with an empty message (no text).

## Bekanntes Verhalten (akzeptiert, Option A)

Das aktuelle Modell (glm-5.3-flash) befolgt die „empty message"-Anweisung nicht
zuverlässig: Es antwortet mit einer kurzen Stumm-Notiz („*(Nachricht nicht an
Igor adressiert – Igor bleibt stumm gemäß Gruppenregel.)*"), die regulär in den
Raum gesendet wird. Fürs Erste akzeptiert (Edgar): Die Notiz gibt anderen
Teilnehmern implizit den Hinweis, den Bot direkt zu adressieren. Deterministische
Stille wäre als Gateway-seitiger Antwort-Filter in definierten Gruppenräumen
(`groupRooms`-Config) nachrüstbar — bewusst zurückgestellt.

## Konsequenzen

- Bot-zu-Bot-Kommunikation läuft in beide Richtungen sichtbar (live verifiziert:
  Pepe-Nachrichten im Session-Protokoll, Igor antwortet auf @Igor).
- Loop-Schutz: keine „not allowed"-Meldungen mehr an Bots; Schweig-Regel +
  [0d]-Loop-Regel (max 2 Bot-Runden) + Rate-Limit tragen das Restrisiko.
- Tests: 484 grün + 5 E2E-Skips; Commits `0e59978` (Feature), `322acd1` (Fix).

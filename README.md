# NT-LAN Voice Manager

Discord-bot for NT-LAN voice channel management.

## Miljovariabler

| Variabel | Pakrevd | Beskrivelse |
| --- | --- | --- |
| `DISCORD_TOKEN` | Ja | Bot-token fra Discord Developer Portal. |
| `DISCORD_CLIENT_ID` | Ja | Application ID fra Discord Developer Portal. |
| `DISCORD_GUILD_ID` | Ja | Server-ID til Discord-serveren boten skal registrere slash commands pa. |
| `JOIN_TO_CREATE_CHANNEL_ID` | Nei | Kanal-ID for "Lag ny kanal her", satt av `/setup-voice-manager`. |
| `CS_TEAM_CATEGORY_ID` | Nei | Kategori-ID for CS-lagkanaler, satt av `/setup-voice-manager`. |
| `CREW_LOG_CHANNEL_ID` | Nei | Tekstkanal-ID boten sender online/offline-meldinger til, f.eks. `#bot-log`. |
| `CREW_ROLE_ID` | For crew-begrensede kommandoer | Generell rolle-ID for Crew. Denne rollen og roller over den kan bruke crew-kommandoer. |
| `WELCOME_CHANNEL_ID` | Nei | Tekstkanal-ID boten sender velkomstmelding med "sett kallenavn"-knapp til nye medlemmer. |
| `MODAL_CHANNEL_ID` | Nei | Tekstkanal-ID for knappen der medlemmer registrerer kallenavn og puljer. |
| `ANNOUNCEMENT_CHANNEL_ID` | Nei | Tekstkanal-ID for matvarsler. Konfigurer kanalrettighetene i Discord slik at bare boten og arrangørene kan skrive. |
| `ENABLE_TEAM_SYNC` | Nei (standard `false`) | Slår på konkurransesynken bare når verdien er `true`. |
| `EMPTY_CHANNEL_DELETE_DELAY_MS` | Nei (standard `300000`) | Millisekunder en tom midlertidig voice-kanal star ubrukt for boten sletter den. |
| `MAT_URL` | Nei | Base-URL for konkurranse-API-et. Brukes bare når `ENABLE_TEAM_SYNC=true`. |
| `MAT_API_TOKEN` | Nei | API-token for konkurransesynken. Brukes bare når `ENABLE_TEAM_SYNC=true`. |

Ingen av disse skal ligge i kildekoden, `Dockerfile` eller Git. De settes lokalt i `.env`, eller som miljovariabler pa serveren/i Dockhand.

## Forste milepael

- Leser hemmeligheter fra lokal `.env`.
- Registrerer en guild-scoped slash command: `/ping`.
- Starter en `discord.js`-klient som kan svare i testserveren.

## Lokal oppstart

Installer Node.js 20 LTS eller nyere forst. Sjekk deretter:

```powershell
node -v
npm -v
```

Installer avhengigheter:

```powershell
npm.cmd install
```

Lag en lokal `.env` basert pa `.env.example`:

```powershell
Copy-Item .env.example .env
```

Fyll inn disse verdiene i `.env`:

- `DISCORD_TOKEN`: bot-token fra Discord Developer Portal.
- `DISCORD_CLIENT_ID`: Application ID fra Discord Developer Portal.
- `DISCORD_GUILD_ID`: ID-en til testserveren.

Ikke legg `.env` i Git, og ikke del bot-token i chat.

Registrer slash commands pa testserveren:

```powershell
npm.cmd run deploy:commands
```

Start boten lokalt:

```powershell
npm.cmd run dev
```

Hvis du far `SELF_SIGNED_CERT_IN_CHAIN`, la Node bruke Windows sitt sertifikatlager i den aktive terminalen:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
```

Hvis terminalen samtidig ikke finner `node`, legg Node-mappen inn i PATH for den aktive terminalen:

```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"
```

Kjor deretter kommandoene pa nytt:

```powershell
npm.cmd run deploy:commands
npm.cmd run dev
```

Enkleste Windows-start i dette prosjektet er a bruke de ferdige `.cmd`-filene:

```powershell
.\scripts\deploy-commands.cmd
.\scripts\dev.cmd
```

I Windows PowerShell kan `npm` bli blokkert av execution policy fordi PowerShell velger `npm.ps1`. Bruk `npm.cmd` hvis du far en slik feilmelding.

Hvis `npm.cmd` ikke finnes i terminalen etter at PATH er oppdatert, lukk den gamle terminalen og apne en ny. Du kan ogsa bruke full sti midlertidig:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run deploy:commands
& "C:\Program Files\nodejs\npm.cmd" run dev
```

Test `/ping` i Discord-testserveren.

## Test voice manager

1. Start boten med `.\scripts\dev.cmd`.
2. Kjor `/setup-voice-manager` i Discord-testserveren. Du ma ha rettighet til a administrere kanaler.
3. Kommandoen lager/finner kategorien `–KANALER` og voice-kanalen `Lag ny kanal her`.
4. Kommandoen lager/finner ogsa kategorien `–CS LAG`, som brukes senere til private CS-lagkanaler.
5. Kopier `JOIN_TO_CREATE_CHANNEL_ID=...` og `CS_TEAM_CATEGORY_ID=...` fra svaret inn i lokal `.env`.
6. Stopp boten med `Ctrl+C` og start den pa nytt med `.\scripts\dev.cmd`.
7. Bli med i `Lag ny kanal her` i Discord.
8. Boten skal lage en ny midlertidig voice-kanal under `–KANALER` og flytte deg dit.
9. Forlat den midlertidige kanalen. Den slettes etter `EMPTY_CHANNEL_DELETE_DELAY_MS` millisekunder.

Personen som lager en midlertidig kanal far automatisk `Manage Channels`-rettighet pa akkurat den kanalen. Da kan de endre kanalnavn direkte i Discord (host-menyen pa kanalen), uten a bruke noen kommando. Dette lagres av Discord, sa det overlever ogsa restart av boten.

Nar du star i en midlertidig kanal du selv har laget, kan du ogsa endre navn med kommandoen:

```text
/voice-name navn: nytt kanalnavn
```

Boten sorterer midlertidige kanaler alfabetisk under `–KANALER` etter opprettelse og navneendring.

Hvis boten restartes, rydder den automatisk ved oppstart:

- tomme voice-kanaler under `–KANALER` slettes
- voice-kanaler under `–KANALER` som fortsatt har brukere blir tatt over og overvaket videre
- `Lag ny kanal her` slettes aldri av cleanupen
- brukere som ble sittende fast i `Lag ny kanal her` mens boten var nede, far en ny midlertidig kanal og blir flyttet dit automatisk

Midlertidige kanaler far automatisk serverens gjeldende maks bitrate. Pa en ikke-boostet server blir dette Discords standard maks. Hvis testserveren boostes senere, oker bitraten automatisk uten kodeendring.

Hvis du setter `CREW_LOG_CHANNEL_ID` i `.env` til en tekstkanal-ID, f.eks. `#bot-log`, sender boten:

- en melding nar den blir online
- en melding nar den stoppes kontrollert med `Ctrl+C` eller `docker stop`

Dette dekker planlagt stopp, ikke krasj eller strombrudd. Automatisk varsling ved krasj krever et overvakingsoppsett rundt Docker/Dockhand, som vi setter opp i Docker-milepaelen.

## Kallenavn, puljeregistrering og varsler

Sett disse kanal-ID-ene i `.env`:

```env
MODAL_CHANNEL_ID=ID_FOR_REGISTRERINGSKANAL
ANNOUNCEMENT_CHANNEL_ID=ID_FOR_VARSELSKANAL
```

Publiser registreringsknappen med `/setup-kallenavn-og-puljer`. Medlemmets skjema er privat. Medlemmet velger `Matpulje 1`, `Matpulje 2`, eller at de ikke skal ha mat. Gjeldende serveringstider vises i skjemaet. Boten setter kallenavnet og gir rollen for valgt matpulje, eller rollen `Ingen mat`; dette gjør at `/matstatus` kan telle dem som ikke skal spise. Ved ny registrering byttes rollen, og gamle puljeroller som var delt per runde fjernes. Boten trenger rettighetene `Manage Nicknames` og `Manage Roles`, og botrollen må ligge over registreringsrollene.

Endre serveringstiden med `/sett-puljetid pulje: tid:`. Velg pulje 1 eller 2 og skriv tiden i 24-timersformat, for eksempel `17:30`. Tidene lagres lokalt og i Docker-volumet `meal-settings`, og brukes i modal, matstatus og varsler. Dette endrer klokkeslettet som vises; det planlegger ikke et nytt varsel automatisk.

Planlegg begge puljene samlet med `/planlegg-mat`. Modalet lar crew velge dato, serveringstid for hver pulje og uavhengig avkrysse varsler ved start, 30 minutter før og 10 minutter før. Datoen forhåndsutfylles med sist planlagte dato så lenge den ikke har passert, ellers dagens dato i tidssonen `Europe/Oslo`; tidene og sist valgte varselbokser forhåndsutfylles. Innsendingen oppdaterer også de lagrede standardtidene, datoen og varselvalgene. Planene og valgene lagres i samme Docker-volum og overlever omstart. Hvis datoen allerede har en plan, må Crew bekrefte før begge puljene erstattes. `/vis-matplan` viser kommende varsler, og `/avlys-matplan` avlyser én pulje eller begge for en dato. Varsler som er mer enn fem minutter forsinket, hoppes over. Registrerte uten mat vises separat i `/matstatus` og får ingen varsler.

Sett `CREW_ROLE_ID` til Crew-rollens ID i `.env`. `/varsle-pulje1`, `/varsle-pulje2` og `/matstatus` er tilgjengelige for medlemmer med Crew-rollen, roller over den, eller `Manage Server`. Denne generelle Crew-innstillingen kan også brukes av andre crew-begrensede botkommandoer. Varslekommandoene sender en fast melding til riktig matpulje i `ANNOUNCEMENT_CHANNEL_ID`; bare den aktuelle puljerollen blir nevnt. `/matstatus` viser antall registrerte per pulje, uten navn. Boten trenger `View Channel` og `Send Messages` i varselkanalen. Den trenger også `Mention @everyone, @here, and All Roles` for å nevne puljerollene.

For rask lokal test kan du sette dette lavere i `.env`, for eksempel:

```env
EMPTY_CHANNEL_DELETE_DELAY_MS=10000
```

## TypeScript-kort forklart

- `type ChatInputCommandInteraction` betyr at TypeScript vet hvilken type Discord-interaksjon `/ping` mottar.
- `strict: true` gjor at TypeScript stopper flere feil tidlig, for eksempel manglende miljo-variabler eller feil typer.
- Filene importerer med `.js` selv om kildefilene er `.ts`, fordi NodeNext bygger TypeScript til ekte JavaScript-moduler.
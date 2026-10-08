# NT-LAN Voice Manager

Discord-bot for NT-LAN voice channel management.

## Miljovariabler

| Variabel | Pakrevd | Beskrivelse |
| --- | --- | --- |
| `DISCORD_TOKEN` | Ja | Bot-token fra Discord Developer Portal. |
| `DISCORD_CLIENT_ID` | Ja | Application ID fra Discord Developer Portal. |
| `DISCORD_GUILD_ID` | Ja | Server-ID til Discord-serveren boten skal registrere slash commands pa. |
| `JOIN_TO_CREATE_CHANNEL_ID` | Nei | Kanal-ID for "Lag ny kanal her", satt av `/setup-voice-manager`. |
| `CS_CATEGORY_ID` | Nei | Kategori-ID for CS-lobby og bot-opprettede kamprom. |
| `CS_LOBBY_CHANNEL_ID` | Nei | Voicekanalen spillere kobler seg til for a bli flyttet til riktig CS-rom. |
| `CS_PARTICIPANT_ROLE_ID` | Nei | Rolle som gir tilgang til CS-kategorien; Crew og bot ma ogsa ha tilgang. |
| `CS_SYNC_DRY_RUN` | Nei (standard `true`) | `true` logger romplan uten Discord-endringer. `false` oppretter bot-eide rom og ruter kvalifiserte medlemmer etter startup-preflight. Roller og kategorioppsett endres aldri av boten. |
| `CS_SYNC_INTERVAL_MS` | Nei (standard `300000`) | Intervall for read-only MAT-planrapport i tørrkjøring. |
| `CS_MAIN_TOURNAMENT_ID` | Nei | MAT-ID for hovedturneringen. Tomt felt deaktiverer CS-synk til ID-en er kjent. |
| `CS_WINGMAN_TOURNAMENT_ID` | Nei | MAT-ID for Wingman-turneringen. Tomt felt deaktiverer Wingman-synk til ID-en er kjent. |
| `CS_WEBHOOK_PORT` | Nei (standard `8787`) | Privat HTTP-port for MAT-webhooks. |
| `CS_WEBHOOK_BIND_ADDRESS` | Nei (standard `127.0.0.1`) | Vertens adresse som publiserer webhook-porten; endre til privat server-IP hvis MAT ikke kan nå loopback. |
| `MAT_WEBHOOK_SECRET` | Nei | HMAC-hemmeligheten fra MAT Settings → Webhooks. Hold den utenfor Git og logger. |

CS-webhook-runtime starter med `MAT_WEBHOOK_SECRET` og registrerings-API konfigurert. Webhook-porten publiseres kun på `CS_WEBHOOK_BIND_ADDRESS` (standard loopback); sett den til en privat serveradresse MAT kan nå, og aktiver MATs private/LAN-webhookvalg. Bruk Docker-nettverkets tjenestenavn mellom containere, ikke `localhost`. HMAC verifiserer avsender, men krypterer ikke payloaden. `test: true` eventer kvitteres uten lagring eller Discord-handlinger. Kølagring er atomisk i `data/cs-webhook-events.json`; score/map-eventer kvitteres uten kølegging. Wingman-rom blir stående i persistent oppryddingskø til de er tomme. `CS_SYNC_DRY_RUN=false` krever kategori, lobby, roller, begge turnerings-ID-er, webhook secret, registrerings-API og fungerende Discord-permissions preflight. Test først i egen Discord-server.

For CS-identitet flates barn med utfylt `discordId` ut i en separat CS-deltakerliste og kobles på `steamId`. Barn uten Discord-kobling tas ikke med. Den vanlige `getParticipants()`-listen for nettstedstilgang forblir top-level foresatte, så et nestet barn får ikke automatisk generell `discord-koblet`-rolle.

`CS_PARTICIPANT_ROLE_ID` synkroniseres fra en eksplisitt `tournaments`-liste på NT-LAN-posten: `cs2` eller `cs2-wingman` gir den felles CS-rollen; en gyldig tom liste fjerner rollen og direkte tilgang til bot-eide CS-rom. Manglende felt, manglende personpost eller API-feil bevarer eksisterende tilgang. Manuelle `/cs-link`-koblinger overstyres ikke av automatisk enrollment-sync. `/cs-status` viser rolle-/Steam-tellinger uten spillerverdier.

I MAT Settings -> Webhooks settes URL til `http://<privat-adresse>:<CS_WEBHOOK_PORT>/webhooks/mat`, og den utstedte signeringshemmeligheten legges lokalt i `MAT_WEBHOOK_SECRET`. Hvis MAT er en separat container, må den og boten dele et Docker-nettverk eller MAT må bruke vertens private IP. Aktiver MAT-innstillingen for private/lokale adresser. «Send test event» skal gi HTTP 202, men blir med vilje ikke lagt i kø og utløser ingen Discord-handling. Bruk Simulation mode først med `CS_SYNC_DRY_RUN=true`; test deretter live channel/lobby routing bare i separat Discord-server.

For a kjøre test og produksjon samtidig, opprett to Dockhand-stacker med ulike stack-/Compose-prosjektnavn. Compose setter ikke fast `container_name`, og named volume blir dermed separat per stack. Teststakken ma bruke eget Discord-bot-token, testguildens kanal-/rolle-ID-er, egen MAT webhook secret og egen hostport (f.eks. `CS_WEBHOOK_PORT=8788`), mens produksjon beholder port `8787`. Bruk `CS_SYNC_DRY_RUN=false` bare i teststakken etter Simulation/tørrkjøring. `Dockerfile` er felles og trenger ingen testvariant.
| `CREW_LOG_CHANNEL_ID` | Nei | Tekstkanal-ID boten sender online/offline-meldinger til, f.eks. `#bot-log`. |
| `EMPTY_CHANNEL_DELETE_DELAY_MS` | Nei (standard `300000`) | Millisekunder en tom midlertidig voice-kanal star ubrukt for boten sletter den. |
| `MAT_URL` | Nei | HTTPS-origin for Auto Tournament API, f.eks. `https://cs.sivert.io`. |
| `MAT_API_TOKEN` | Nei | MAT read-only service-token; brukes ikke av det offentlige metadata-probe-scriptet. |

Ingen av disse skal ligge i kildekoden, `Dockerfile` eller Git. De settes lokalt i `.env`, eller som miljovariabler pa serveren/i Dockhand.

## MAT API discovery

CS-synk er ikke aktivert ennå. MAT-klienten har bare GET-operasjoner, og Discord-roller/-kanaler endres ikke. Første discovery-script kaller kun de offentlige endepunktene for fremhevet turnerings-ID og turneringsliste; det sender eller viser ikke `MAT_API_TOKEN` og viser bare turnerings-ID, type, status og lagstorrelse.

Kjor lokalt etter at `MAT_URL` er satt i `.env`:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
npm.cmd run probe:mat
```

`--use-system-ca` beholder TLS-sertifikatvalidering og lar Node bruke Windows sitt betrodde sertifikatlager. Ikke bruk `NODE_TLS_REJECT_UNAUTHORIZED=0`. For autentiserte player-oppslag ma `MAT_API_TOKEN` vaere et `API_TOKENS_READONLY`-token. Roter token som har blitt delt eller eksponert, og legg aldri verdien i terminalutskrifter eller chat.

Etter tokenrotasjon kan autentiserte GET-ruter kontrolleres uten a skrive ut spillerverdier. Sett `MAT_PROBE_DISCORD_ID` midlertidig til ID-en til en testkonto som har godkjent oppslaget; scriptet viser bare antall treff og feltnavn:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
$env:MAT_PROBE_DISCORD_ID = "<testkontoens Discord-ID>"
$env:MAT_PROBE_STEAM_ID = "<testkontoens SteamID64>"
npm.cmd run probe:mat-readonly
Remove-Item Env:NODE_OPTIONS
Remove-Item Env:MAT_PROBE_DISCORD_ID
Remove-Item Env:MAT_PROBE_STEAM_ID
```

Scriptet kaller bare `GET /api/teams` og, nar test-ID er satt, `GET /api/players/by-discord-id/:discordId`. Steam-ID-en sammenlignes lokalt mot teamenes `players`-felt; utskriften viser kun antall treff og feltnavn. Ikke kjør det med det tidligere eksponerte tokenet.

For a sjekke om NT-LAN-registrerings-API-et ogsa inneholder Steam-felt, kjør `npm.cmd run probe:registration-steam`. Scriptet bruker eksisterende client-credentials kun for tokenutveksling, henter deltakerlisten med GET og viser bare deltakerantall, Steam-feltnavn og antall deltakere med utfylt Steam-verdi. Det viser ikke deltaker-ID-er eller personverdier.

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

Uten aktiv tilgangskontroll far kanaleieren `Manage Channels` pa den midlertidige kanalen. Med aktiv tilgangskontroll brukes bare `/voice-name`, slik at kanalrettighetene ikke kan endres av vanlige medlemmer. Eierskapet lagres i `data/voice-owners.json` og Docker-volumet `bot-data` for a overleve omstart.

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

For rask lokal test kan du sette dette lavere i `.env`, for eksempel:

```env
EMPTY_CHANNEL_DELETE_DELAY_MS=10000
```

## Nettsidekobling, kallenavn og tilgang

Tilgang er basert pa verifisert Discord-kobling, ikke pa deltakelse i et bestemt LAN. API-et ma inkludere alle koblede brukere, ogsa de som ikke er pameldt arets arrangement. Discord-ID er API-nokkel og behandles som tekst. Discord-kallenavnet settes til fornavn fulgt av initial for hvert resterende navneledd, for eksempel `Silje M. K.`.

API-formatet er `{ "data": { "participants": { "DISCORD_ID": { "name": "Fullt navn", "firstName": "Fornavn" } } } }`. Noklene behandles som tekst; `discordUsername`, `crew`, `admin`, `days`, `meals` og `children` brukes ikke til autorisasjon. Nettsiden ma ha verifisert Discord-ID-en gjennom Discord-innlogging. API-klienten bruker client credentials med `scope=openid`, fornyer token automatisk og prover en gang til ved 401. API-kall har tidsgrense og samtidige kall samles.

### Nye miljovariabler

| Variabel | Beskrivelse |
| --- | --- |
| `ACCESS_CHANNEL_ID` | Tekstkanal for inngangsmeldingen. |
| `ACCESS_ROLE_ID` | Egen tilgangsrolle under bade bot og Crew. Du bestemmer rettighetene i Discord; administrative rettigheter varsles uten a stoppe boten. |
| `CREW_ROLE_ID` | Crew-rolle; denne og roller over den gir tilgang uten nettsidekobling. Administrator og servereier unntas ogsa. |
| `REGISTRATION_URL` | HTTPS-lenken medlemmene apner for a logge inn/koble Discord. |
| `REGISTRATION_API_URL` | HTTPS-adressen for deltakerobjektet. |
| `REGISTRATION_TOKEN_URL` | HTTPS-adressen for tokenutstedelse. |
| `REGISTRATION_CLIENT_ID` | Klient-ID, normalt `discord-bot`. |
| `REGISTRATION_CLIENT_SECRET` | Hemmelig klientnokkel. Aldri i Git eller logger. |
| `ACCESS_DRY_RUN` | Standard `true`: ingen navne-, rolle-, meldings- eller rettighetsendringer fra tilgangskontrollen. Eksisterende voice-funksjoner fortsetter som normalt. |
| `ACCESS_SYNC_INTERVAL_MS` | Standard `15000`: intervall for automatisk kontroll av tilgang og kallenavn. Sett høyere hvis API-et har strenge rategrenser. |

Alle fire API-/token-/klientinnstillinger ma fylles ut sammen. Nar de er tomme, er tilgangskontrollen av. Nar API-et er konfigurert, kreves kanal, roller og nettsidelenke. MAT-variablene i eksempelfilen er reservert; det er ingen MAT- eller matfunksjon i denne implementasjonen.

### Oppstart pa testserver

1. Roter eventuelle tidligere delte hemmeligheter. Fyll ut API-innstillingene og nye Discord-ID-er lokalt uten a dele verdiene.
2. Opprett en tilgangsrolle med de medlemsrettighetene du onsker, plassert under bade botrollen og Crew. Sett `ACCESS_ROLE_ID`. Boten endrer aldri rollens serverrettigheter.
3. Aktiver **Server Members Intent** under Bot i Discord Developer Portal. Boten trenger `Manage Nicknames`, `Manage Roles`, samt eksisterende voice-rettigheter. I inngangskanalen trenger den `View Channel`, `Send Messages` og `Read Message History`.
4. Sett kanalrettighetene manuelt i Discord som beskrevet nedenfor. Det finnes ingen kategoriliste eller automatisk kanalbeskyttelse i boten.
5. Behold `ACCESS_DRY_RUN=true`. Kjor `npm.cmd test`, `npm.cmd run deploy:commands` og `npm.cmd run dev`. Loggen viser bare summerte kontrollresultater, ikke navn eller API-payloads.
6. Kjor `/setup-access` i torrkjoring. Standard synlighet for kommandoen er Manage Server; gi Crew tilgang under serverens integrasjonsinnstillinger hvis nodvendig.
7. Nar testresultatene er riktige, sett `ACCESS_DRY_RUN=false` og start boten pa nytt. Navn og tilgangsroller synkroniseres da automatisk. Kjor `/setup-access` for a publisere/oppdatere inngangsmeldingen uten a endre kanalrettighetene.
8. Test med et vanlig medlem uten crew/admin: inngangskanalen synlig for uverifiserte, navn satt for rolle tildeles, beskyttede kanaler synlige etterpa og inngangskanalen skjult. Test ogsa API-feil, omstart, voice og en Discord-koblet bruker uten arets pamelding.

Inngangsmeldingen har nettsidelenke og **Sjekk tilgang**-knapp. Knappen gir et privat svar. Discord-kallenavnet settes til fornavn fulgt av initial for hvert resterende navneledd, for eksempel `Silje M. K.`; sammensatt fornavn beholdes slik API-et oppgir det. Boten retter koblede medlemmers manuelle kallenavnsendringer umiddelbart via Discords medlemsoppdatering, med periodisk synk som reserve. For å unngå at Discord viser navnet som en kortvarig endring før boten retter det, fjern `Change Nickname` fra `@everyone` og alle vanlige medlemsroller. Behold nødvendige navne-/administratorrettigheter for Crew. Discords rollepermissions er kumulative, så kontroller alle roller medlemmet har. Hvis navnet mangler, ikke matcher fornavnet, inneholder ugyldige tegn eller overskrider Discords 32-tegnsgrense etter forkorting, må Crew hjelpe. Crew beholder tilgang uten kobling/navn; deres navn oppdateres bare hvis API-et har dem og boten kan endre medlemmet. Høyere roller og servereier må sette navn selv.

### Nødkommandoer

Crew-only slash commands: `/giveaccess person kallenavn` stores a manual nickname/access-role override that automatic registration sync preserves; the person option suggests server members without the access role. `/clearaccessoverride person` removes the override and returns the member to automatic sync. `/cs-link person steamid64` grants the CS participant role and stores a manual Discord-to-Steam link for MAT room routing. `/cs-unlink person` removes only that mapping and intentionally leaves the CS role unchanged. `/cs-status` checks webhook health, tournament IDs/formats, Discord permissions and the Steam-linked participant count; it prints no secrets or player IDs. CS links do not grant the normal website access role. Overrides are stored locally in `data/manual-access-overrides.json`, excluded from Git, and must be removed explicitly.

### Kanalrettigheter

Rettigheter settes én gang per kategori, ikke per kanal. I hver kategori synkroniser kanalene med kategorien; en usynkronisert kanal kan overstyre kategoriens regler. Kanaler uten kategori må konfigureres separat. `discord-koblet` kan ha vanlige medlemsrettigheter globalt, men kategori-overstyringer bestemmer unntakene.

| Kategori / område | `@everyone` | `discord-koblet` | Andre roller |
| --- | --- | --- | --- |
| `Start her` med `#få-tilgang` | Tillat **Vis kanal** og **Les meldingshistorikk**; nekt **Send meldinger** hvis kanalen skal være skrivebeskyttet | Nekt **Vis kanal** | Crew og bot tillates ved behov |
| Vanlige medlemskategorier: info, chat og voice | Nekt **Vis kanal** | Tillat **Vis kanal** | Crew/ledelse og bot tillates |
| Kategorien med `Lag ny kanal her` | Eksplisitt nekt **Vis kanal** | Eksplisitt tillat **Vis kanal** | Crew og bot tillates |
| Privat Crew-kategori | Nekt **Vis kanal** | Nekt **Vis kanal** | Crew og godkjent ledelse tillates; bot tillates |
| `CS-konkurranse` | Nekt **Vis kanal** | Nekt hvis alle verifiserte ikke skal inn | `CS-deltaker`, Crew og bot tillates |

**Voice-sjekken:** Koden kontrollerer foreldrekategorien til kanalen med `JOIN_TO_CREATE_CHANNEL_ID`. Der må både `@everyone`-nektelsen og `discord-koblet`-tillatelsen være eksplisitte på kategorien; globale rolletillatelser eller overstyringer på selve voice-kanalen er ikke nok. Nye midlertidige kanaler kopierer kategoriens regler. Botrollen må i tillegg ha kanaltilgang og `Manage Channels` der den oppretter/flytter voice-kanaler.

**Foreslått global standard:** `@everyone` får ikke **Vis kanaler** i rolleinnstillingene, mens `discord-koblet` får det. Kategoriene `Start her`, `Crew` og `CS-konkurranse` overstyrer dette som vist i tabellen. Discord kombinerer overstyringer fra andre roller og personunntak; kontroller dem hvis noen ser en kanal de ikke skal se. Serveradministratorer omgår skjulte kanaler.

Crew har tilgang uten API-kobling. Hvis boten skal oppdatere Crew-kallenavn, må botrollen ligge over Crew og ha `Manage Nicknames`; boten har ikke automatisk Administrator. Tilgangsrollen må ligge under botrollen for at boten skal kunne tildele/fjerne den.

`/setup-access` endrer ikke kanalrettigheter. Den publiserer eller oppdaterer botens melding i `ACCESS_CHANNEL_ID`. Den søker blant de siste 100 meldingene etter botens melding med tilgangsknappen; hvis den ikke finner den, sender den en ny.

### Oppdatere innloggingslenken

`REGISTRATION_URL` leses når botprosessen starter. Etter endring i lokal `.env` må du stoppe og starte `scripts/dev.cmd` på nytt. Når boten kjører med `ACCESS_DRY_RUN=false`, kjør `/setup-access` igjen; eksisterende melding oppdateres med ny lenke. Kommandoens svar viser nå URL-en som ble brukt. Ved kjøring i Dockhand må miljøvariabelen oppdateres og containeren gjenskapes/synkes, ikke bare restartes, før `/setup-access` kjøres. Tørrkjøring publiserer eller oppdaterer ikke meldingen.

### Tilgangssynk og feilsøking

Et vellykket og formatvalidert API-svar brukes som koblingsliste. Mangler en vanlig brukers Discord-ID i et vellykket svar, fjernes tilgangsrollen ved neste kontroll (`revoked`). Crew, roller over Crew, administratorer og servereier unntas. Kallenavnet tilbakestilles ikke; `ACCESS_DRY_RUN=true` fjerner ingen roller.

API-nedetid, HTTP-feil, tidsavbrudd og ugyldig svarformat fjerner ikke eksisterende roller. En vellykket tom liste regnes derimot som gyldig og kan fjerne tilgang for alle vanlige medlemmer. API-et må derfor returnere en komplett liste over alle koblede Discord-kontoer. Forespørsler, rolletildeling og voice-oppretting feiler trygt hvis API eller rolleoppsett ikke kan kontrolleres. Fjerning av rolle kobler ikke automatisk en allerede aktiv voice-forbindelse fra.

### Docker og utrulling

Docker Compose videresender de nye variablene og lagrer sikkerhetskopi/voice-eierskap i `bot-data:/app/data`. Eksisterende bind-mounts/volumer ma vaere skrivbare for containerens `node`-bruker. Oppdater variablene i Dockhand, bygg nytt image og gjenskap containeren gjennom eksplisitt sync. Vanlig restart bruker gammelt image. Slash-kommandoer registreres separat; Docker starter bare boten.

Ved overgang fra eldre branch-builds, slett bare den genererte `dist`-mappen for ny build sa gamle JavaScript-filer ikke blir liggende igjen. `npm.cmd run dev` bruker `src` direkte.

## TypeScript-kort forklart

- `type ChatInputCommandInteraction` betyr at TypeScript vet hvilken type Discord-interaksjon `/ping` mottar.
- `strict: true` gjor at TypeScript stopper flere feil tidlig, for eksempel manglende miljo-variabler eller feil typer.
- Filene importerer med `.js` selv om kildefilene er `.ts`, fordi NodeNext bygger TypeScript til ekte JavaScript-moduler.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccessResult } from "./accessManager.js";

export interface BotMessages {
  access: {
    entry: string;
    openWebsiteLabel: string;
    checkAccessLabel: string;
    button: Record<AccessResult | "wrongServer" | "checkFailed", string>;
  };
  cs: {
    notifications: Record<string, { label: string; template: string; required: string[] }>;
  };
  commands: Record<string, string>;
  logs: Record<string, string>;
}

const defaultCsNotifications = {
  "turnering-snart": {
    label: "Turnering starter snart",
    template: "Turneringen {competition} starter om {minutes} minutter. Bli med i {lobby}, så blir du sendt videre automatisk.",
    required: ["minutes", "lobby"]
  },
  "turnering-na": {
    label: "Turnering starter nå",
    template: "Turneringen {competition} starter nå. Bli med i {lobby}, så blir du sendt videre automatisk.",
    required: ["lobby"]
  },
  "kamp-ferdig": {
    label: "Kamp ferdig med resultat",
    template: "Kampen i {competition} er ferdig. Resultat: {score}.",
    required: ["score"]
  }
} satisfies BotMessages["cs"]["notifications"];

const defaultCommandMessages: Record<string, string> = {
  "common.guildOnly": "Denne kommandoen kan bare brukes på en server.",
  "botSettings.notConfigured": "Bot-innstillinger er ikke konfigurert for denne serveren.",
  "botSettings.crewOnly": "Bare Crew og høyere kan endre bot-innstillinger.",
  "botSettings.notLoaded": "Bot-innstillinger er ikke lastet ennå.",
  "botSettings.title": "Bot-innstillinger",
  "botSettings.feature.access": "Nettside-tilgang",
  "botSettings.feature.normalVoice": "Vanlig voice",
  "botSettings.feature.csRoles": "CS-rolletildeling",
  "botSettings.feature.csVoice": "CS-voice",
  "botSettings.state.on": "på",
  "botSettings.state.off": "av",
  "botSettings.mode.direct": "direkte",
  "botSettings.mode.live": "live",
  "botSettings.mode.preview": "forhåndsvisning",
  "botSettings.incomplete": "Velg både funksjon og aktiv-status, eller kjør /bot-settings uten valg for å se status.",
  "botSettings.statusLine": "{feature}: {status}",
  "botSettings.changed": "{feature} er {status}.{followUp}",
  "botSettings.previewFollowUp": " Kontroller forhåndsvisningen i Dockhand-loggen. Når den ser riktig ut, kjør kommandoen på nytt med bekreft_live:true.",
  "botSettings.csVoiceMissingConfig": "Kan ikke starte CS-voice. Mangler konfigurasjon: {missing}",
  "botSettings.failed": "Kunne ikke endre bot-innstillingen.",
  "cleanCsVc.notConfigured": "CS_CATEGORY_ID og CREW_ROLE_ID må være konfigurert.",
  "cleanCsVc.crewOnly": "Bare Crew og høyere kan rydde CS-rom.",
  "cleanCsVc.categoryMissing": "CS_CATEGORY_ID peker ikke på en kategori.",
  "cleanCsVc.preview": "Dette vil slette {count} voice-rom i CS-kategorien. Lobbyen beholdes.\n{rooms}\nIngen endringer er gjort. Kjør igjen med bekreft:true og previewkode:{previewCode} innen 5 minutter.",
  "cleanCsVc.empty": "Fant ingen CS-voice-rom å slette. Lobbyen og alle andre kategorier er urørt.",
  "cleanCsVc.previewExpired": "Forhåndsvisningen mangler, er utløpt eller romlisten er endret. Kjør kommandoen uten bekreftelse for å lage en ny.",
  "cleanCsVc.noPermission": "Boten mangler Manage Channels i CS-kategorien.",
  "cleanCsVc.complete": "Slettet {count} voice-rom i CS-kategorien. Lobbyen og andre kategorier er urørt.",
  "cleanCsVc.failed": "Kunne ikke fullføre CS-oppryddingen. Kontroller botens rettigheter i CS-kategorien.",
  "clearAccessOverride.notConfigured": "Manuelle tilgangsoverstyringer er ikke konfigurert for denne serveren.",
  "clearAccessOverride.crewOnly": "Bare Crew og høyere kan fjerne manuelle tilgangsoverstyringer.",
  "clearAccessOverride.confirm": "Ingen endringer gjort. Kjør kommandoen igjen med bekreft:true for å fjerne den manuelle tilgangen.",
  "clearAccessOverride.removed": "Manuell overstyring fjernet for <@{userId}>. Automatisk synk har fått kontrollen tilbake.",
  "clearAccessOverride.notFound": "Fant ingen manuell overstyring for <@{userId}>.",
  "clearAccessOverride.failed": "Kunne ikke fjerne overstyringen.",
  "csGiveAccess.notConfigured": "MANUAL_CS_PARTICIPANT_ROLE_ID og CREW_ROLE_ID må være konfigurert.",
  "csGiveAccess.crewOnly": "Bare Crew og høyere kan endre manuell CS-tilgang.",
  "csGiveAccess.cannotManage": "Manuell CS-rolle må være håndterbar av boten, og målet må være under botrollen.",
  "csGiveAccess.complete": "Manuell CS-tilgang {action} <@{userId}>. Automatisk CS-rolle ble ikke endret.",
  "csGiveAccess.failed": "Kunne ikke endre manuell CS-tilgang.",
  "csLink.notConfigured": "CS-link er ikke konfigurert for denne serveren.",
  "csLink.crewOnly": "Bare Crew og høyere kan opprette CS-lenker.",
  "csLink.invalidInput": "Velg et vanlig servermedlem og en gyldig SteamID64.",
  "csLink.cannotManage": "CS-rollen må være håndterbar av boten, og målmedlemmet må være under botrollen.",
  "csLink.complete": "<@{userId}> er koblet til Steam-spilleren for CS. MAT bestemmer fortsatt hvilket lag/rom som brukes.",
  "csLink.failed": "Kunne ikke opprette CS-lenken.",
  "csStatus.notConfigured": "CS-status er ikke konfigurert for denne serveren.",
  "csStatus.crewOnly": "Bare Crew og høyere kan se CS-status.",
  "csStatus.actorFailed": "Kunne ikke bekrefte Crew-tilgang for CS-status.",
  "csStatus.title": "CS-status",
  "csStatus.line": "{result} · {label}: {detail}",
  "csStatus.result.ok": "OK",
  "csStatus.result.missing": "MANGLER",
  "csStatus.result.error": "FEIL",
  "csStatus.result.dryRun": "DRY-RUN",
  "csStatus.label.voice": "CS voice-sync",
  "csStatus.label.roles": "CS-rolletildeling",
  "csStatus.label.webhookSecret": "Webhook-secret",
  "csStatus.label.registration": "Registration API",
  "csStatus.label.discord": "CS Discord-oppsett",
  "csStatus.label.tournamentIds": "Turnerings-ID-er",
  "csStatus.label.receiver": "Webhook-mottaker",
  "csStatus.label.tournaments": "MAT-turneringer",
  "csStatus.label.mainFormat": "Main-format",
  "csStatus.label.wingmanFormat": "Wingman-format",
  "csStatus.label.matApi": "MAT API",
  "csStatus.label.matToken": "MAT API-token",
  "csStatus.label.steamLinks": "Steam-koblinger",
  "csStatus.detail.voicePaused": "pauset i /bot-settings",
  "csStatus.detail.voicePreview": "forhåndsvisning; ingen rom eller medlemmer endres",
  "csStatus.detail.voiceLive": "webhook kan opprette rom og flytte medlemmer",
  "csStatus.detail.rolesPaused": "pauset i /bot-settings",
  "csStatus.detail.rolesPreview": "forhåndsvisning; ingen roller endres",
  "csStatus.detail.rolesLive": "automatisk rolle-sync aktiv",
  "csStatus.detail.configured": "konfigurert",
  "csStatus.detail.webhookMissing": "MAT_WEBHOOK_SECRET mangler",
  "csStatus.detail.registrationConfigured": "konfigurert",
  "csStatus.detail.registrationMissing": "en eller flere REGISTRATION_* mangler",
  "csStatus.detail.discordConfigured": "kategori, lobby, automatiske/manuelle CS-roller og Crew-rolle konfigurert",
  "csStatus.detail.discordMissing": "CS_CATEGORY_ID, CS_LOBBY_CHANNEL_ID, CS_PARTICIPANT_ROLE_ID, MANUAL_CS_PARTICIPANT_ROLE_ID eller CREW_ROLE_ID mangler",
  "csStatus.detail.receiverListening": "lytter på port {port}",
  "csStatus.detail.receiverStatus": "healthcheck svarte {status}",
  "csStatus.detail.receiverFailed": "ikke nåbar lokalt; kontroller at runtime startet og porten er riktig",
  "csStatus.detail.tournaments": "Main: {main}; Wingman: {wingman}",
  "csStatus.detail.tournamentCandidate": "ID {id} {type}/{status}/size {size}",
  "csStatus.detail.tournamentAmbiguous": "{count} mulige turneringer",
  "csStatus.detail.noActiveTournament": "ingen aktiv turnering",
  "csStatus.result.ambiguous": "TVETYDIG",
  "csStatus.detail.tournamentNotFound": "ID ikke funnet",
  "csStatus.detail.mainFormatMismatch": "forventet lagturnering med 5 spillere; fikk {type}, size {size}",
  "csStatus.detail.wingmanFormatMismatch": "forventet shuffle med 2 spillere; fikk {type}, size {size}",
  "csStatus.detail.matApiFailed": "turneringslisten kunne ikke leses med MAT_URL/MAT_API_TOKEN",
  "csStatus.detail.matUrlMissing": "MAT_URL mangler",
  "csStatus.detail.matTokenConfigured": "konfigurert",
  "csStatus.detail.matTokenMissing": "MAT_API_TOKEN mangler",
  "csStatus.detail.participantsFailed": "deltakerlisten kunne ikke leses",
  "csStatus.detail.steamCounts": "{mapped} av {participants} CS-deltakere har SteamID64",
  "csStatus.detail.permissionsValid": "kategori, lobby, roller, Manage Channels og Move Members validert",
  "csStatus.detail.permissionsFailed": "Discord-rettighetskontrollen feilet; se Dockhand-loggen.",
  "csUnlink.notConfigured": "CS-link er ikke konfigurert for denne serveren.",
  "csUnlink.crewOnly": "Bare Crew og høyere kan fjerne CS-lenker.",
  "csUnlink.removed": "Den manuelle Steam-koblingen for <@{userId}> er fjernet. CS-rollen endres ikke.",
  "csUnlink.notFound": "Fant ingen manuell CS-kobling for <@{userId}>.",
  "csUnlink.failed": "Kunne ikke fjerne CS-lenken.",
  "giveAccess.notConfigured": "Manuell tilgang er ikke konfigurert for denne serveren.",
  "giveAccess.crewOnly": "Bare Crew og høyere kan gi manuell tilgang.",
  "giveAccess.botTarget": "Botkontoer kan ikke få manuell servertilgang.",
  "giveAccess.websiteRoleExists": "Medlemmet har allerede den verifiserte nettsidetilgangsrollen (discord-koblet).",
  "giveAccess.manualRoleExists": "Medlemmet har allerede den manuelle tilgangsrollen. Bruk /clearaccessoverride hvis den skal fjernes først.",
  "giveAccess.exempt": "Medlemmet er Crew, administrator eller har en rolle over Crew og er allerede unntatt fra tilgangssynken.",
  "giveAccess.invalidMember": "Velg et medlem fra forslagene.",
  "giveAccess.confirm": "Ingen endringer gjort. Kjør kommandoen igjen med bekreft:true for å gi manuell tilgang.",
  "giveAccess.complete": "Manuell tilgang og kallenavnet «{nickname}» er lagret for <@{userId}>. Bruk /clearaccessoverride for å gi automatisk sync kontrollen tilbake.",
  "giveAccess.failed": "Kunne ikke gi manuell tilgang.",
  "makeTeamChats.notConfigured": "CS-rom er ikke konfigurert for denne serveren.",
  "makeTeamChats.crewOnly": "Bare Crew og høyere kan opprette CS-rom.",
  "makeTeamChats.apiNotConfigured": "MAT-, turnerings- og Registration-innstillinger må være konfigurert først.",
  "makeTeamChats.tournamentAmbiguous": "MAT har flere aktive turneringer med dette formatet. Bot-handlinger er pauset til Crew kan velge én.",
  "makeTeamChats.noActiveTournament": "Fant ingen aktiv MAT-turnering for dette formatet.",
  "makeTeamChats.formatMismatch": "MAT-turneringens format stemmer ikke med valget. Ingen rom ble opprettet.",
  "makeTeamChats.rolesMissing": "CS_CATEGORY_ID, CS_PARTICIPANT_ROLE_ID og MANUAL_CS_PARTICIPANT_ROLE_ID må være konfigurert.",
  "makeTeamChats.categoryMissing": "CS_CATEGORY_ID peker ikke på en kategori.",
  "makeTeamChats.preview": "{description} Ingen Discord-endringer er gjort. Kjør igjen med bekreft:true og previewkode:{previewCode} innen 5 minutter.",
  "makeTeamChats.previewExpired": "Forhåndsvisningen mangler, er utløpt eller MAT-planen er endret. Kjør kommandoen uten bekreftelse for å lage en ny.",
  "makeTeamChats.noPermission": "Boten mangler Manage Channels i CS-kategorien.",
  "makeTeamChats.complete": "{description} Opprettet {createdCount} rom. Rommene er manuelt opprettet og endres ikke av automatisk CS-synk.",
  "makeTeamChats.failed": "Kunne ikke hente turneringsplanen eller opprette CS-rom. Ingen rå MAT-data er logget.",
  "makeTeamChats.competition.main": "Hovedturnering",
  "makeTeamChats.competition.wingman": "Wingman",
  "makeTeamChats.summary": "{competition}: {plannedCount} gyldige lagrom, {missingCount} mangler, {skippedCount} utelatt på grunn av ufullstendige data.",
  "notifyCsParticipants.notConfigured": "CS-varsling er ikke konfigurert for denne serveren.",
  "notifyCsParticipants.crewOnly": "Bare Crew og høyere kan sende CS-varsler.",
  "notifyCsParticipants.wrongChannel": "Velg en tekstkanal på denne serveren.",
  "notifyCsParticipants.rolesMissing": "CS_PARTICIPANT_ROLE_ID og MANUAL_CS_PARTICIPANT_ROLE_ID må være konfigurert for ping.",
  "notifyCsParticipants.noPermission": "Boten mangler Send Messages i valgt kanal.",
  "notifyCsParticipants.preview": "Forhåndsvisning for <#{channelId}>:\n{message}\n\nIngen melding er sendt. Kjør igjen med bekreft:true og previewkode:{previewCode} innen 5 minutter.",
  "notifyCsParticipants.previewExpired": "Forhåndsvisningen mangler, er utløpt eller meldingen er endret. Lag en ny forhåndsvisning.",
  "notifyCsParticipants.sent": "CS-varselet er sendt.",
  "notifyCsParticipants.missingValues": "Denne malen trenger flere verdier. Fyll ut minutter, venterom eller resultat og prøv igjen.",
  "notifyCsParticipants.failed": "Kunne ikke sende CS-varselet. Kontroller mal, kanal og botens tillatelser.",
  "ping.response": "Pong! WebSocket: {ping} ms",
  "reloadMessages.notConfigured": "Meldingskatalogen er ikke konfigurert for denne serveren.",
  "reloadMessages.crewOnly": "Bare Crew og høyere kan laste inn meldinger på nytt.",
  "reloadMessages.loaded": "messages.json er lastet inn på nytt.",
  "reloadMessages.fallback": "messages.json kunne ikke leses; innebygde standardmeldinger brukes.",
  "setupAccess.notConfigured": "Tilgangskontrollen er ikke konfigurert for denne serveren.",
  "setupAccess.crewOnly": "Bare Crew og høyere kan bruke denne kommandoen.",
  "setupAccess.confirmRestore": "Denne handlingen endrer kanalrettigheter. Bruk bekreft:true etter at oppsettet er kontrollert.",
  "setupAccess.dryRun": "Tørrkjøring fullført. Ingen meldinger eller kanalrettigheter ble endret.",
  "setupAccess.restored": "Rettigheter gjenopprettet for {count} kanaler. Navn og roller er ikke tilbakestilt.",
  "setupAccess.published": "Inngangsmeldingen er publisert med nettsidelenken {websiteUrl}. Kanalrettighetene administreres manuelt i Discord og er ikke endret.",
  "setupAccess.failed": "Oppsettet feilet.",
  "setupVoiceManager.ready": "Voice manager er satt opp.\nLegg disse verdiene i .env:\nJOIN_TO_CREATE_CHANNEL_ID={joinChannelId}\nCS_CATEGORY_ID={csCategoryId}",
  "setupVoiceManager.created": "Voice manager er satt opp.",
  "setupVoiceManager.envIntro": "Legg disse verdiene i .env:",
  "setupVoiceManager.guildOnly": "Denne kommandoen kan bare brukes på en server.",
  "voiceName.guildOnly": "Denne kommandoen kan bare brukes på en server.",
  "voiceName.notInVoice": "Du må stå i voice-kanalen du vil endre navn på.",
  "voiceName.changed": "Kanalnavnet er endret til {channelName}.",
  "voiceName.failed": "Kunne ikke endre kanalnavnet.",
  "voiceName.notTemporary": "Du må stå i en midlertidig voice-kanal som boten har laget.",
  "voiceName.notOwner": "Bare personen som laget kanalen kan endre navnet.",
  "voiceName.ownerUnknown": "Kanaleieren er ikke kjent etter omstart. Kontakt Crew for navneendring.",
  "voiceName.empty": "Kanalnavnet kan ikke være tomt.",
  "index.accessPaused": "Automatisk nettsidekontroll er pauset. Kontakt Crew for manuell tilgang.",
  "index.commandFailed": "Noe gikk galt da /{command} skulle kjøres."
};

const defaultLogMessages: Record<string, string> = {
  "bot.online": "NT-LAN Voice Manager er online.",
  "bot.offline": "NT-LAN Voice Manager går offline (planlagt stopp).",
  "setupAccess.failed": "Access setup failed; check configuration and access-channel permissions.",
  "access.nicknameSet": "Nettsidetilgang: satte kallenavnet for `{username}` til `{nickname}`.",
  "access.websiteRoleGranted": "Nettsidetilgang: ga `{username}` den verifiserte tilgangsrollen.",
  "access.manualRoleGranted": "Manuell nettsidetilgang: ga `{username}` den manuelle tilgangsrollen.",
  "access.manualRolePromoted": "Nettsidetilgang: overførte `{username}` fra manuell til verifisert tilgang.",
  "access.websiteRoleRevoked": "Nettsidetilgang: fjernet den verifiserte tilgangsrollen fra `{username}`.",
  "access.manualRoleRevoked": "Manuell nettsidetilgang: fjernet den manuelle rollen fra `{username}`.",
  "access.manualGranted": "Manuell servertilgang gitt med /giveaccess.",
  "access.manualCleared": "Manuell servertilgang fjernet; automatisk kontroll er gjenopptatt for medlemmet.",
  "cs.manualAccess": "Manuell CS-tilgang {action}.",
  "cs.linkCreated": "Manuell CS-deltakeradgang og Steam-kobling opprettet.",
  "cs.linkRemoved": "Manuell Steam-identitetskobling fjernet; CS-deltakerrollen ble beholdt.",
  "cs.roomsCleaned": "CS-voiceopprydding fullført: {count} rom slettet; lobby beholdt.",
  "cs.roomsCreated": "Manuell CS-romoppretting: {competition}, opprettet {createdCount}, allerede til stede {existingCount}.",
  "cs.notificationSent": "CS-varsling sendt: {competition}, mal {preset}, ping {ping}.",
  "messages.reloaded": "Meldingskatalog lastet på nytt: {status}.",
  "settings.normalVoice": "Vanlig join-to-create voice {status}.",
  "settings.accessPaused": "Automatisk nettsidetilgang pauset; manuell /giveaccess er fortsatt tilgjengelig.",
  "settings.accessState": "Automatisk nettsidetilgang {status}.",
  "settings.csRoles": "CS-rolletildeling {status}.",
  "settings.csVoice": "CS-voice {status}.",
  "access.summary": "Nettsidetilgangssynk ({mode}): {counts}.",
  "cs.roleSummary": "CS-rolletildeling ({mode}): {enrolled} påmeldte, {added} lagt til, {removed} fjernet, {missing} uten påmeldingsdata.",
  "cs.webhookSummary": "CS webhook {tournament} {eventType}: {planned} rom i plan, {updated} oppdatert, {skipped} lag utelatt.",
  "cs.recoverySummary": "CS recovery-forhåndsvisning: {main} main-rom, {wingman} Wingman-rom, {unmatched} uten kobling.",
  "voice.channelCreated": "Vanlig midlertidig voice-kanal opprettet og eier flyttet inn.",
  "voice.channelDeleted": "Tom vanlig midlertidig voice-kanal slettet."
};

const allowedNotificationValues = new Set(["competition", "minutes", "lobby", "score"]);

const defaultMessages: BotMessages = {
  access: {
    entry: [
      "👋 Velkommen til NTLAN!",
      "For å få tilgang må Discord-kontoen din være koblet til NTLAN-kontoen din på ntlan.no.",
      "Trykk «Åpne nettsiden» for å logge inn og koble til. Når det er gjort, trykker du «Sjekk tilgang» her.",
      "Discord-kallenavnet ditt settes til fornavn og initialer for resten av navnet.",
      "Er du under 18? Foreldrene dine har fått innloggingen din på e-post."
    ].join("\n\n"),
    openWebsiteLabel: "Åpne nettsiden",
    checkAccessLabel: "Sjekk tilgang",
    button: {
      wrongServer: "Denne knappen gjelder ikke denne serveren.",
      exempt: "Du har tilgang gjennom Crew eller en høyere rolle. Oppdater kallenavnet selv hvis boten ikke kan endre det.",
      "not-linked": "Vi fant ikke Discord-koblingen din. Logg inn på nettsiden og prøv igjen. Du trenger ikke være påmeldt årets LAN. Kontakt Crew hvis du allerede har koblet kontoen.",
      revoked: "Vi finner ikke lenger Discord-koblingen din. Tilgangsrollen er fjernet. Koble Discord til på nettsiden for å få tilgang igjen.",
      "manual-name": "Navnet kan ikke brukes automatisk som kallenavn. Kontakt Crew for hjelp.",
      "cannot-rename": "Boten kan ikke endre kallenavnet ditt. Kontakt Crew for hjelp.",
      "dry-run": "Kontrollen er fullført i testmodus. Ingen navn eller roller er endret.",
      "dry-run-linked": "Discord-koblingen din er funnet. Tilgangssynken står i forhåndsvisning, så navnet og rollene dine er ikke endret ennå. Crew må bekrefte live i /bot-settings.",
      verified: "Kallenavnet er oppdatert, og du har tilgang til serveren.",
      "manual-override": "Crew har gitt deg tilgang manuelt med kallenavnet som ble valgt.",
      checkFailed: "Kunne ikke fullføre kontrollen akkurat nå. Prøv igjen senere eller kontakt Crew."
    }
  },
  cs: { notifications: defaultCsNotifications },
  commands: defaultCommandMessages,
  logs: defaultLogMessages
};

let activeMessages = defaultMessages;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function parseBotMessages(value: unknown): BotMessages {
  const access = isRecord(value) && isRecord(value.access) ? value.access : {};
  const button = isRecord(access.button) ? access.button : {};
  const cs = isRecord(value) && isRecord(value.cs) ? value.cs : {};
  const notifications = isRecord(cs.notifications) ? cs.notifications : {};
  const commandOverrides = isRecord(value) && isRecord(value.commands) ? value.commands : {};
  const logOverrides = isRecord(value) && isRecord(value.logs) ? value.logs : {};
  const defaultButton = defaultMessages.access.button;
  const parsedNotifications: BotMessages["cs"]["notifications"] = { ...defaultCsNotifications };
  for (const [id, notification] of Object.entries(notifications)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(id) || !isRecord(notification)
      || typeof notification.label !== "string" || !notification.label.trim()
      || typeof notification.template !== "string" || !notification.template.trim()
      || !Array.isArray(notification.required)
      || notification.required.some(value => typeof value !== "string" || !allowedNotificationValues.has(value))) continue;
    const placeholders = [...notification.template.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!);
    if (placeholders.some(value => !allowedNotificationValues.has(value))
      || placeholders.some(value => !(notification.required as string[]).includes(value))) continue;
    parsedNotifications[id] = {
      label: notification.label.trim().slice(0, 100),
      template: notification.template.trim().slice(0, 1_500),
      required: [...new Set(notification.required as string[])]
    };
  }
  return {
    access: {
      entry: validText(access.entry, defaultMessages.access.entry),
      openWebsiteLabel: validText(access.openWebsiteLabel, defaultMessages.access.openWebsiteLabel),
      checkAccessLabel: validText(access.checkAccessLabel, defaultMessages.access.checkAccessLabel),
      button: {
        wrongServer: validText(button.wrongServer, defaultButton.wrongServer),
        exempt: validText(button.exempt, defaultButton.exempt),
        "not-linked": validText(button.notLinked, defaultButton["not-linked"]),
        revoked: validText(button.revoked, defaultButton.revoked),
        "manual-name": validText(button.manualName, defaultButton["manual-name"]),
        "cannot-rename": validText(button.cannotRename, defaultButton["cannot-rename"]),
        "dry-run": validText(button.dryRun, defaultButton["dry-run"]),
        "dry-run-linked": validText(button.dryRunLinked, defaultButton["dry-run-linked"]),
        verified: validText(button.verified, defaultButton.verified),
        "manual-override": validText(button.manualOverride, defaultButton["manual-override"]),
        checkFailed: validText(button.checkFailed, defaultButton.checkFailed)
      }
    },
    cs: { notifications: parsedNotifications },
    commands: parseTextCatalog(commandOverrides, defaultCommandMessages),
    logs: parseTextCatalog(logOverrides, defaultLogMessages)
  };
}

function parseTextCatalog(overrides: Record<string, unknown>, defaults: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) =>
    [key, validText(overrides[key], fallback).slice(0, 2_000)]));
}

export function getBotText(
  key: string,
  values: Record<string, string | number> = {},
  section: "commands" | "logs" = "commands",
  messages: BotMessages = activeMessages
): string {
  const template = messages[section][key];
  if (!template) return `[${key}]`;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => String(values[name] ?? ""));
}

export function renderCsNotification(
  id: string,
  values: Partial<Record<"competition" | "minutes" | "lobby" | "score", string>>,
  notifications: BotMessages["cs"]["notifications"] = activeMessages.cs.notifications
): string {
  const notification = notifications[id];
  if (!notification) throw new Error("Notification preset does not exist.");
  for (const key of notification.required) {
    if (!values[key as keyof typeof values]?.trim()) throw new Error(`Missing notification value: ${key}.`);
  }
  const rendered = notification.template.replace(/\{([^{}]+)\}/g, (_match, key: string) => values[key as keyof typeof values] ?? "");
  if (rendered.length > 2_000) throw new Error("Notification exceeds Discord's message limit.");
  return rendered;
}

export function getBotMessages(): BotMessages {
  return activeMessages;
}

export async function loadBotMessages(filePath = join(process.cwd(), "messages.json")): Promise<boolean> {
  try {
    activeMessages = parseBotMessages(JSON.parse(await readFile(filePath, "utf8")) as unknown);
    return true;
  } catch {
    activeMessages = defaultMessages;
    console.error("messages.json could not be loaded; built-in default access messages will be used.");
    return false;
  }
}
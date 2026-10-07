// Détection de messages "toxiques" (payloads démesurés / crash-messages)
// inspectMessage(msg) -> { suspicious: boolean, reason?: string }
// Les seuils sont volontairement larges pour éviter les faux positifs.

const LIMITS = {
    text: 30000,          // caractères de texte/légende
    invisibleChars: 1000, // zero-width, RTL/LTR overrides...
    combiningMarks: 2000, // texte "zalgo"
    mentions: 500,        // @mentions dans un seul message
    contacts: 20,         // contacts dans une carte multi-contacts
    vcard: 20000,         // taille d'une vCard
    location: 5000,       // nom/adresse de localisation
    flowParams: 10000     // messageParamsJson d'un message interactif
};

const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;
const COMBINING_RE = /[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u064B-\u065F]/g;

function unwrap(m) {
    let cur = m;
    for (let i = 0; i < 5 && cur; i++) {
        const next = cur.ephemeralMessage?.message
            || cur.viewOnceMessage?.message
            || cur.viewOnceMessageV2?.message
            || cur.viewOnceMessageV2Extension?.message
            || cur.documentWithCaptionMessage?.message
            || cur.editedMessage?.message;
        if (!next) break;
        cur = next;
    }
    return cur;
}

function extractText(m) {
    return m.conversation
        || m.extendedTextMessage?.text
        || m.imageMessage?.caption
        || m.videoMessage?.caption
        || m.documentMessage?.caption
        || '';
}

function findContextInfo(m) {
    for (const key of Object.keys(m)) {
        const ci = m[key]?.contextInfo;
        if (ci) return ci;
    }
    return null;
}

function inspectMessage(msg) {
    try {
        const raw = msg?.message;
        if (!raw) return { suspicious: false };
        const m = unwrap(raw);
        if (!m) return { suspicious: false };

        const text = extractText(m);
        if (text) {
            if (text.length > LIMITS.text) {
                return { suspicious: true, reason: `texte démesuré (${text.length} caractères)` };
            }
            const invisible = (text.match(INVISIBLE_RE) || []).length;
            if (invisible > LIMITS.invisibleChars || (text.length > 200 && invisible / text.length > 0.5)) {
                return { suspicious: true, reason: `caractères invisibles en masse (${invisible})` };
            }
            const combining = (text.match(COMBINING_RE) || []).length;
            if (combining > LIMITS.combiningMarks) {
                return { suspicious: true, reason: `caractères combinants en masse (${combining})` };
            }
        }

        const ci = findContextInfo(m);
        if (ci?.mentionedJid?.length > LIMITS.mentions) {
            return { suspicious: true, reason: `trop de mentions (${ci.mentionedJid.length})` };
        }

        if (m.contactMessage?.vcard?.length > LIMITS.vcard) {
            return { suspicious: true, reason: 'vCard démesurée' };
        }
        const contacts = m.contactsArrayMessage?.contacts;
        if (contacts) {
            if (contacts.length > LIMITS.contacts) {
                return { suspicious: true, reason: `trop de contacts (${contacts.length})` };
            }
            if (contacts.some(c => (c?.vcard?.length || 0) > LIMITS.vcard)) {
                return { suspicious: true, reason: 'vCard démesurée' };
            }
        }

        const loc = m.locationMessage || m.liveLocationMessage;
        if (loc && ((loc.name?.length || 0) > LIMITS.location || (loc.address?.length || 0) > LIMITS.location)) {
            return { suspicious: true, reason: 'localisation avec champs démesurés' };
        }

        const flow = m.interactiveMessage?.nativeFlowMessage?.messageParamsJson;
        if (flow && flow.length > LIMITS.flowParams) {
            return { suspicious: true, reason: 'payload interactif démesuré' };
        }

        return { suspicious: false };
    } catch (e) {
        // En cas d'erreur d'analyse, on ne bloque pas (fail-open)
        return { suspicious: false };
    }
}

module.exports = { inspectMessage, LIMITS };

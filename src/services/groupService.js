const logger = require('../utils/logger');

class GroupService {
    // ──────────────────────────────────────────────
    // Analyse le message de groupe pour détecter
    // quelle action effectuer
    // ──────────────────────────────────────────────
    parseGroupAction(params, message) {
        const text = message.toLowerCase();

        // Kick / expulser
        if (text.includes('kick') || text.includes('expuls') || text.includes('vire') || text.includes('retire')) {
            return { action: 'KICK', target: params.target };
        }
        // Ajouter
        if (text.includes('ajoute') || text.includes('invite') || text.includes('add ')) {
            return { action: 'ADD', target: params.target };
        }
        // Promouvoir admin
        if (text.includes('admin') || text.includes('promu') || text.includes('promote')) {
            return { action: 'PROMOTE', target: params.target };
        }
        // Rétrograder
        if (text.includes('rétrograde') || text.includes('demote') || text.includes('retire admin')) {
            return { action: 'DEMOTE', target: params.target };
        }
        // Changer description
        if (text.includes('description') || text.includes('desc')) {
            return { action: 'CHANGE_DESC', content: params.content };
        }
        // Changer nom du groupe
        if (text.includes('nom du groupe') || text.includes('renomme') || text.includes('change le nom')) {
            return { action: 'CHANGE_NAME', content: params.content };
        }
        // Message de bienvenue
        if (text.includes('bienvenue') || text.includes('welcome') || text.includes('message d\'accueil')) {
            return { action: 'WELCOME_MSG' };
        }
        // Fermer groupe (seuls les admins peuvent écrire)
        if (text.includes('ferme le groupe') || text.includes('lock') || text.includes('verrouille')) {
            return { action: 'LOCK_GROUP' };
        }
        // Ouvrir groupe
        if (text.includes('ouvre le groupe') || text.includes('unlock') || text.includes('déverrouille')) {
            return { action: 'UNLOCK_GROUP' };
        }

        return { action: 'UNKNOWN' };
    }

    // ──────────────────────────────────────────────
    // Exécute l'action de groupe
    // sock: instance Baileys
    // groupId: JID du groupe
    // ──────────────────────────────────────────────
    async executeAction(sock, groupId, actionData, mentionedJids = []) {
        try {
            const { action, target, content } = actionData;

            switch (action) {
                case 'KICK':
                    if (mentionedJids.length > 0) {
                        await sock.groupParticipantsUpdate(groupId, mentionedJids, 'remove');
                        return { success: true, message: 'Participants expulsés.' };
                    }
                    return { success: false, error: 'GROUP_NO_TARGET' };

                case 'ADD':
                    if (mentionedJids.length > 0) {
                        await sock.groupParticipantsUpdate(groupId, mentionedJids, 'add');
                        return { success: true, message: 'Participants ajoutés.' };
                    }
                    return { success: false, error: 'GROUP_NO_TARGET' };

                case 'PROMOTE':
                    if (mentionedJids.length > 0) {
                        await sock.groupParticipantsUpdate(groupId, mentionedJids, 'promote');
                        return { success: true, message: 'Participants promus admin.' };
                    }
                    return { success: false, error: 'GROUP_NO_TARGET' };

                case 'DEMOTE':
                    if (mentionedJids.length > 0) {
                        await sock.groupParticipantsUpdate(groupId, mentionedJids, 'demote');
                        return { success: true, message: 'Admin retiré.' };
                    }
                    return { success: false, error: 'GROUP_NO_TARGET' };

                case 'CHANGE_DESC':
                    if (content) {
                        await sock.groupUpdateDescription(groupId, content);
                        return { success: true, message: 'Description mise à jour.' };
                    }
                    return { success: false, error: 'GROUP_NO_CONTENT' };

                case 'CHANGE_NAME':
                    if (content) {
                        await sock.groupUpdateSubject(groupId, content);
                        return { success: true, message: 'Nom du groupe mis à jour.' };
                    }
                    return { success: false, error: 'GROUP_NO_CONTENT' };

                case 'LOCK_GROUP':
                    await sock.groupSettingUpdate(groupId, 'announcement');
                    return { success: true, message: 'Groupe verrouillé.' };

                case 'UNLOCK_GROUP':
                    await sock.groupSettingUpdate(groupId, 'not_announcement');
                    return { success: true, message: 'Groupe ouvert.' };

                case 'WELCOME_MSG':
                    return { success: true, action: 'WELCOME_MSG' };

                default:
                    return { success: false, error: 'GROUP_UNKNOWN_ACTION' };
            }

        } catch (error) {
            logger.error('Erreur action groupe:', error.message);
            // Si erreur de permissions Baileys
            if (error.message?.includes('not-authorized') || error.message?.includes('forbidden')) {
                return { success: false, error: 'GROUP_FORBIDDEN' };
            }
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    // ──────────────────────────────────────────────
    // Vérifie si le bot est admin dans un groupe
    // ──────────────────────────────────────────────
    async isBotAdmin(sock, groupId) {
        try {
            const metadata = await sock.groupMetadata(groupId);
            const botJid = sock.user?.id;
            if (!botJid || !metadata?.participants) return false;
            const botNum = botJid.split(':')[0].split('@')[0];
            const participant = metadata.participants.find(p => (p.id && p.id.startsWith(botNum)) || (p.jid && p.jid.startsWith(botNum)));
            return participant?.admin === 'admin' || participant?.admin === 'superadmin';
        } catch {
            return false;
        }
    }
}

module.exports = new GroupService();

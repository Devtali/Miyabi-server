const personality = require('../core/personality');
const gemini = require('../core/gemini');
const stickerHandler = require('./stickerHandler');
const downloadService = require('../services/downloadService');
const searchService = require('../services/searchService');
const groupService = require('../services/groupService');
const walletHandler = require('./walletHandler');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');

class MessageHandler {

    async handleMessage(sock, message, isGroup = false) {
        try {
            const sender = message.key.remoteJid;
            const senderNumber = message.key.participant || sender;

            // Déballage moderne du message (gère ephemeral, viewOnce, etc.)
            const innerMessage = this._unwrapMessage(message);
            const messageText = this._extractText(innerMessage);
            const mentionedJids = innerMessage?.extendedTextMessage?.contextInfo?.mentionedJid || [];

            if (!messageText) {
                await this._handleMediaMessage(sock, message, innerMessage, senderNumber, isGroup, sender);
                return;
            }

            const isMother = personality.isMother(senderNumber);
            const isOwner = personality.isOwner(senderNumber);

            if (isGroup) {
                const botMentioned = this._isBotMentioned(innerMessage);
                const nameMentioned = messageText.toLowerCase().includes('miyabi');
                if (!botMentioned && !nameMentioned && !isMother) return;
            }

            logger.info(`📨 Message de ${senderNumber}: "${messageText.slice(0, 60)}"`);

            // Marquer le message comme lu (Accusé de réception bleu officiel Baileys)
            await this._markAsRead(sock, message);

            // Commandes admin spéciales
            if (isOwner && messageText.startsWith('!')) {
                await this._handleAdminCommand(sock, sender, messageText, senderNumber, message);
                return;
            }

            // Indiquer l'état "en train d'écrire..." (Baileys presence update)
            await this._setPresence(sock, sender, 'composing');

            // Détecter l'intention avec Gemini
            const intentData = await gemini.detectIntent(messageText);
            logger.info(`🧠 Intention: ${intentData.intent} (confiance: ${intentData.confidence})`);

            const emotion = personality.getCurrentEmotion();

            // ── Router ──
            if (intentData.intent.startsWith('WALLET_')) {
                const action = intentData.intent.replace('WALLET_', '');
                await walletHandler.handle(sock, sender, action, intentData.params || {}, isOwner);
                await this._setPresence(sock, sender, 'paused');
                return;
            }

            const isLongAction = ['DOWNLOAD_AUDIO','DOWNLOAD_VIDEO','SEARCH_WEB','CONVERT_TO_AUDIO'].includes(intentData.intent);
            if (isLongAction) {
                // Réaction emoji "en cours" sur le message utilisateur
                await this._react(sock, sender, message.key, '⏳');
                const ackMsg = await gemini.generateActionResponse(emotion.name, intentData.intent, intentData.params || {});
                await this._sendText(sock, sender, ackMsg, message);
            }

            switch (intentData.intent) {
                case 'DOWNLOAD_AUDIO':
                    await this._setPresence(sock, sender, 'recording');
                    await this._handleDownloadAudio(sock, sender, intentData.params, emotion, message);
                    break;
                case 'DOWNLOAD_VIDEO':
                    await this._setPresence(sock, sender, 'recording');
                    await this._handleDownloadVideo(sock, sender, intentData.params, emotion, message);
                    break;
                case 'SEARCH_WEB':
                    await this._setPresence(sock, sender, 'composing');
                    await this._handleSearch(sock, sender, intentData.params, emotion, message);
                    break;
                case 'GROUP_ACTION':
                    if (isGroup) {
                        await this._handleGroupAction(sock, sender, messageText, intentData.params, mentionedJids, emotion, isOwner, message);
                    } else {
                        await this._sendText(sock, sender, '...Je gère les groupes seulement dans un groupe. Logique.', message);
                    }
                    break;
                case 'CONVERT_TO_AUDIO':
                    await this._sendText(sock, sender, await gemini.generateErrorResponse(emotion.name, 'NO_VIDEO'), message);
                    break;
                case 'CHAT':
                default:
                    await this._handleChat(sock, sender, message, senderNumber, messageText, emotion, isMother);
                    break;
            }

            // Réinitialiser la présence
            await this._setPresence(sock, sender, 'paused');

        } catch (error) {
            logger.error('Erreur handleMessage:', error);
            try {
                await this._setPresence(sock, message?.key?.remoteJid, 'paused');
            } catch (e) {}
        }
    }

    async _handleChat(sock, sender, message, senderNumber, messageText, emotion, isMother) {
        let response = await gemini.generateChatResponse(senderNumber, messageText, emotion.name, isMother);
        if (isMother) response = `(｡•́︿•̀｡) ... ${response}`;
        await this._sendText(sock, sender, response, message);

        const stickersEnabled = process.env.SEND_STICKERS !== 'false';
        if (stickersEnabled) {
            const stickerBuffer = await stickerHandler.getStickerBuffer(emotion.sticker);
            if (stickerBuffer) {
                await sock.sendMessage(sender, { sticker: stickerBuffer }, { quoted: message });
            }
        }
    }

    async _handleDownloadAudio(sock, sender, params, emotion, userMsg) {
        const query = params.query;
        if (!query) {
            await this._sendText(sock, sender, 'Quel morceau tu veux ? Donne-moi un titre ou un artiste.', userMsg);
            return;
        }
        const result = await downloadService.downloadAudio(query);
        if (result.success) {
            try {
                await sock.sendMessage(sender, {
                    audio: { url: result.path },
                    mimetype: 'audio/mpeg',
                    fileName: result.fileName,
                    ptt: false
                }, { quoted: userMsg });
                await this._react(sock, sender, userMsg.key, '🎵');
            } catch (err) {
                await this._sendText(sock, sender, await gemini.generateErrorResponse(emotion.name, 'DOWNLOAD_FAILED'), userMsg);
            } finally {
                downloadService.cleanup(result.path);
            }
        } else {
            await this._sendText(sock, sender, await gemini.generateErrorResponse(emotion.name, result.error || 'DOWNLOAD_FAILED'), userMsg);
        }
    }

    async _handleDownloadVideo(sock, sender, params, emotion, userMsg) {
        const query = params.query;
        if (!query) {
            await this._sendText(sock, sender, 'Quelle vidéo tu veux ? Donne-moi un titre ou une URL.', userMsg);
            return;
        }
        const result = await downloadService.downloadVideo(query);
        if (result.success) {
            try {
                await sock.sendMessage(sender, {
                    video: { url: result.path },
                    mimetype: 'video/mp4',
                    fileName: result.fileName
                }, { quoted: userMsg });
                await this._react(sock, sender, userMsg.key, '🎬');
            } catch (err) {
                await this._sendText(sock, sender, await gemini.generateErrorResponse(emotion.name, 'DOWNLOAD_FAILED'), userMsg);
            } finally {
                downloadService.cleanup(result.path);
            }
        } else {
            await this._sendText(sock, sender, await gemini.generateErrorResponse(emotion.name, result.error || 'DOWNLOAD_FAILED'), userMsg);
        }
    }

    async _handleSearch(sock, sender, params, emotion, userMsg) {
        const query = params.query;
        if (!query) {
            await this._sendText(sock, sender, 'Tu cherches quoi exactement ?', userMsg);
            return;
        }
        const rawResults = await searchService.search(query);
        if (rawResults) {
            const formatted = await searchService.formatResultsWithAI(query, rawResults, gemini, emotion.name);
            await this._sendText(sock, sender, formatted || rawResults.slice(0, 1000), userMsg);
            await this._react(sock, sender, userMsg.key, '🔍');
        } else {
            await this._sendText(sock, sender, await gemini.generateErrorResponse(emotion.name, 'SEARCH_FAILED'), userMsg);
        }
    }

    async _handleGroupAction(sock, groupId, messageText, params, mentionedJids, emotion, isOwner, userMsg) {
        const botIsAdmin = await groupService.isBotAdmin(sock, groupId);
        if (!botIsAdmin) {
            await this._sendText(sock, groupId, 'Je suis pas admin ici. Donne-moi les droits d\'abord.', userMsg);
            return;
        }
        const actionData = groupService.parseGroupAction(params, messageText);
        const result = await groupService.executeAction(sock, groupId, actionData, mentionedJids);
        if (result.success) {
            await this._sendText(sock, groupId, 'Fait. De rien.', userMsg);
            await this._react(sock, groupId, userMsg.key, '✅');
        } else {
            await this._sendText(sock, groupId, await gemini.generateErrorResponse(emotion.name, result.error || 'GROUP_FORBIDDEN'), userMsg);
        }
    }

    async _handleMediaMessage(sock, rawMsg, innerMsg, senderNumber, isGroup, sender) {
        const videoMsg = innerMsg?.videoMessage;
        if (!videoMsg) return;

        const caption = videoMsg.caption || '';
        const wantsConvert = caption.toLowerCase().includes('mp3') ||
                             caption.toLowerCase().includes('audio') ||
                             caption.toLowerCase().includes('convertis');
        if (!wantsConvert) return;

        const emotion = personality.getCurrentEmotion();
        await this._react(sock, sender, rawMsg.key, '⏳');
        await this._setPresence(sock, sender, 'recording');
        await this._sendText(sock, sender, 'Je convertis ça... attends.', rawMsg);

        try {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
            const tempDir = path.join(__dirname, '../../temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

            const tempVideoPath = path.join(tempDir, `vid_${Date.now()}.mp4`);
            fs.writeFileSync(tempVideoPath, buffer);

            const result = await downloadService.convertVideoToAudio(tempVideoPath);
            downloadService.cleanup(tempVideoPath);

            if (result.success) {
                await sock.sendMessage(sender, {
                    audio: { url: result.path },
                    mimetype: 'audio/mpeg',
                    ptt: false
                }, { quoted: rawMsg });
                await this._react(sock, sender, rawMsg.key, '🎧');
                downloadService.cleanup(result.path);
            } else {
                await this._sendText(sock, sender, await gemini.generateErrorResponse(emotion.name, 'DOWNLOAD_FAILED'), rawMsg);
            }
        } catch (err) {
            logger.error('Erreur conversion vidéo:', err.message);
            await this._sendText(sock, sender, await gemini.generateErrorResponse(emotion.name, 'DOWNLOAD_FAILED'), rawMsg);
        } finally {
            await this._setPresence(sock, sender, 'paused');
        }
    }

    async _handleAdminCommand(sock, sender, text, senderNumber, userMsg) {
        const cmd = text.slice(1).trim().toLowerCase();
        if (cmd === 'reset') {
            gemini.clearHistory(senderNumber);
            await this._sendText(sock, sender, 'Mémoire effacée.', userMsg);
        } else if (cmd.startsWith('humeur ')) {
            const emotion = cmd.replace('humeur ', '');
            const ok = personality.setEmotion(emotion);
            await this._sendText(sock, sender, ok ? `Humeur changée: ${emotion}` : 'Humeur inconnue.', userMsg);
        } else if (cmd === 'groupid') {
            await this._sendText(sock, sender, `ID du groupe: ${sender}`, userMsg);
        } else {
            await this._sendText(sock, sender, 'Commande inconnue.', userMsg);
        }
    }

    // Déballe les conteneurs spéciaux de WhatsApp (ephemeral, viewOnce, etc.)
    _unwrapMessage(rawMessage) {
        let msg = rawMessage.message;
        if (!msg) return null;

        if (msg.ephemeralMessage?.message) {
            msg = msg.ephemeralMessage.message;
        }
        if (msg.viewOnceMessage?.message) {
            msg = msg.viewOnceMessage.message;
        }
        if (msg.viewOnceMessageV2?.message) {
            msg = msg.viewOnceMessageV2.message;
        }
        if (msg.documentWithCaptionMessage?.message) {
            msg = msg.documentWithCaptionMessage.message;
        }
        return msg;
    }

    _extractText(message) {
        if (!message) return '';
        return message.conversation ||
               message.extendedTextMessage?.text ||
               message.imageMessage?.caption ||
               message.videoMessage?.caption || '';
    }

    _isBotMentioned(message) {
        const mentioned = message?.extendedTextMessage?.contextInfo?.mentionedJid;
        return Array.isArray(mentioned) && mentioned.length > 0;
    }

    // Baileys read receipts (coche bleue)
    async _markAsRead(sock, message) {
        try {
            if (message?.key) {
                await sock.readMessages([message.key]);
            }
        } catch (e) {}
    }

    // Baileys presence update ('composing' | 'recording' | 'paused')
    async _setPresence(sock, jid, presence = 'composing') {
        try {
            if (jid) {
                await sock.sendPresenceUpdate(presence, jid);
            }
        } catch (e) {}
    }

    // Baileys emoji reaction
    async _react(sock, jid, key, emoji) {
        try {
            if (jid && key) {
                await sock.sendMessage(jid, {
                    react: { text: emoji, key }
                });
            }
        } catch (e) {}
    }

    // Envoi de texte avec citation automatique (quoted) et stockage dans le cache
    async _sendText(sock, jid, text, quotedMessage = null) {
        try {
            const options = quotedMessage ? { quoted: quotedMessage } : {};
            const sent = await sock.sendMessage(jid, { text }, options);

            // Mettre en cache pour getMessage si besoin
            if (sent?.key?.id && sent.message) {
                const { messageStore } = require('../core/sessionManager');
                if (messageStore) {
                    messageStore.set(sent.key.id, sent.message);
                }
            }
            return sent;
        } catch (err) {
            logger.error('Erreur envoi texte:', err.message);
        }
    }
}

module.exports = new MessageHandler();

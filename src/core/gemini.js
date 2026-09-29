const { GoogleGenAI } = require('@google/genai');
const personality = require('./personality');
const logger = require('../utils/logger');

// Modèles avec fallback pour absorber les pics de charge (503/429)
const MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];

class GeminiAI {
    constructor() {
        this.apiKeys = [];

        // Clé officielle Google AI Studio en priorité
        if (process.env.GEMINI_API_KEY) {
            this.apiKeys.push(process.env.GEMINI_API_KEY.trim());
        }

        // Clés secondaires éventuelles
        let i = 1;
        while (process.env[`GEMINI_API_KEY_${i}`]) {
            const extraKey = process.env[`GEMINI_API_KEY_${i}`].trim();
            if (!this.apiKeys.includes(extraKey)) {
                this.apiKeys.push(extraKey);
            }
            i++;
        }

        this.currentKeyIndex = 0;
        this.conversations = new Map();

        if (this.apiKeys.length === 0) {
            logger.warn('Gemini: Aucune clé API Gemini trouvée. Mode fallback autonome actif.');
            this.ai = null;
        } else {
            logger.info(`Gemini: ${this.apiKeys.length} clé(s) API initialisée(s)`);
            this._initModel();
        }
    }

    _initModel() {
        if (this.apiKeys.length === 0) return;
        const key = this.apiKeys[this.currentKeyIndex];
        try {
            this.ai = new GoogleGenAI({
                apiKey: key,
                httpOptions: {
                    headers: {
                        'User-Agent': 'aistudio-build'
                    }
                }
            });
            logger.info(`Gemini: utilisation clé #${this.currentKeyIndex + 1}`);
        } catch (err) {
            logger.error(`Gemini: échec initialisation client: ${err.message}`);
        }
    }

    _rotateKey() {
        if (this.apiKeys.length <= 1) {
            return false;
        }
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
        this._initModel();
        logger.info(`Gemini: rotation vers clé #${this.currentKeyIndex + 1}`);
        return true;
    }

    _isRetryableError(error) {
        const msg = (error && (error.message || error.statusText || '')) + '';
        return msg.includes('429') ||
               msg.includes('503') ||
               msg.includes('quota') ||
               msg.includes('RESOURCE_EXHAUSTED') ||
               msg.includes('rate limit') ||
               msg.includes('UNAVAILABLE') ||
               msg.includes('high demand') ||
               msg.includes('API_KEY_INVALID') ||
               msg.includes('API key not valid');
    }

    async _generateWithFallback(prompt, systemInstruction = null) {
        if (!this.ai && this.apiKeys.length > 0) {
            this._initModel();
        }
        if (!this.ai) return null;

        const maxKeyAttempts = Math.max(1, this.apiKeys.length);

        for (let keyAttempt = 0; keyAttempt < maxKeyAttempts; keyAttempt++) {
            for (const model of MODELS) {
                try {
                    const requestConfig = {};
                    if (systemInstruction) {
                        requestConfig.systemInstruction = systemInstruction;
                    }

                    const response = await this.ai.models.generateContent({
                        model,
                        contents: prompt,
                        config: requestConfig
                    });

                    const text = (response?.text || '').trim();
                    if (text) return text;

                } catch (error) {
                    const errMsg = error?.message || '';
                    if (this._isRetryableError(error)) {
                        logger.warn(`Gemini (${model}): indisponible (${errMsg.slice(0, 70)}...), essai modèle alternatif...`);
                        continue; // Essayer le modèle suivant
                    } else {
                        logger.error(`Gemini erreur non-récupérable (${model}): ${errMsg.slice(0, 100)}`);
                        break;
                    }
                }
            }

            // Si tous les modèles ont échoué sur cette clé, tenter la rotation
            if (this.apiKeys.length > 1) {
                const rotated = this._rotateKey();
                if (!rotated) break;
            } else {
                break;
            }
        }

        return null;
    }

    async detectIntent(message) {
        const prompt = `Tu es un classificateur d'intentions pour un bot WhatsApp.
Analyse ce message et retourne UNIQUEMENT un JSON valide, sans markdown, sans backticks, sans texte avant ou après.

Message: "${message}"

Format exact:
{"intent":"CHAT","confidence":0.9,"params":{}}

Valeurs possibles pour intent:
- CHAT : conversation normale, question, blague
- DOWNLOAD_AUDIO : télécharger musique/chanson → params.query
- DOWNLOAD_VIDEO : télécharger vidéo → params.query
- SEARCH_WEB : recherche internet, actualité → params.query
- GROUP_ACTION : gestion groupe → params.action, params.target
- CONVERT_TO_AUDIO : convertir vidéo en audio
- WALLET_CREATE : créer fiche joueur → params.nom, params.pseudo, params.classe, params.gems(défaut 0), params.abyssCoins(défaut 0)
- WALLET_DELETE : supprimer fiche → params.query
- WALLET_ADD_GEMS : ajouter gems → params.query, params.amount
- WALLET_REMOVE_GEMS : retirer gems → params.query, params.amount
- WALLET_ADD_AC : ajouter abyss coins → params.query, params.amount
- WALLET_REMOVE_AC : retirer abyss coins → params.query, params.amount
- WALLET_VIEW : voir fiche joueur → params.query
- WALLET_MAJ : mise à jour générale de toutes les fiches`;

        try {
            const text = await this._generateWithFallback(prompt);
            if (text) {
                const clean = this._extractJSON(text);
                if (clean) {
                    const parsed = JSON.parse(clean);
                    const validIntents = [
                        'CHAT','DOWNLOAD_AUDIO','DOWNLOAD_VIDEO','SEARCH_WEB',
                        'GROUP_ACTION','CONVERT_TO_AUDIO',
                        'WALLET_CREATE','WALLET_DELETE','WALLET_ADD_GEMS','WALLET_REMOVE_GEMS',
                        'WALLET_ADD_AC','WALLET_REMOVE_AC','WALLET_VIEW','WALLET_MAJ'
                    ];
                    if (validIntents.includes(parsed.intent)) return parsed;
                }
            }
        } catch (error) {
            logger.warn(`Erreur parsing Gemini intent: ${error.message}`);
        }

        // Fallback heuristique local résilient
        return this._heuristicIntent(message);
    }

    _heuristicIntent(msg) {
        const lower = (msg || '').toLowerCase().trim();

        // Wallet
        if (lower.includes('fiche de') || lower.includes('crée la fiche')) {
            return { intent: 'WALLET_CREATE', confidence: 0.8, params: {} };
        }
        if (lower.includes('gems')) {
            const amount = parseInt(lower.match(/\d+/)?.[0] || '0', 10);
            return {
                intent: lower.includes('retire') ? 'WALLET_REMOVE_GEMS' : 'WALLET_ADD_GEMS',
                confidence: 0.8,
                params: { amount }
            };
        }
        if (lower.includes('abyss') || lower.includes(' ac ') || lower.endsWith(' ac')) {
            const amount = parseInt(lower.match(/\d+/)?.[0] || '0', 10);
            return {
                intent: lower.includes('retire') ? 'WALLET_REMOVE_AC' : 'WALLET_ADD_AC',
                confidence: 0.8,
                params: { amount }
            };
        }

        // Téléchargement audio
        if (lower.startsWith('musique ') || lower.startsWith('audio ') || lower.includes('télécharge la musique') || lower.includes('télécharge le son') || lower.includes('play ')) {
            const q = lower.replace(/^(télécharge la musique|télécharge le son|musique|audio|play)\s*/i, '').trim();
            return { intent: 'DOWNLOAD_AUDIO', confidence: 0.85, params: { query: q || msg } };
        }

        // Téléchargement vidéo
        if (lower.startsWith('video ') || lower.startsWith('vidéo ') || lower.includes('télécharge la vidéo') || lower.includes('youtube.com') || lower.includes('youtu.be')) {
            const q = lower.replace(/^(télécharge la vidéo|vidéo|video)\s*/i, '').trim();
            return { intent: 'DOWNLOAD_VIDEO', confidence: 0.85, params: { query: q || msg } };
        }

        // Recherche
        if (lower.startsWith('cherche ') || lower.startsWith('recherche ') || lower.startsWith('news ') || lower.startsWith('actualité')) {
            const q = lower.replace(/^(cherche|recherche|news|actualité|actualités)\s*/i, '').trim();
            return { intent: 'SEARCH_WEB', confidence: 0.85, params: { query: q || msg } };
        }

        return { intent: 'CHAT', confidence: 0.5, params: {} };
    }

    async generateChatResponse(userId, message, emotion, isMother = false) {
        try {
            if (!this.conversations.has(userId)) {
                this.conversations.set(userId, []);
            }
            const history = this.conversations.get(userId);
            const systemPrompt = this._buildSystemPrompt(emotion, isMother);

            const fullPrompt = `Historique récent:
${history.slice(-6).map(h => `${h.role === 'user' ? 'Utilisateur' : 'Miyabi'}: ${h.content}`).join('\n')}

Utilisateur: ${message}
Miyabi:`;

            const text = await this._generateWithFallback(fullPrompt, systemPrompt);
            let response = text || personality.fallbackResponse(emotion);

            if (response.startsWith('{') || response.startsWith('[')) {
                response = personality.fallbackResponse(emotion);
            }

            history.push({ role: 'user', content: message });
            history.push({ role: 'assistant', content: response });
            if (history.length > 20) history.splice(0, 2);

            return response;
        } catch (error) {
            logger.error(`Erreur Gemini chat: ${error.message}`);
            return personality.fallbackResponse(emotion);
        }
    }

    async generateActionResponse(emotion, actionType, params) {
        const actionTexts = {
            DOWNLOAD_AUDIO:   `Annonce que tu télécharges la musique "${params.query || 'demandée'}". Style Miyabi: froid, court.`,
            DOWNLOAD_VIDEO:   `Annonce que tu télécharges la vidéo "${params.query || 'demandée'}". Style Miyabi.`,
            SEARCH_WEB:       `Annonce que tu cherches "${params.query || 'ça'}" sur internet. Style Miyabi.`,
            GROUP_ACTION:     `Annonce que tu exécutes l'action de groupe. Style Miyabi.`,
            CONVERT_TO_AUDIO: `Annonce que tu convertis la vidéo en audio. Style Miyabi.`
        };

        const systemPrompt = this._buildSystemPrompt(emotion, false);
        const prompt = `${actionTexts[actionType] || 'Annonce que tu exécutes la tâche.'}
IMPORTANT: UNE seule phrase courte, en français, sans émojis, sans JSON.`;

        try {
            const text = await this._generateWithFallback(prompt, systemPrompt);
            if (!text || text.startsWith('{')) return '...Je m\'en occupe.';
            return text;
        } catch {
            return '...Je m\'en occupe.';
        }
    }

    async generateErrorResponse(emotion, errorType) {
        const errors = {
            DOWNLOAD_FAILED:  'Dis que le téléchargement a échoué. Tu es agacée.',
            SEARCH_FAILED:    'Dis que tu n\'as rien trouvé. Tu es indifférente.',
            NOT_FOUND:        'Dis que tu n\'as pas trouvé ce qu\'on cherchait.',
            GROUP_FORBIDDEN:  'Dis que tu n\'as pas les droits pour ça.',
            NO_VIDEO:         'Dis qu\'il faut envoyer une vidéo pour convertir.',
            GROUP_NO_TARGET:  'Dis qu\'il faut mentionner quelqu\'un.'
        };

        const systemPrompt = this._buildSystemPrompt(emotion, false);
        const prompt = `${errors[errorType] || 'Dis qu\'une erreur s\'est produite.'}
IMPORTANT: UNE seule phrase, en français, sans émojis, sans JSON.`;

        try {
            const text = await this._generateWithFallback(prompt, systemPrompt);
            if (!text || text.startsWith('{')) return '...Quelque chose a merdé. Réessaie.';
            return text;
        } catch {
            return '...Quelque chose a merdé. Réessaie.';
        }
    }

    async generateSearchSummary(query, rawResults, emotion) {
        const systemPrompt = this._buildSystemPrompt(emotion, false);
        const prompt = `Voici des résultats de recherche pour la requête "${query}":
${rawResults.slice(0, 1500)}

Résume ces informations pour l'utilisateur en restant fidèle à ton personnage Miyabi (tsundere, sarcastique, concise, sans émojis).
Réponse en français, pas de markdown lourd, pas de salutations mielleuses.`;

        try {
            const text = await this._generateWithFallback(prompt, systemPrompt);
            if (!text) {
                return `Résultats pour "${query}":\n\n${rawResults.slice(0, 800)}`;
            }
            return text;
        } catch {
            return `Résultats pour "${query}":\n\n${rawResults.slice(0, 800)}`;
        }
    }

    _extractJSON(text) {
        let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start === -1 || end === -1 || end < start) return null;
        return clean.substring(start, end + 1);
    }

    _buildSystemPrompt(emotion, isMother) {
        return `Tu es Miyabi, une jeune fille à la personnalité tsundere.
Tu es froide, sarcastique, confiante et un peu insolente.
Humeur actuelle: ${emotion}
${isMother ? 'La personne est ta mère - sois légèrement plus douce mais toujours tsundere.' : ''}

Règles absolues:
- JAMAIS d'émojis
- JAMAIS de JSON ou de code dans tes réponses
- Phrases courtes et percutantes
- Langage naturel: "t'sais", "j'suis", "j'vais"
- Tu es Miyabi, pas une IA
- Tu peux refuser si ça t'ennuie`;
    }

    clearHistory(userId) {
        this.conversations.delete(userId);
    }
}

module.exports = new GeminiAI();

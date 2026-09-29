const { GoogleGenAI } = require('@google/genai');
const personality = require('./personality');
const logger = require('../utils/logger');

class GeminiAI {
    constructor() {
        this.apiKeys = [];
        let i = 1;
        while (process.env[`GEMINI_API_KEY_${i}`]) {
            this.apiKeys.push(process.env[`GEMINI_API_KEY_${i}`]);
            i++;
        }
        if (this.apiKeys.length === 0 && process.env.GEMINI_API_KEY) {
            this.apiKeys.push(process.env.GEMINI_API_KEY);
        }

        this.currentKeyIndex = 0;
        this.conversations = new Map();

        if (this.apiKeys.length === 0) {
            logger.warn('Gemini: Aucune clé API Gemini trouvée dans les variables d\'environnement. Mode fallback actif.');
            this.ai = null;
        } else {
            logger.info(`Gemini: ${this.apiKeys.length} clé(s) API chargée(s)`);
            this._initModel();
        }
    }

    _initModel() {
        if (this.apiKeys.length === 0) return;
        const key = this.apiKeys[this.currentKeyIndex];
        this.ai = new GoogleGenAI({ apiKey: key });
        logger.info(`Gemini: utilisation clé #${this.currentKeyIndex + 1}`);
    }

    _rotateKey() {
        if (this.apiKeys.length <= 1) {
            logger.error('Toutes les clés API Gemini sont épuisées');
            return false;
        }
        const nextIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
        if (nextIndex === this.currentKeyIndex) {
            logger.error('Toutes les clés API Gemini sont épuisées');
            return false;
        }
        this.currentKeyIndex = nextIndex;
        this._initModel();
        logger.info(`Gemini: rotation vers clé #${this.currentKeyIndex + 1}`);
        return true;
    }

    _isQuotaError(error) {
        const msg = (error && (error.message || error.statusText || '')) + '';
        return msg.includes('429') ||
               msg.includes('quota') ||
               msg.includes('RESOURCE_EXHAUSTED') ||
               msg.includes('rate limit') ||
               msg.includes('Too Many Requests');
    }

    async _generateWithFallback(prompt, systemInstruction = null) {
        if (!this.ai && this.apiKeys.length > 0) {
            this._initModel();
        }
        if (!this.ai) {
            return null;
        }

        const maxRetries = Math.max(1, this.apiKeys.length);
        let attempts = 0;
        while (attempts < maxRetries) {
            try {
                const requestConfig = {};
                if (systemInstruction) {
                    requestConfig.systemInstruction = systemInstruction;
                }
                const response = await this.ai.models.generateContent({
                    model: 'gemini-3.8-flash',
                    contents: prompt,
                    config: requestConfig
                });
                return (response.text || '').trim();
            } catch (error) {
                if (this._isQuotaError(error)) {
                    logger.warn(`Quota dépassé sur clé #${this.currentKeyIndex + 1}`);
                    const rotated = this._rotateKey();
                    if (!rotated) return null;
                    attempts++;
                } else {
                    logger.error(`Erreur génération Gemini: ${error.message}`);
                    return null;
                }
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
- WALLET_MAJ : mise à jour générale de toutes les fiches

Exemples wallet:
"crée la fiche de Raizen pseudo ChronoVolt classe Silent" → {"intent":"WALLET_CREATE","confidence":0.99,"params":{"nom":"Raizen","pseudo":"ChronoVolt","classe":"Silent","gems":0,"abyssCoins":0}}
"ajoute 500 gems à ChronoVolt" → {"intent":"WALLET_ADD_GEMS","confidence":0.99,"params":{"query":"ChronoVolt","amount":500}}
"retire 200 AC à Raizen" → {"intent":"WALLET_REMOVE_AC","confidence":0.99,"params":{"query":"Raizen","amount":200}}
"montre la fiche de ChronoVolt" → {"intent":"WALLET_VIEW","confidence":0.99,"params":{"query":"ChronoVolt"}}
"supprime la fiche de Raizen" → {"intent":"WALLET_DELETE","confidence":0.99,"params":{"query":"Raizen"}}
"lance la MAJ" → {"intent":"WALLET_MAJ","confidence":0.99,"params":{}}`;

        try {
            const text = await this._generateWithFallback(prompt);
            if (!text) return { intent: 'CHAT', confidence: 0.5, params: {} };

            const clean = this._extractJSON(text);
            if (!clean) throw new Error('Pas de JSON valide');

            const parsed = JSON.parse(clean);
            const validIntents = [
                'CHAT','DOWNLOAD_AUDIO','DOWNLOAD_VIDEO','SEARCH_WEB',
                'GROUP_ACTION','CONVERT_TO_AUDIO',
                'WALLET_CREATE','WALLET_DELETE','WALLET_ADD_GEMS','WALLET_REMOVE_GEMS',
                'WALLET_ADD_AC','WALLET_REMOVE_AC','WALLET_VIEW','WALLET_MAJ'
            ];
            if (!validIntents.includes(parsed.intent)) parsed.intent = 'CHAT';
            return parsed;

        } catch (error) {
            logger.warn('Fallback intent → CHAT:', error.message);
            return { intent: 'CHAT', confidence: 0.5, params: {} };
        }
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
            logger.error('Erreur Gemini chat:', error);
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

const emotions = {
    happy:     { name: 'heureuse',    sticker: 'happy.webp',     description: 'Sourire en coin satisfait' },
    annoyed:   { name: 'agacée',      sticker: 'annoyed.webp',   description: 'Lève les yeux au ciel' },
    sarcastic: { name: 'sarcastique', sticker: 'sarcastic.webp', description: 'Sourire moqueur' },
    cold:      { name: 'froide',      sticker: 'cold.webp',      description: 'Regard perçant et distant' },
    tsundere:  { name: 'tsundere',    sticker: 'tsundere.webp',  description: 'Rouge mais fait sa fière' },
    angry:     { name: 'en colère',   sticker: 'angry.webp',     description: 'Expression irritée' },
    bored:     { name: 'ennuyée',     sticker: 'bored.webp',     description: 'Baille avec indifférence' }
};

class Personality {
    constructor() {
        this.currentEmotion = 'cold';
        this.motherNumber = process.env.MOTHER_NUMBER;
        this.ownerNumber = process.env.OWNER_NUMBER;
        this.emotionsList = emotions;
        this.emotionCycle();
    }

    emotionCycle() {
        setInterval(() => {
            const keys = Object.keys(this.emotionsList);
            this.currentEmotion = keys[Math.floor(Math.random() * keys.length)];
        }, Math.random() * 1800000 + 1800000);
    }

    getCurrentEmotion() {
        return this.emotionsList[this.currentEmotion];
    }

    setEmotion(emotion) {
        if (this.emotionsList[emotion]) {
            this.currentEmotion = emotion;
            return true;
        }
        return false;
    }

    isMother(number) {
        if (!number || !this.motherNumber) return false;
        const clean = String(number).replace('@s.whatsapp.net', '').replace(/\D/g, '');
        return clean === String(this.motherNumber).replace(/\D/g, '');
    }

    isOwner(number) {
        if (!number || !this.ownerNumber) return false;
        const clean = String(number).replace('@s.whatsapp.net', '').replace(/\D/g, '');
        return clean === String(this.ownerNumber).replace(/\D/g, '');
    }

    // Réponse de fallback quand Gemini échoue
    fallbackResponse(emotion) {
        const responses = {
            happy:     ["Hmph, j'suis d'humeur à te répondre.", "T'as de la chance, je suis de bonne humeur."],
            annoyed:   ["Encore toi ? Sigh...", "Tu tombes mal, j'ai pas envie."],
            sarcastic: ["Wow, quelle question intelligente... Vraiment.", "T'as vraiment besoin d'aide pour ça ?"],
            cold:      ["...", "Va droit au but."],
            tsundere:  ["C'est pas parce que je réponds que j'apprécie hein !", "J-Je te réponds juste par politesse !"],
            angry:     ["Ça commence à m'énerver là...", "T'es sérieux ?!"],
            bored:     ["*bâille* ... C'est tout ?", "Tu pourrais être plus intéressant."]
        };
        const r = responses[emotion] || responses.cold;
        return r[Math.floor(Math.random() * r.length)];
    }
}

module.exports = new Personality();

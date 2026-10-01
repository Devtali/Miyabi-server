const YTDlpWrap = require('yt-dlp-wrap').default;
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const TEMP_DIR = path.join(__dirname, '../../temp');
const BINARY_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const LOCAL_YT_DLP = path.join(TEMP_DIR, BINARY_NAME);

// S'assurer que le dossier temp existe
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

class DownloadService {
    constructor() {
        if (fs.existsSync(LOCAL_YT_DLP)) {
            this.ytDlp = new YTDlpWrap(LOCAL_YT_DLP);
        } else {
            this.ytDlp = new YTDlpWrap();
            this._checkAndDownloadBinary();
        }
    }

    async _checkAndDownloadBinary() {
        try {
            await this.ytDlp.getVersion();
        } catch {
            try {
                logger.info('yt-dlp non présent dans le système, téléchargement automatique en cours...');
                await YTDlpWrap.downloadFromGithub(LOCAL_YT_DLP);
                if (process.platform !== 'win32') {
                    fs.chmodSync(LOCAL_YT_DLP, '755');
                }
                this.ytDlp = new YTDlpWrap(LOCAL_YT_DLP);
                logger.info('yt-dlp configuré avec succès');
            } catch (err) {
                logger.warn(`Impossible de télécharger automatiquement yt-dlp: ${err.message}`);
            }
        }
    }

    // ──────────────────────────────────────────────
    // Recherche l'URL YouTube depuis une requête texte
    // ──────────────────────────────────────────────
    async searchYouTube(query) {
        try {
            const results = await this.ytDlp.execPromise([
                `ytsearch1:${query}`,
                '--print', 'webpage_url',
                '--no-playlist'
            ]);
            const url = results.trim().split('\n')[0];
            return url || null;
        } catch (error) {
            logger.error('Erreur recherche YouTube:', error.message);
            return null;
        }
    }

    // ──────────────────────────────────────────────
    // Télécharge en MP3 (audio uniquement)
    // Retourne le path du fichier ou null
    // ──────────────────────────────────────────────
    async downloadAudio(query) {
        try {
            logger.info(`🎵 Download audio: ${query}`);

            // Chercher l'URL si c'est un titre et non une URL directe
            let url = query;
            if (!query.startsWith('http')) {
                url = await this.searchYouTube(query);
                if (!url) return { success: false, error: 'NOT_FOUND' };
            }

            const fileName = `audio_${Date.now()}.mp3`;
            const outputPath = path.join(TEMP_DIR, fileName);

            await this.ytDlp.execPromise([
                url,
                '-x',
                '--audio-format', 'mp3',
                '--audio-quality', '0',
                '-o', outputPath,
                '--no-playlist',
                '--max-filesize', '50m' // Limite WhatsApp
            ]);

            if (fs.existsSync(outputPath)) {
                return { success: true, path: outputPath, fileName };
            }
            return { success: false, error: 'DOWNLOAD_FAILED' };

        } catch (error) {
            logger.error('Erreur download audio:', error.message);
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    // ──────────────────────────────────────────────
    // Télécharge une vidéo (MP4, max 50MB pour WhatsApp)
    // ──────────────────────────────────────────────
    async downloadVideo(query) {
        try {
            logger.info(`🎬 Download vidéo: ${query}`);

            let url = query;
            if (!query.startsWith('http')) {
                url = await this.searchYouTube(query);
                if (!url) return { success: false, error: 'NOT_FOUND' };
            }

            const fileName = `video_${Date.now()}.mp4`;
            const outputPath = path.join(TEMP_DIR, fileName);

            await this.ytDlp.execPromise([
                url,
                '-f', 'best[ext=mp4][filesize<50M]/best[ext=mp4]/best',
                '-o', outputPath,
                '--no-playlist',
                '--max-filesize', '50m'
            ]);

            if (fs.existsSync(outputPath)) {
                return { success: true, path: outputPath, fileName };
            }
            return { success: false, error: 'DOWNLOAD_FAILED' };

        } catch (error) {
            logger.error('Erreur download vidéo:', error.message);
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    // ──────────────────────────────────────────────
    // Convertit une vidéo (buffer ou path) en MP3
    // ──────────────────────────────────────────────
    async convertVideoToAudio(videoPath) {
        try {
            logger.info(`🔄 Conversion vidéo → audio: ${videoPath}`);

            const ffmpeg = require('fluent-ffmpeg');
            const outputPath = path.join(TEMP_DIR, `converted_${Date.now()}.mp3`);

            await new Promise((resolve, reject) => {
                ffmpeg(videoPath)
                    .noVideo()
                    .audioCodec('libmp3lame')
                    .audioBitrate('128k')
                    .save(outputPath)
                    .on('end', resolve)
                    .on('error', reject);
            });

            if (fs.existsSync(outputPath)) {
                return { success: true, path: outputPath };
            }
            return { success: false, error: 'DOWNLOAD_FAILED' };

        } catch (error) {
            logger.error('Erreur conversion:', error.message);
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    // Supprime un fichier temp après envoi
    cleanup(filePath) {
        try {
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            logger.warn('Cleanup échoué:', e.message);
        }
    }
}

module.exports = new DownloadService();

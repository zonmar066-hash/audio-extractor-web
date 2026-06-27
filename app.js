/**
 * 音频提取器 - Web 版 (重构版)
 * 
 * 技术方案：
 * - Web Audio API 解码任意音频/视频 → PCM
 * - 两遍处理：Pass 1 计算 RMS → Pass 2 增益调整 + 编码
 * - 输出：WAV (无损) 或 AAC (WebCodecs 支持时)
 * - 纯浏览器本地处理
 */

class AudioExtractor {
    constructor() {
        this.files = [];
        this.isConverting = false;
        this.audioContext = null;
        this.init();
    }

    init() {
        this.cacheElements();
        this.checkBrowserSupport();
        this.bindEvents();
        this.updateUI();
    }

    /**
     * 检查浏览器支持情况
     */
    checkBrowserSupport() {
        this.hasWebCodecs = typeof AudioEncoder !== 'undefined';
        console.log('Browser support - WebCodecs AudioEncoder:', this.hasWebCodecs);
        
        // 更新浏览器支持提示
        const supportDiv = document.getElementById('browserSupport');
        if (supportDiv) {
            if (this.hasWebCodecs) {
                supportDiv.innerHTML = '<span class="supported">✓</span> 当前浏览器支持 AAC 编码（WebCodecs）';
            } else {
                supportDiv.innerHTML = '<span class="unsupported">✗</span> 当前浏览器不支持 AAC 编码，将输出 WAV 格式（需要 Chrome 94+ 或 Edge 94+）';
            }
        }
        
        // 如果不支持 WebCodecs，禁用 AAC 选项
        if (!this.hasWebCodecs && this.formatSelect) {
            const aacOption = this.formatSelect.querySelector('option[value="aac"]');
            if (aacOption) {
                aacOption.disabled = true;
                aacOption.textContent = 'AAC (.m4a) - 当前浏览器不支持';
            }
            // 强制切换到 WAV
            this.formatSelect.value = 'wav';
        }
    }

    cacheElements() {
        this.uploadZone = document.getElementById('uploadZone');
        this.fileInput = document.getElementById('fileInput');
        this.fileList = document.getElementById('fileList');
        this.optionsPanel = document.getElementById('optionsPanel');
        this.actions = document.getElementById('actions');
        this.convertBtn = document.getElementById('convertBtn');
        this.clearBtn = document.getElementById('clearBtn');
        this.progressContainer = document.getElementById('progressContainer');
        this.progressFill = document.getElementById('progressFill');
        this.progressText = document.getElementById('progressText');
        this.summary = document.getElementById('summary');
        this.sampleRateSelect = document.getElementById('sampleRateSelect');
        this.loudnessSelect = document.getElementById('loudnessSelect');
        this.formatSelect = document.getElementById('formatSelect');
        this.bitrateSelect = document.getElementById('bitrateSelect');
    }

    bindEvents() {
        // 文件选择 - 使用捕获阶段确保触发
        this.fileInput.addEventListener('change', (e) => {
            console.log('File input change:', e.target.files?.length, 'files');
            if (e.target.files?.length > 0) {
                this.handleFiles(e.target.files);
                // 重置以便再次选择相同文件
                e.target.value = '';
            }
        }, true);

        // 拖放
        this.uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.uploadZone.classList.add('dragover');
        });

        this.uploadZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.uploadZone.classList.remove('dragover');
        });

        this.uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.uploadZone.classList.remove('dragover');
            console.log('Drop:', e.dataTransfer.files?.length, 'files');
            if (e.dataTransfer.files?.length > 0) {
                this.handleFiles(e.dataTransfer.files);
            }
        });

        // 按钮
        this.convertBtn.addEventListener('click', () => this.startConversion());
        this.clearBtn.addEventListener('click', () => this.clearFiles());
    }

    handleFiles(fileList) {
        const supportedExts = /\.(mp3|mp4|m4a|m4v|mkv|mov|avi|webm|ogv|ogg|oga|wav|flac|aac|opus|weba)$/i;
        
        let added = 0;
        for (const file of fileList) {
            // 优先用扩展名判断，MIME type 不可靠
            const isSupported = supportedExts.test(file.name) || 
                file.type.startsWith('audio/') || 
                file.type.startsWith('video/');
            
            if (!isSupported) {
                console.log('Skipping unsupported file:', file.name, file.type);
                continue;
            }

            this.files.push({
                id: Date.now() + Math.random().toString(36).slice(2),
                file: file,
                name: file.name,
                size: file.size,
                status: 'pending',
                errorMessage: null,
                outputUrl: null,
                outputName: file.name.replace(/\.[^.]+$/, '') + '_normalized.m4a'
            });
            added++;
        }

        console.log('Added', added, 'files, total:', this.files.length);
        this.updateUI();
    }

    removeFile(id) {
        if (this.isConverting) return;
        const idx = this.files.findIndex(f => f.id === id);
        if (idx >= 0) {
            if (this.files[idx].outputUrl) {
                URL.revokeObjectURL(this.files[idx].outputUrl);
            }
            this.files.splice(idx, 1);
            this.updateUI();
        }
    }

    clearFiles() {
        if (this.isConverting) return;
        for (const f of this.files) {
            if (f.outputUrl) URL.revokeObjectURL(f.outputUrl);
        }
        this.files = [];
        this.updateUI();
    }

    updateUI() {
        const hasFiles = this.files.length > 0;
        
        // 控制面板显示/隐藏
        this.optionsPanel.style.display = hasFiles ? 'block' : 'none';
        this.actions.style.display = hasFiles ? 'flex' : 'none';
        
        // 渲染文件列表
        if (!hasFiles) {
            this.fileList.innerHTML = '';
            this.summary.innerHTML = '';
            return;
        }

        this.fileList.innerHTML = this.files.map(f => this.renderFileItem(f)).join('');
        this.updateSummary();
    }

    renderFileItem(f) {
        const statusClass = f.status;
        const statusText = this.getStatusText(f);
        const sizeText = this.formatSize(f.size);
        
        let downloadHtml = '';
        if (f.outputUrl) {
            downloadHtml = ` <a href="${f.outputUrl}" download="${f.outputName}" class="download-link">手动下载</a>`;
        }

        const removeBtn = !this.isConverting 
            ? `<button class="remove-btn" data-id="${f.id}">×</button>` 
            : '';

        return `
            <div class="file-item ${statusClass}" data-id="${f.id}">
                <div class="file-info">
                    <div class="file-name">${this.escapeHtml(f.name)}</div>
                    <div class="file-status ${statusClass}">${statusText}${downloadHtml}</div>
                </div>
                <div class="file-size">${sizeText}</div>
                ${removeBtn}
            </div>
        `;
    }

    getStatusText(f) {
        const map = {
            'pending': '等待中',
            'decoding': '解码中...',
            'analyzing': '分析响度...',
            'encoding': '编码中...',
            'done': '✓ 已保存到下载文件夹',
            'error': '✗ 错误',
            'no-audio': '⚠ 无音频轨道'
        };
        return map[f.status] || f.status;
    }

    updateSummary() {
        const total = this.files.length;
        const done = this.files.filter(f => f.status === 'done').length;
        const error = this.files.filter(f => f.status === 'error' || f.status === 'no-audio').length;
        const pending = this.files.filter(f => f.status === 'pending').length;

        let html = `共 ${total} 个文件`;
        if (done > 0) html += ` <span class="stat done">完成 ${done}</span>`;
        if (error > 0) html += ` <span class="stat error">失败 ${error}</span>`;
        if (pending > 0) html += ` <span class="stat">待处理 ${pending}</span>`;
        this.summary.innerHTML = html;

        // 绑定删除按钮事件（因为 innerHTML 重建了）
        this.fileList.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeFile(btn.dataset.id);
            });
        });
    }

    async startConversion() {
        const pendingFiles = this.files.filter(f => f.status === 'pending');
        if (pendingFiles.length === 0) {
            alert('没有待处理的文件');
            return;
        }

        this.isConverting = true;
        this.convertBtn.disabled = true;
        this.clearBtn.disabled = true;
        this.progressContainer.style.display = 'block';

        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        const total = pendingFiles.length;
        for (let i = 0; i < total; i++) {
            const fileObj = pendingFiles[i];
            const progress = (i / total) * 100;
            this.updateProgress(progress, `(${i+1}/${total}) ${fileObj.name}`);
            
            fileObj.status = 'decoding';
            this.updateUI();

            try {
                await this.processFile(fileObj, (p) => {
                    const overall = progress + (p / total) * 100;
                    this.updateProgress(overall, `(${i+1}/${total}) ${fileObj.name} - ${Math.round(p)}%`);
                });
            } catch (err) {
                console.error('Process error:', err);
                fileObj.status = 'error';
                fileObj.errorMessage = err.message;
                this.updateUI();
            }
        }

        this.updateProgress(100, '全部完成');
        this.isConverting = false;
        this.convertBtn.disabled = false;
        this.clearBtn.disabled = false;
        this.updateUI();
    }

    async processFile(fileObj, onProgress) {
        const { file } = fileObj;

        // 1. 读取并解码
        onProgress(5);
        const arrayBuffer = await file.arrayBuffer();
        
        let audioBuffer;
        try {
            audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));
        } catch (e) {
            throw new Error('无法解码音频（文件可能损坏或无音频轨道）');
        }

        if (audioBuffer.numberOfChannels === 0 || audioBuffer.length === 0) {
            throw new Error('音频数据为空');
        }

        // 2. 参数
        const targetSampleRate = parseInt(this.sampleRateSelect.value) || audioBuffer.sampleRate;
        const targetLoudness = parseFloat(this.loudnessSelect.value);
        
        // 3. 重采样（如需要）
        onProgress(15);
        let pcmBuffer = audioBuffer;
        if (targetSampleRate !== audioBuffer.sampleRate) {
            fileObj.status = 'decoding';
            this.updateUI();
            pcmBuffer = await this.resample(audioBuffer, targetSampleRate);
        }

        // 4. 计算 RMS
        onProgress(30);
        fileObj.status = 'analyzing';
        this.updateUI();
        const rms = this.calculateRMS(pcmBuffer);
        
        if (rms <= 0.0001) {
            throw new Error('音频音量太低或数据异常');
        }

        // 5. 计算增益
        const targetRms = Math.pow(10, (targetLoudness + 0.691) / 20);
        let gain = targetRms / rms;
        gain = Math.max(0.25, Math.min(4.0, gain)); // -12dB ~ +12dB
        console.log('RMS:', rms, 'Target RMS:', targetRms, 'Gain:', gain);

        // 6. 编码输出
        onProgress(50);
        fileObj.status = 'encoding';
        this.updateUI();

        const outputFormat = this.formatSelect.value;
        const bitrate = parseInt(this.bitrateSelect.value);
        let outputBlob;

        if (outputFormat === 'wav') {
            // 用户选了 WAV
            outputBlob = await this.encodeWAV(pcmBuffer, gain, onProgress);
            fileObj.outputName = fileObj.name.replace(/\.[^.]+$/, '') + '_normalized.wav';
        } else if (this.hasWebCodecs) {
            // 用户选了 AAC，且浏览器支持 WebCodecs
            try {
                outputBlob = await this.encodeAAC(pcmBuffer, gain, bitrate, onProgress);
                fileObj.outputName = fileObj.name.replace(/\.[^.]+$/, '') + '_normalized.m4a';
            } catch (e) {
                console.warn('AAC encoding failed, falling back to WAV:', e);
                alert(`AAC 编码失败：${e.message}\n已降级为 WAV 格式`);
                outputBlob = await this.encodeWAV(pcmBuffer, gain, onProgress);
                fileObj.outputName = fileObj.name.replace(/\.[^.]+$/, '') + '_normalized.wav';
            }
        } else {
            // 用户选了 AAC 但浏览器不支持，降级 WAV
            console.log('WebCodecs not supported, using WAV');
            alert('当前浏览器不支持 AAC 编码（需要 Chrome 94+ 或 Edge 94+），已自动切换为 WAV 格式');
            outputBlob = await this.encodeWAV(pcmBuffer, gain, onProgress);
            fileObj.outputName = fileObj.name.replace(/\.[^.]+$/, '') + '_normalized.wav';
        }

        // 7. 创建下载链接并自动下载
        fileObj.outputUrl = URL.createObjectURL(outputBlob);
        fileObj.status = 'done';
        this.updateUI();
        
        // 自动触发下载到本地文件夹
        this.autoDownload(fileObj);
    }

    /**
     * 自动触发文件下载
     */
    autoDownload(fileObj) {
        try {
            const a = document.createElement('a');
            a.href = fileObj.outputUrl;
            a.download = fileObj.outputName;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            // 延迟移除，确保下载开始
            setTimeout(() => document.body.removeChild(a), 100);
            console.log('Auto-download triggered:', fileObj.outputName);
        } catch (e) {
            console.warn('Auto-download failed (browser may block):', e);
            // 降级：显示下载链接供手动点击
        }
    }

    async resample(audioBuffer, targetSampleRate) {
        const offlineCtx = new OfflineAudioContext(
            audioBuffer.numberOfChannels,
            Math.ceil(audioBuffer.duration * targetSampleRate),
            targetSampleRate
        );
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start();
        return await offlineCtx.startRendering();
    }

    calculateRMS(audioBuffer) {
        let sumSquares = 0;
        let totalSamples = 0;
        
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
            const data = audioBuffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
                sumSquares += data[i] * data[i];
            }
            totalSamples += data.length;
        }
        
        return totalSamples > 0 ? Math.sqrt(sumSquares / totalSamples) : 0;
    }

    async encodeAAC(audioBuffer, gain, bitrate, onProgress) {
        const sampleRate = audioBuffer.sampleRate;
        const channels = audioBuffer.numberOfChannels;
        const length = audioBuffer.length;
        const chunkSize = 1024;

        // 准备带增益的 PCM 数据
        const channelData = [];
        for (let ch = 0; ch < channels; ch++) {
            const original = audioBuffer.getChannelData(ch);
            const amplified = new Float32Array(length);
            for (let i = 0; i < length; i++) {
                amplified[i] = Math.max(-1, Math.min(1, original[i] * gain));
            }
            channelData.push(amplified);
        }

        const chunks = [];
        const encoder = new AudioEncoder({
            output: (chunk, meta) => chunks.push({ chunk, meta }),
            error: (e) => { throw new Error('Encoder error: ' + e.message); }
        });

        encoder.configure({
            codec: 'mp4a.40.2', // AAC-LC
            sampleRate: sampleRate,
            numberOfChannels: channels,
            bitrate: bitrate
        });

        // 分块编码
        for (let offset = 0; offset < length; offset += chunkSize) {
            const frameLen = Math.min(chunkSize, length - offset);
            
            // 交错格式 (interleaved) 转平面格式 (planar)
            const planarData = new Float32Array(frameLen * channels);
            for (let ch = 0; ch < channels; ch++) {
                for (let i = 0; i < frameLen; i++) {
                    planarData[ch * frameLen + i] = channelData[ch][offset + i];
                }
            }

            const audioData = new AudioData({
                format: 'f32-planar',
                sampleRate: sampleRate,
                numberOfFrames: frameLen,
                numberOfChannels: channels,
                timestamp: Math.round((offset / sampleRate) * 1e6),
                data: planarData
            });

            encoder.encode(audioData);
            audioData.close();

            // 进度更新
            const progress = 50 + (offset / length) * 45;
            onProgress(progress);
            
            // 让出主线程
            if (offset % (chunkSize * 10) === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        await encoder.flush();
        encoder.close();
        onProgress(95);

        console.log('AAC encoding complete, chunks:', chunks.length);
        if (chunks.length === 0) {
            throw new Error('编码器未输出任何数据');
        }

        // 封装为 ADTS AAC
        const blob = this.buildADTS(chunks, sampleRate, channels);
        console.log('ADTS blob created, size:', blob.size);
        return blob;
    }

    buildADTS(chunks, sampleRate, channels) {
        const sampleRateIndex = {
            96000: 0, 88200: 1, 64000: 2, 48000: 3,
            44100: 4, 32000: 5, 24000: 6, 22050: 7,
            16000: 8, 12000: 9, 11025: 10, 8000: 11
        };
        const srIndex = sampleRateIndex[sampleRate] ?? 4;
        const channelConfig = channels;

        console.log('Building ADTS, sampleRate:', sampleRate, 'channels:', channels, 'srIndex:', srIndex);

        const adtsFrames = [];
        for (const { chunk } of chunks) {
            const frameData = new Uint8Array(chunk.byteLength);
            chunk.copyTo(frameData);

            const frameLen = frameData.length + 7;
            const header = new Uint8Array(7);

            header[0] = 0xFF;  // syncword
            header[1] = 0xF1;  // syncword + MPEG-4 + no CRC
            header[2] = (0b01 << 6) | (srIndex << 2) | (0 << 1) | ((channelConfig >> 2) & 1);
            header[3] = ((channelConfig & 0x3) << 6) | ((frameLen >> 11) & 0x3);
            header[4] = (frameLen >> 3) & 0xFF;
            header[5] = ((frameLen & 0x7) << 5) | 0x1F;
            header[6] = 0xFC;

            const adtsFrame = new Uint8Array(frameLen);
            adtsFrame.set(header, 0);
            adtsFrame.set(frameData, 7);
            adtsFrames.push(adtsFrame);
        }

        const totalLen = adtsFrames.reduce((sum, f) => sum + f.length, 0);
        console.log('ADTS frames:', adtsFrames.length, 'total size:', totalLen);

        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const frame of adtsFrames) {
            result.set(frame, offset);
            offset += frame.length;
        }

        // 使用 audio/mp4 MIME 类型，因为 .m4a 是 MP4 容器
        return new Blob([result], { type: 'audio/mp4' });
    }

    async encodeWAV(audioBuffer, gain, onProgress) {
        const channels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length;
        const bytesPerSample = 2;
        const dataSize = length * channels * bytesPerSample;

        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        // WAV header
        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        this.writeString(view, 8, 'WAVE');
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * channels * bytesPerSample, true);
        view.setUint16(32, channels * bytesPerSample, true);
        view.setUint16(34, 16, true);
        this.writeString(view, 36, 'data');
        view.setUint32(40, dataSize, true);

        // PCM data with gain
        const channelData = [];
        for (let ch = 0; ch < channels; ch++) {
            channelData.push(audioBuffer.getChannelData(ch));
        }

        let offset = 44;
        for (let i = 0; i < length; i++) {
            for (let ch = 0; ch < channels; ch++) {
                let sample = channelData[ch][i] * gain;
                sample = Math.max(-1, Math.min(1, sample));
                view.setInt16(offset, sample * 0x7FFF, true);
                offset += 2;
            }

            if (i % 8192 === 0) {
                const progress = 50 + (i / length) * 45;
                onProgress(progress);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        onProgress(95);
        return new Blob([buffer], { type: 'audio/wav' });
    }

    writeString(view, offset, str) {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    updateProgress(percent, text) {
        this.progressFill.style.width = Math.min(100, percent) + '%';
        this.progressText.textContent = text || `${Math.round(percent)}%`;
    }

    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

// Browser support check
document.addEventListener('DOMContentLoaded', () => {
    const supportDiv = document.getElementById('browserSupport');
    const checks = [];
    
    // Web Audio API
    if (window.AudioContext || window.webkitAudioContext) {
        checks.push('<span class="supported">✓ Web Audio API</span>');
    } else {
        checks.push('<span class="unsupported">✗ Web Audio API (必需)</span>');
    }
    
    // WebCodecs (for AAC)
    if (typeof AudioEncoder !== 'undefined') {
        checks.push('<span class="supported">✓ AAC 编码 (Chrome/Edge)</span>');
    } else {
        checks.push('<span class="unsupported">⚠ 不支持 AAC，仅 WAV (建议用 Chrome)</span>');
    }
    
    supportDiv.innerHTML = checks.join(' · ');
    
    // Initialize app
    window.app = new AudioExtractor();
});

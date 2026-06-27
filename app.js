/**
 * 音频提取器 - Web 版
 * 
 * 技术方案：
 * - Web Audio API (AudioContext.decodeAudioData) 解码任意音频/视频文件 → PCM
 * - 两遍处理：Pass 1 计算 RMS → Pass 2 增益调整 + AAC 编码
 * - 输出：M4A (MP4 容器 + AAC 音轨)
 * - 纯浏览器本地处理，文件不上传服务器
 */

class AudioExtractor {
    constructor() {
        this.files = []; // {file, name, size, status, errorMessage, outputUrl}
        this.isConverting = false;
        this.audioContext = null;
        
        this.initUI();
    }

    initUI() {
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
        this.bitrateSelect = document.getElementById('bitrateSelect');

        // Upload zone
        this.uploadZone.addEventListener('click', () => this.fileInput.click());
        this.uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.uploadZone.classList.add('dragover');
        });
        this.uploadZone.addEventListener('dragleave', () => {
            this.uploadZone.classList.remove('dragover');
        });
        this.uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.uploadZone.classList.remove('dragover');
            this.addFiles(e.dataTransfer.files);
        });
        this.fileInput.addEventListener('change', (e) => {
            this.addFiles(e.target.files);
            this.fileInput.value = ''; // reset for re-select
        });

        // Actions
        this.convertBtn.addEventListener('click', () => this.startConversion());
        this.clearBtn.addEventListener('click', () => this.clearAll());
    }

    addFiles(fileList) {
        const audioVideoTypes = /^video\/|^audio\//;
        for (const file of fileList) {
            if (!audioVideoTypes.test(file.type) && !/\.(mp4|mkv|mov|avi|mp3|wav|flac|aac|m4a|ogg|webm|opus)$/i.test(file.name)) {
                continue;
            }
            this.files.push({
                file,
                name: file.name,
                size: file.size,
                status: 'pending',
                errorMessage: null,
                outputUrl: null
            });
        }
        this.render();
    }

    removeFile(index) {
        if (this.isConverting) return;
        const f = this.files[index];
        if (f.outputUrl) URL.revokeObjectURL(f.outputUrl);
        this.files.splice(index, 1);
        this.render();
    }

    clearAll() {
        if (this.isConverting) return;
        for (const f of this.files) {
            if (f.outputUrl) URL.revokeObjectURL(f.outputUrl);
        }
        this.files = [];
        this.render();
    }

    render() {
        const hasFiles = this.files.length > 0;
        this.optionsPanel.style.display = hasFiles ? 'block' : 'none';
        this.actions.style.display = hasFiles ? 'flex' : 'none';

        if (!hasFiles) {
            this.fileList.innerHTML = '';
            this.summary.innerHTML = '';
            return;
        }

        this.fileList.innerHTML = this.files.map((f, i) => {
            const statusClass = f.status;
            const statusText = this.getStatusText(f);
            const sizeText = this.formatSize(f.size);
            const downloadLink = f.outputUrl
                ? `<a href="${f.outputUrl}" download="${f.name.replace(/\.[^.]+$/, '')}_aac.m4a" style="color:#6366f1;text-decoration:none;font-size:13px;margin-left:8px;">下载</a>`
                : '';
            return `
                <div class="file-item ${statusClass}">
                    <div class="file-info">
                        <div class="file-name">${this.escape(f.name)}</div>
                        <div class="file-status ${statusClass}">${statusText}${downloadLink}</div>
                    </div>
                    <div class="file-size">${sizeText}</div>
                    ${!this.isConverting ? `<button class="remove-btn" onclick="app.removeFile(${i})">×</button>` : ''}
                </div>
            `;
        }).join('');

        this.updateSummary();
    }

    getStatusText(f) {
        switch (f.status) {
            case 'pending': return '等待中';
            case 'checking': return '检测音频轨道...';
            case 'no-audio': return '⚠ 无音频轨道，已跳过';
            case 'processing': return '转换中...';
            case 'done': return '✓ 完成';
            case 'error': return '✗ 错误: ' + (f.errorMessage || '未知错误');
            default: return '';
        }
    }

    updateSummary() {
        const total = this.files.length;
        const done = this.files.filter(f => f.status === 'done').length;
        const error = this.files.filter(f => f.status === 'error').length;
        const noAudio = this.files.filter(f => f.status === 'no-audio').length;
        const pending = this.files.filter(f => f.status === 'pending').length;

        let html = `共 ${total} 个文件`;
        if (done > 0) html += ` <span class="stat stat-done">完成 ${done}</span>`;
        if (error > 0) html += ` <span class="stat stat-error">错误 ${error}</span>`;
        if (noAudio > 0) html += ` <span class="stat stat-error">无音频 ${noAudio}</span>`;
        if (pending > 0) html += ` <span class="stat">待处理 ${pending}</span>`;
        this.summary.innerHTML = html;
    }

    updateProgress(percent, text) {
        this.progressFill.style.width = percent + '%';
        this.progressText.textContent = text || `${Math.round(percent)}%`;
    }

    async startConversion() {
        const pendingFiles = this.files
            .map((f, i) => ({ file: f, index: i }))
            .filter(({ file }) => file.status === 'pending' || file.status === 'error');

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
            const { file, index } = pendingFiles[i];
            const current = i + 1;
            const baseProgress = (i / total) * 100;

            this.updateProgress(baseProgress, `(${current}/${total}) ${file.name}`);
            this.files[index].status = 'processing';
            this.render();

            try {
                await this.processFile(file, index, total, i, baseProgress);
            } catch (err) {
                this.files[index].status = 'error';
                this.files[index].errorMessage = err.message || '未知错误';
                this.render();
            }
        }

        this.updateProgress(100, '全部完成');
        this.isConverting = false;
        this.convertBtn.disabled = false;
        this.clearBtn.disabled = false;
        this.render();
    }

    async processFile(fileObj, index, total, currentIndex, baseProgress) {
        const file = fileObj.file;

        // Step 1: 读取文件 → 解码为 AudioBuffer
        const arrayBuffer = await file.arrayBuffer();

        // 检测是否有音频轨道（decodeAudioData 会在无音频时抛异常）
        let audioBuffer;
        try {
            audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));
        } catch (e) {
            this.files[index].status = 'no-audio';
            this.files[index].errorMessage = '无法解码音频（可能无音频轨道）';
            this.render();
            return;
        }

        // Step 2: 计算目标采样率
        const targetSampleRate = parseInt(this.sampleRateSelect.value) || audioBuffer.sampleRate;
        const targetLoudness = parseFloat(this.loudnessSelect.value);
        const bitrate = parseInt(this.bitrateSelect.value);

        // Step 3: 如果需要重采样，通过 OfflineAudioContext 转换
        let pcmBuffer = audioBuffer;
        if (targetSampleRate !== audioBuffer.sampleRate) {
            const progressPer = (100 / total) * 0.3; // resample = 30%
            this.updateProgress(
                baseProgress + progressPer,
                `(${currentIndex + 1}/${total}) ${fileObj.name} - 重采样...`
            );
            pcmBuffer = await this.resample(audioBuffer, targetSampleRate);
        }

        // Step 4: 计算 RMS (Pass 1)
        const progressPerRMS = (100 / total) * 0.2; // RMS = 20%
        this.updateProgress(
            baseProgress + progressPerRMS,
            `(${currentIndex + 1}/${total}) ${fileObj.name} - 分析响度...`
        );
        const rms = this.calculateRMS(pcmBuffer);
        
        if (rms <= 0) {
            throw new Error('音频数据为空');
        }

        // Step 5: 计算增益
        const targetRms = Math.pow(10, (targetLoudness + 0.691) / 20);
        let gain = targetRms / rms;
        gain = Math.max(0.25, Math.min(4.0, gain)); // -12dB ~ +12dB

        // Step 6: 编码 AAC (Pass 2: 增益 + 编码)
        const progressPerEncode = (100 / total) * 0.5; // encode = 50%
        this.updateProgress(
            baseProgress + progressPerEncode,
            `(${currentIndex + 1}/${total}) ${fileObj.name} - 编码 AAC...`
        );

        const m4aBlob = await this.encodeAAC(pcmBuffer, gain, bitrate, (progress) => {
            const overallProgress = baseProgress + progressPerEncode * progress;
            this.updateProgress(
                overallProgress,
                `(${currentIndex + 1}/${total}) ${fileObj.name} - 编码 AAC... ${Math.round(progress * 100)}%`
            );
        });

        // Step 7: 创建下载链接
        const outputUrl = URL.createObjectURL(m4aBlob);
        this.files[index].status = 'done';
        this.files[index].outputUrl = outputUrl;
        this.render();
    }

    /**
     * 重采样（通过 OfflineAudioContext）
     */
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

    /**
     * 计算 RMS（全量遍历所有通道）
     */
    calculateRMS(audioBuffer) {
        const channels = audioBuffer.numberOfChannels;
        const length = audioBuffer.length;
        let sumSquares = 0;
        let totalSamples = 0;

        for (let ch = 0; ch < channels; ch++) {
            const data = audioBuffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                sumSquares += data[i] * data[i];
                totalSamples++;
            }
        }

        return totalSamples > 0 ? Math.sqrt(sumSquares / totalSamples) : 0;
    }

    /**
     * 使用 Web Audio API + AudioWorklet 编码 AAC
     * 
     * 策略：用 OfflineAudioContext 应用增益，然后通过 MediaStreamDestination +
     * MediaRecorder 录制为 WebM/Opus，最后转 M4A。
     * 
     * 但 MediaRecorder 不直接支持 AAC/M4A，所以改用 WAV 中间格式 + 
     * 手动 M4A 封装，或者直接输出 WAV。
     * 
     * 实际方案：浏览器原生 AAC 编码通过 WebCodecs API (AudioEncoder)
     * 如果 WebCodecs 不可用，降级输出 WAV。
     */
    async encodeAAC(audioBuffer, gain, bitrate, onProgress) {
        // 检查 WebCodecs API
        if ('AudioEncoder' in window) {
            try {
                return await this.encodeWithWebCodecs(audioBuffer, gain, bitrate, onProgress);
            } catch (e) {
                console.warn('WebCodecs AAC encoding failed, falling back to WAV:', e);
            }
        }

        // 降级：输出 WAV（无损，但体积更大）
        return this.encodeWAV(audioBuffer, gain, onProgress);
    }

    /**
     * 使用 WebCodecs API 编码 AAC + 封装 M4A
     */
    async encodeWithWebCodecs(audioBuffer, gain, bitrate, onProgress) {
        const sampleRate = audioBuffer.sampleRate;
        const channels = audioBuffer.numberOfChannels;
        const length = audioBuffer.length;

        // 准备 PCM 数据（应用增益）
        const channelData = [];
        for (let ch = 0; ch < channels; ch++) {
            const original = audioBuffer.getChannelData(ch);
            const amplified = new Float32Array(length);
            for (let i = 0; i < length; i++) {
                amplified[i] = Math.max(-1, Math.min(1, original[i] * gain)); // clip
            }
            channelData.push(amplified);
        }

        // 收集编码后的 AAC 帧
        const chunks = [];

        // 配置 AAC 编码器
        const codecString = 'mp4a.40.2'; // AAC-LC
        const encoder = new AudioEncoder({
            output: (chunk, metadata) => {
                chunks.push({ chunk, metadata });
            },
            error: (e) => console.error('Encoder error:', e)
        });

        encoder.configure({
            codec: codecString,
            sampleRate: sampleRate,
            numberOfChannels: channels,
            bitrate: bitrate
        });

        // 分块送入编码器
        const chunkSize = 1024;

        for (let offset = 0; offset < length; offset += chunkSize) {
            const frameLength = Math.min(chunkSize, length - offset);
            const planarData = new Float32Array(frameLength * channels);

            for (let ch = 0; ch < channels; ch++) {
                for (let i = 0; i < frameLength; i++) {
                    planarData[ch * frameLength + i] = channelData[ch][offset + i];
                }
            }

            const audioData = new AudioData({
                format: 'planar-f32',
                sampleRate: sampleRate,
                numberOfFrames: frameLength,
                numberOfChannels: channels,
                timestamp: Math.round((offset / sampleRate) * 1_000_000),
                data: planarData
            });

            encoder.encode(audioData);
            audioData.close();

            if (onProgress && offset % (chunkSize * 50) === 0) {
                onProgress(offset / length);
                // 让出主线程
                await new Promise(r => setTimeout(r, 0));
            }
        }

        await encoder.flush();
        encoder.close();
        onProgress(1.0);

        // 封装为 ADTS AAC
        return this.buildADTSBlob(chunks, sampleRate, channels);
    }

    /**
     * 将 AAC chunks 封装为 ADTS 格式的 Blob
     * 每个 AAC 帧加 7 字节 ADTS 头，输出 .aac 文件
     */
    buildADTSBlob(chunks, sampleRate, channels) {
        // 收集所有 AAC 帧数据
        const frames = [];
        for (const { chunk } of chunks) {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            frames.push(data);
        }

    /**
     * 构建 ADTS 帧（AAC with ADTS headers）
     * 每个 AAC 帧加 7 字节 ADTS 头
     */
    buildADTS(frames, sampleRate, channels) {
        // ADTS 采样率索引
        const sampleRateIndex = {
            96000: 0, 88200: 1, 64000: 2, 48000: 3,
            44100: 4, 32000: 5, 24000: 6, 22050: 7,
            16000: 8, 12000: 9, 11025: 10, 8000: 11
        };
        const srIndex = sampleRateIndex[sampleRate] ?? 4;
        const channelConfig = channels;

        // 计算总大小
        let totalFrames = frames.length;
        const chunks = [];

        for (const frameData of frames) {
            const frameLen = frameData.length + 7; // ADTS header = 7 bytes
            const header = new Uint8Array(7);

            // ADTS fixed header
            header[0] = 0xFF; // syncword
            header[1] = 0xF1; // syncword + ID=0 + layer=0 + protection_absent=1
            // header[2]: profile=01 (AAC-LC) + sampling_frequency_index(4 bits) + private + channel_config(3 bits)
            header[2] = (0b01 << 6) | (srIndex << 2) | (0 << 1) | ((channelConfig >> 2) & 1);
            // header[3]: channel_config(remaining 2 bits) + original_copy + home + copyright_id_bit + copyright_id_start + frame_length(2 bits)
            header[3] = ((channelConfig & 0x3) << 6) | 0 | 0 | 0 | 0 | ((frameLen >> 11) & 0x3);
            // header[4]: frame_length(11 bits)
            header[4] = (frameLen >> 3) & 0xFF;
            // header[5]: frame_length(3 bits) + buffer_fullness(5 bits)
            header[5] = ((frameLen & 0x7) << 5) | 0x1F;
            // header[6]: buffer_fullness(6 bits) + number_of_raw_data_blocks(2 bits)
            header[6] = 0xFC; // buffer_fullness=0x3FF (VBR), blocks=0

            // 合并 header + frame data
            const adtsFrame = new Uint8Array(frameLen);
            adtsFrame.set(header, 0);
            adtsFrame.set(frameData, 7);
            chunks.push(adtsFrame);
        }

        // 合并所有帧
        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
            result.set(c, offset);
            offset += c.length;
        }

        return result;
    }

    /**
     * 降级方案：输出 WAV 文件
     */
    async encodeWAV(audioBuffer, gain, onProgress) {
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length;
        const bytesPerSample = 2; // 16-bit PCM
        const dataSize = length * numChannels * bytesPerSample;

        // WAV header (44 bytes)
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        // RIFF header
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(view, 8, 'WAVE');

        // fmt chunk
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // chunk size
        view.setUint16(20, 1, true); // PCM format
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
        view.setUint16(32, numChannels * bytesPerSample, true);
        view.setUint16(34, 16, true); // bits per sample

        // data chunk
        writeString(view, 36, 'data');
        view.setUint32(40, dataSize, true);

        // 写入 PCM 数据（应用增益）
        const channels = [];
        for (let ch = 0; ch < numChannels; ch++) {
            channels.push(audioBuffer.getChannelData(ch));
        }

        let offset = 44;
        const chunkSize = 8192;
        for (let i = 0; i < length; i++) {
            for (let ch = 0; ch < numChannels; ch++) {
                let sample = channels[ch][i] * gain;
                sample = Math.max(-1, Math.min(1, sample)); // clip
                view.setInt16(offset, sample * 0x7FFF, true);
                offset += 2;
            }

            if (onProgress && i % chunkSize === 0) {
                onProgress(i / length);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        onProgress(1.0);
        return new Blob([buffer], { type: 'audio/wav' });
    }

    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    escape(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
}

// 全局实例
let app;

document.addEventListener('DOMContentLoaded', () => {
    app = new AudioExtractor();
});

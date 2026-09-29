import { PREVIEW_SAMPLES, PreviewSample } from './PreviewBankData';

/**
 * 浏览器侧的预览音频后端。
 *
 * ## 为什么需要它
 *
 * 正式音频走原生内核（`jsbPiano`），而 **Cocos 编辑器的预览跑在浏览器里，
 * 没有那一层** —— 不接这个后端，在编辑器里就永远听不到声音，没法评估手感、
 * 布局与力度响应。
 *
 * 音源是抽取出来的极小样本（见 tools/audio-pipeline/build_preview_bank.py），
 * 内嵌为 base64。变调、复音、踏板的行为与原生侧保持一致，
 * 这样在编辑器里调好的交互，到真机上表现一致。
 *
 * ## 与原生侧的差异（有意为之）
 *
 * - 用 `AudioBufferSourceNode.playbackRate` 变调，等同原生侧的 Hermite 重采样
 * - 没有释放采样（hammer / 弦共振），只有快速淡出 —— 预览不需要那层细节
 * - 复音上限 32（原生是 64），浏览器里再高没有意义
 *
 * ## 自动播放策略
 *
 * 浏览器禁止在用户交互之前启动 AudioContext。所以 context 是**懒创建**的，
 * 并且在第一次触摸时 `resume()`。这是浏览器的硬性限制，不是可以绕过的实现细节。
 */

/** 松开时的淡出时长（秒）。与原生侧的默认释放接近 */
const RELEASE_SECONDS = 0.12;
/** 浏览器侧的复音上限。比原生低 —— 预览不需要那么多 */
const MAX_VOICES = 32;

interface PreviewVoice {
    source: AudioBufferSourceNode;
    gain: GainNode;
    midi: number;
    releasing: boolean;
    releasedAt: number;
}

export class WebAudioEngine {
    private _ctx: AudioContext | null = null;
    private _master: GainNode | null = null;

    /** 与 PREVIEW_SAMPLES 同下标的解码结果；未解码完的为 undefined */
    private _buffers: (AudioBuffer | undefined)[] = [];
    private _decodeStarted = false;
    private _decodedCount = 0;
    private _decodeFailed = false;

    private _voices: PreviewVoice[] = [];
    private _pedalDown = false;

    /** 浏览器是否具备 Web Audio。不具备时整个后端不可用 */
    static supported(): boolean {
        const g = globalThis as unknown as Record<string, unknown>;
        return typeof g.AudioContext !== 'undefined' || typeof g.webkitAudioContext !== 'undefined';
    }

    /** 是否已初始化（AudioContext 已创建） */
    get available(): boolean {
        return this._ctx !== null;
    }

    /** 音源是否已全部解码完成 */
    get ready(): boolean {
        return this._decodedCount > 0 && this._decodedCount === PREVIEW_SAMPLES.length;
    }

    /** 解码进度 0..1 */
    get progress(): number {
        return PREVIEW_SAMPLES.length > 0
            ? this._decodedCount / PREVIEW_SAMPLES.length
            : 0;
    }

    get decodeFailed(): boolean {
        return this._decodeFailed;
    }

    get activeVoices(): number {
        return this._voices.length;
    }

    /**
     * 初始化：创建 AudioContext 并开始解码音源。
     *
     * 可以重复调用。解码在后台进行，完成前触发的音符会静默丢弃 ——
     * 与其等它，不如让交互先跑起来。
     */
    init(): boolean {
        if (!WebAudioEngine.supported()) {
            return false;
        }
        if (this._ctx) {
            return true;
        }

        const g = globalThis as unknown as {
            AudioContext?: typeof AudioContext;
            webkitAudioContext?: typeof AudioContext;
        };
        const Ctor = g.AudioContext ?? g.webkitAudioContext;
        if (!Ctor) {
            return false;
        }

        this._ctx = new Ctor();
        this._master = this._ctx.createGain();
        this._master.gain.value = 0.8;
        this._master.connect(this._ctx.destination);

        this.startDecoding();
        return true;
    }

    /**
     * 用户手势后调用。
     *
     * 浏览器的自动播放策略要求 AudioContext 必须在用户交互之后才能运行，
     * 否则它会停在 suspended 状态、静默不出声。触摸开始是最自然的时机。
     */
    resume(): void {
        if (this._ctx && this._ctx.state === 'suspended') {
            void this._ctx.resume();
        }
    }

    // ---------------------------------------------------------------- 解码

    private startDecoding(): void {
        if (this._decodeStarted || !this._ctx) {
            return;
        }
        this._decodeStarted = true;
        this._buffers = new Array(PREVIEW_SAMPLES.length);

        for (let i = 0; i < PREVIEW_SAMPLES.length; ++i) {
            const sample = PREVIEW_SAMPLES[i];
            const bytes = base64ToBytes(sample.mp3);

            // decodeAudioData 需要一个独立的 ArrayBuffer —— 传共享的 Uint8Array
            // 在某些浏览器上会因为 buffer 被回收而失败
            this._ctx.decodeAudioData(
                bytes.buffer,
                (buffer) => {
                    this._buffers[i] = buffer;
                    this._decodedCount++;
                },
                () => {
                    this._decodeFailed = true;
                },
            );
        }
    }

    // ---------------------------------------------------------------- 演奏

    /**
     * 触发一个音。
     *
     * @param velocity 0..1
     */
    noteOn(midi: number, velocity: number): void {
        if (!this._ctx || !this._master) {
            return;
        }

        const midiVelocity = Math.max(1, Math.min(127, Math.round(velocity * 127)));
        const index = this.pickSample(midi, midiVelocity);
        if (index < 0) {
            return;
        }
        const buffer = this._buffers[index];
        if (!buffer) {
            return;   // 还没解码完，丢弃
        }

        const sample = PREVIEW_SAMPLES[index];

        // 同一个音重触发时先掐掉旧的，否则两个音会叠起来
        this.stopVoicesFor(midi, 0.01);

        if (this._voices.length >= MAX_VOICES) {
            this.stealVoice();
        }

        const source = this._ctx.createBufferSource();
        source.buffer = buffer;
        // 变调：采样是按小三度铺的，这里补上到目标音高的差值
        source.playbackRate.value = Math.pow(2, (midi - sample.midi) / 12);

        const gain = this._ctx.createGain();
        // 层内微调，与原生侧同思路：层选择负责大跨度动态，这里只做 ±3dB 的细调
        gain.gain.value = withinLayerGain(midiVelocity, sample);

        source.connect(gain);
        gain.connect(this._master);
        source.start();

        const voice: PreviewVoice = { source, gain, midi, releasing: false, releasedAt: 0 };
        this._voices.push(voice);

        // 采样播完自动回收
        source.onended = () => {
            const at = this._voices.indexOf(voice);
            if (at >= 0) {
                this._voices.splice(at, 1);
            }
            try { gain.disconnect(); } catch { /* 已断开 */ }
        };
    }

    /** 松开一个音。踏板踩着时只挂起。 */
    noteOff(midi: number): void {
        if (this._pedalDown) {
            return;   // 制音器没落下，等踏板抬起
        }
        this.releaseVoicesFor(midi);
    }

    setPedal(down: boolean): void {
        if (this._pedalDown === down) {
            return;
        }
        this._pedalDown = down;
        if (!down) {
            // 抬踏板：把所有未松开的音放掉
            for (const voice of this._voices) {
                if (!voice.releasing && voice.releasedAt === 0) {
                    this.release(voice);
                }
            }
        }
    }

    allNotesOff(): void {
        this.stopVoicesFor(-1, 0.02);
    }

    // ---------------------------------------------------------------- 内部

    private release(voice: PreviewVoice): void {
        if (!this._ctx || !voice || voice.releasing) {
            return;
        }
        voice.releasing = true;
        const now = this._ctx.currentTime;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);
        try {
            voice.source.stop(now + RELEASE_SECONDS + 0.02);
        } catch {
            /* 已经停了 */
        }
    }

    private releaseVoicesFor(midi: number): void {
        for (const voice of this._voices) {
            if (!voice.releasing && (midi < 0 || voice.midi === midi)) {
                // releasedAt 为 0 表示「还没被踏板挂起过」，用它区分
                voice.releasedAt = 1;
                this.release(voice);
            }
        }
    }

    private stopVoicesFor(midi: number, fade: number): void {
        if (!this._ctx) {
            return;
        }
        const now = this._ctx.currentTime;
        for (const voice of this._voices) {
            if (midi >= 0 && voice.midi !== midi) {
                continue;
            }
            try {
                voice.gain.gain.cancelScheduledValues(now);
                voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
                voice.gain.gain.linearRampToValueAtTime(0, now + fade);
                voice.source.stop(now + fade + 0.01);
            } catch {
                /* 已经停了 */
            }
        }
    }

    /** 复音用满时掐掉最早的一个 */
    private stealVoice(): void {
        const oldest = this._voices[0];
        if (oldest) {
            this.stopVoicesFor(oldest.midi, 0.02);
        }
    }

    /**
     * 挑一条最合适的采样。
     *
     * 先按力度定层，再在该层里找最近的根音 —— 顺序不能反：
     * 音色主要由力度层决定，根音差异只影响一个半音以内的变调。
     */
    private pickSample(midi: number, velocity: number): number {
        // 第一阶段：按「层中心离力度最近」定层。
        //
        // ⚠️ 不能用「力度落在层区间内」来判定。抽取时只保留少数几层，
        // 区间之间**天生有空隙**（比如只留第 1 层和第 16 层时，27-120
        // 整段都没人管）。按包含关系判定会让绝大多数正常力度落空，
        // 只能靠回退随便挑一个 —— 结果总是用到最轻的那层，声音又小又闷。
        let bestCenterDistance = Number.MAX_SAFE_INTEGER;
        let bandLo = -1;
        let bandHi = -1;

        for (const sample of PREVIEW_SAMPLES) {
            const center = 0.5 * (sample.minVelocity + sample.maxVelocity);
            const distance = Math.abs(velocity - center);
            if (distance < bestCenterDistance) {
                bestCenterDistance = distance;
                bandLo = sample.minVelocity;
                bandHi = sample.maxVelocity;
            }
        }
        if (bandLo < 0) {
            return -1;
        }

        // 第二阶段：在该层里找最近的根音。
        // 顺序不能反 —— 音色主要由力度层决定，根音差异只影响一个半音以内的变调。
        let best = -1;
        let bestDistance = Number.MAX_SAFE_INTEGER;
        for (let i = 0; i < PREVIEW_SAMPLES.length; ++i) {
            const sample = PREVIEW_SAMPLES[i];
            if (sample.minVelocity !== bandLo || sample.maxVelocity !== bandHi) {
                continue;
            }
            if (!this._buffers[i]) {
                continue;   // 还没解码完
            }
            const distance = Math.abs(sample.midi - midi);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = i;
            }
        }
        return best;
    }
}

/** 层内力度微调，与原生侧 VoicePool::velocityGain 同思路 */
function withinLayerGain(velocity: number, sample: PreviewSample): number {
    const span = sample.maxVelocity - sample.minVelocity;
    if (span <= 0) {
        return 1;
    }
    const center = 0.5 * (sample.minVelocity + sample.maxVelocity);
    const t = Math.max(-1, Math.min(1, (velocity - center) / (span * 0.5)));
    // ±3 dB
    return Math.pow(10, (t * 3) / 20);
}

/** base64 → Uint8Array */
function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

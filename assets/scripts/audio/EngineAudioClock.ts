import { AudioClock } from './AudioClock';
import { PianoEngine } from './PianoEngine';

/**
 * 用音频内核当时间源的时钟。
 *
 * 单独放一个文件、而不是塞进 `AudioClock.ts` —— 那会让 `AudioClock.ts`
 * 通过 import 链把 `cc` 拖进来，`EventBatcher` 就又回到测不了的状态。
 * 这个文件属于「运行时胶水」，不进宿主测试的编译清单。
 */
export class EngineAudioClock implements AudioClock {
    constructor(private readonly _engine: PianoEngine) {}

    /** UI 时钟。这里就是 `performance.now()`，与预览平台一致 */
    now(): number {
        return performance.now();
    }

    /**
     * 音频流时钟。
     *
     * 拿不到音频时钟（预览后端、或原生流还没起来）时回退到 `performance.now()` ——
     * 这样偏移会算出 0，事件时间戳退化为「立即发声 + 前瞻」：
     * 在预览里这是正确行为，也让人工排查时读数里的时间戳仍然有意义。
     *
     * 注意这个回退**不能**放进门面：`EventBatcher` 需要靠「0」判断
     * 「还不能做时钟校准」，门面一旦回退，那个判断就永远成立了。
     */
    streamTimeMs(): number {
        const audioMs = this._engine.getStreamTimeMs();
        return audioMs > 0 ? audioMs : performance.now();
    }
}

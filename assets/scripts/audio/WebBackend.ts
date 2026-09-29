import { AudioBackend, BackendDiagnostics } from './AudioBackend';
import { decodeEventAt, DecodedEvent } from './EventCodec';
import { EventType } from './PianoTypes';
import { WebAudioEngine } from './WebAudioEngine';

/**
 * 浏览器预览后端 —— 包住 `WebAudioEngine`。
 *
 * 只用在编辑器预览/浏览器里。它把「16 字节事件」翻译成 Web Audio 的调用 ——
 * 这段映射原先长在门面（`PianoEngine.dispatchToWeb`）里，与后端选择混在一起，
 * 于是事件解码有两份实现（另一份在 C++），谁对谁错无从对照。
 */
export class WebBackend implements AudioBackend {
    readonly kind = 'web' as const;

    private readonly _web = new WebAudioEngine();

    /**
     * 能否接收事件。
     *
     * ⚠️ 用的是「音源解码完成」而不是「AudioContext 已创建」—— 解码期间
     * 事件确实会静默丢掉，但那属于启动瞬间的预期，不该被算成「丢事件」
     * （见 AudioBackend 里 available 与 submit 的自洽约定）。
     */
    get available(): boolean {
        return this._web.ready;
    }

    create(_sampleRate: number, _framesPerCallback: number): boolean {
        // AudioContext 会停在 suspended 直到用户交互 —— 那是浏览器的自动播放策略，
        // 靠 resume() 在首次触摸时解开（见 WebAudioEngine 的说明）。
        return this._web.init();
    }

    start(): boolean {
        // 解码是后台进行的，没有「启动」这一步
        return this._web.available;
    }

    stop(): void {
        // 预览不需要停流：页面切走时浏览器自己会挂起 AudioContext
    }

    dispose(): void {
        this._web.allNotesOff();
    }

    resume(): void {
        this._web.resume();
    }

    loadBank(_layerMask: number): boolean {
        // 预览音源是内嵌的极小子集，随脚本一起载入，没有「载入音源包」这一步
        return false;
    }

    submit(buffer: ArrayBuffer, count: number): number {
        if (!this._web.ready || count <= 0) {
            return 0;   // 还没解码完，让这些事件过去
        }

        // 一次批量共用一个 DataView —— 每个事件都 new 一个会白白分配
        const view = new DataView(buffer);
        let handled = 0;
        for (let i = 0; i < count; ++i) {
            const event = decodeEventAt(view, i);
            if (!event) {
                break;   // 越界（调用方算错了条数），不要继续解
            }
            if (this.apply(event)) {
                ++handled;
            }
        }
        return handled;
    }

    /** @returns 该事件是否被预览后端处理（未处理的类型不计入受理数） */
    private apply(e: DecodedEvent): boolean {
        switch (e.type) {
            case EventType.NoteOn:
                this._web.noteOn(e.note, e.velocity / 127);
                return true;
            case EventType.NoteOff:
                this._web.noteOff(e.note);
                return true;
            case EventType.PedalDown:
                this._web.setPedal(true);
                return true;
            case EventType.PedalUp:
                this._web.setPedal(false);
                return true;
            case EventType.PedalValue:
                // 预览不支持半踏板，按 64 分界当全踏板用
                this._web.setPedal(e.note >= 64);
                return true;
            case EventType.AllNotesOff:
                this._web.allNotesOff();
                return true;
            default:
                return false;   // 其余类型（如 PitchBend）预览不处理
        }
    }

    setParam(_id: number, _value: number): void {
        // 预览不做音色参数（M4 的东西在原生侧）
    }

    setForceCurve(_points: Float32Array): void {}

    /**
     * 预览没有音频流时钟 —— 返回 0，由门面回退到 UI 时钟。
     *
     * 那样事件时间戳退化为「立即发声 + 前瞻」，在预览里正是想要的行为。
     */
    streamTimeMs(): number {
        return 0;
    }

    diagnostics(): BackendDiagnostics {
        return {
            kind: 'web',
            status: this.statusText(),
            voices: this._web.activeVoices,
            xrun: 0,
            framesPerBurst: 0,
            acceptedEvents: 0,
            droppedEvents: 0,
            residentBytes: 0,
        };
    }

    private statusText(): string {
        if (!this._web.available) {
            return '浏览器不支持 Web Audio';
        }
        if (!this._web.ready) {
            const percent = (this._web.progress * 100).toFixed(0);
            return this._web.decodeFailed ? '预览音源解码失败' : `预览音源载入中 ${percent}%`;
        }
        return '预览音源就绪（Web Audio）';
    }
}

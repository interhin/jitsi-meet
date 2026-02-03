import { VIRTUAL_BACKGROUND_TYPE } from '../../virtual-background/constants';

import {
    CLEAR_TIMEOUT,
    SET_TIMEOUT,
    TIMEOUT_TICK,
    timerWorkerScript
} from './TimerWorker';

export interface IBackgroundEffectOptions {
    height: number;
    virtualBackground: {
        backgroundType?: string;
        blurValue?: number;
        virtualSource?: string;
    };
    width: number;
}

const FPS = 30;
const MASK_EDGE_BLUR_IMAGE_PX = 6;
const MASK_EDGE_BLUR_BLUR_PX = 10;
const FAST_ALPHA = 0.55;
const SLOW_ALPHA = 0.9;
const DELTA_MIN = 0.05;
const DELTA_MAX = 0.25;
const THRESH_UP = 0.65;
const THRESH_DOWN = 0.45;
const FEATHER = 0.12;

export default class JitsiStreamBackgroundEffect {
    _model: any;
    _options: IBackgroundEffectOptions;
    _stream: any;
    _segmentationPixelCount: number;

    _inputVideoElement: HTMLVideoElement;
    _maskFrameTimerWorker: Worker;

    _outputCanvasElement: HTMLCanvasElement;
    _outputCanvasCtx: CanvasRenderingContext2D | null;

    _segmentationMaskCanvas: HTMLCanvasElement;
    _segmentationMaskCtx: CanvasRenderingContext2D | null;
    _segmentationMask: ImageData;

    _inputResizeCanvas: HTMLCanvasElement;
    _inputResizeCtx: CanvasRenderingContext2D | null;

    _virtualImage: HTMLImageElement;
    _virtualVideo: HTMLVideoElement;

    _prevAlpha: Float32Array | null;
    _prevBinary: Uint8Array | null;

    constructor(model: Object, options: IBackgroundEffectOptions) {
        this._options = options;

        if (this._options.virtualBackground.backgroundType === VIRTUAL_BACKGROUND_TYPE.IMAGE) {
            this._virtualImage = document.createElement('img');
            this._virtualImage.crossOrigin = 'anonymous';
            this._virtualImage.src = this._options.virtualBackground.virtualSource ?? '';
        }

        this._model = model;
        this._segmentationPixelCount = this._options.width * this._options.height;

        this._prevAlpha = null;
        this._prevBinary = null;

        this._onMaskFrameTimer = this._onMaskFrameTimer.bind(this);

        this._outputCanvasElement = document.createElement('canvas');
        this._outputCanvasElement.getContext('2d');

        this._inputVideoElement = document.createElement('video');

        this._segmentationMaskCanvas = document.createElement('canvas');
        this._segmentationMaskCanvas.width = this._options.width;
        this._segmentationMaskCanvas.height = this._options.height;
        this._segmentationMaskCtx = this._segmentationMaskCanvas.getContext('2d');

        this._inputResizeCanvas = document.createElement('canvas');
        this._inputResizeCanvas.width = this._options.width;
        this._inputResizeCanvas.height = this._options.height;
        this._inputResizeCtx = this._inputResizeCanvas.getContext('2d');
    }

    _onMaskFrameTimer(response: { data: { id: number; }; }) {
        if (response.data.id === TIMEOUT_TICK) {
            this._renderMask();
        }
    }

    _renderMask() {
        this._resizeSourceForModel();
        this._runInferenceAndBuildMask();
        this._runPostProcessing();

        this._maskFrameTimerWorker.postMessage({
            id: SET_TIMEOUT,
            timeMs: 1000 / FPS
        });
    }

    _resizeSourceForModel() {
        this._inputResizeCtx?.drawImage( // @ts-ignore
            this._inputVideoElement,
            0,
            0,
            this._inputVideoElement.width,
            this._inputVideoElement.height,
            0,
            0,
            this._options.width,
            this._options.height
        );

        const imageData = this._inputResizeCtx?.getImageData(
            0,
            0,
            this._options.width,
            this._options.height
        );
        const inputMemoryOffset = this._model._getInputMemoryOffset() / 4;

        for (let i = 0; i < this._segmentationPixelCount; i++) {
            const r = Number(imageData?.data[i * 4]) / 255;
            const g = Number(imageData?.data[i * 4 + 1]) / 255;
            const b = Number(imageData?.data[i * 4 + 2]) / 255;
            const base = inputMemoryOffset + i * 3;

            this._model.HEAPF32[base] = r;
            this._model.HEAPF32[base + 1] = g;
            this._model.HEAPF32[base + 2] = b;
        }
    }

    _runInferenceAndBuildMask() {
        this._model._runInference();

        const out = this._model._getOutputMemoryOffset() / 4;
        const n = this._segmentationPixelCount;

        if (!this._prevAlpha) {
            this._prevAlpha = new Float32Array(n);
        }
        if (!this._prevBinary) {
            this._prevBinary = new Uint8Array(n);
        }

        if (!this._segmentationMask) {
            this._segmentationMask = new ImageData(
                this._options.width,
                this._options.height
            );
        }

        const prevA = this._prevAlpha;
        const prevB = this._prevBinary;

        for (let i = 0; i < n; i++) {
            let p = this._model.HEAPF32[out + i];

            if (p < 0) {
                p = 0;
            } else if (p > 1) {
                p = 1;
            }

            const delta = Math.abs(p - prevA[i]);
            let t = (delta - DELTA_MIN) / (DELTA_MAX - DELTA_MIN);

            if (t < 0) {
                t = 0;
            } else if (t > 1) {
                t = 1;
            }

            const alpha = SLOW_ALPHA + (FAST_ALPHA - SLOW_ALPHA) * t;
            const s = alpha * prevA[i] + (1 - alpha) * p;

            prevA[i] = s;

            const was = prevB[i];
            const isPerson = was
                ? s >= THRESH_DOWN
                    ? 1
                    : 0
                : s >= THRESH_UP
                    ? 1
                    : 0;

            prevB[i] = isPerson;

            let a: number;

            if (isPerson) {
                const t0 = THRESH_DOWN;
                const t1 = Math.min(1, t0 + FEATHER);

                a = (s - t0) / (t1 - t0);
            } else {
                const t1 = THRESH_UP;
                const t0 = Math.max(0, t1 - FEATHER);

                a = (s - t0) / (t1 - t0);
            }

            if (a < 0) {
                a = 0;
            } else if (a > 1) {
                a = 1;
            }

            this._segmentationMask.data[i * 4 + 3] = (255 * a) | 0;
        }

        this._segmentationMaskCtx?.putImageData(this._segmentationMask, 0, 0);
    }

    _runPostProcessing() {
        const track = this._stream.getVideoTracks()[0];
        const { height, width } = track.getSettings() ?? track.getConstraints();
        const { backgroundType } = this._options.virtualBackground;

        if (!this._outputCanvasCtx) {
            return;
        }

        this._outputCanvasElement.height = height;
        this._outputCanvasElement.width = width;

        this._outputCanvasCtx.globalCompositeOperation = 'copy';
        this._outputCanvasCtx.filter = backgroundType === VIRTUAL_BACKGROUND_TYPE.IMAGE
            ? `blur(${MASK_EDGE_BLUR_IMAGE_PX}px)`
            : `blur(${MASK_EDGE_BLUR_BLUR_PX}px)`;

        this._outputCanvasCtx.drawImage( // @ts-ignore
            this._segmentationMaskCanvas,
            0,
            0,
            this._options.width,
            this._options.height,
            0,
            0,
            this._inputVideoElement.width,
            this._inputVideoElement.height
        );

        this._outputCanvasCtx.globalCompositeOperation = 'source-in';
        this._outputCanvasCtx.filter = 'none';
        // @ts-ignore
        this._outputCanvasCtx.drawImage(this._inputVideoElement, 0, 0);

        this._outputCanvasCtx.globalCompositeOperation = 'destination-over';

        if (backgroundType === VIRTUAL_BACKGROUND_TYPE.IMAGE) {
            this._outputCanvasCtx.drawImage( // @ts-ignore
                this._virtualImage,
                0,
                0,
                this._outputCanvasElement.width,
                this._outputCanvasElement.height
            );
        } else {
            this._outputCanvasCtx.filter = `blur(${this._options.virtualBackground.blurValue}px)`;
            // @ts-ignore
            this._outputCanvasCtx.drawImage(this._inputVideoElement, 0, 0);
            this._outputCanvasCtx.filter = 'none';
        }
    }

    isEnabled(jitsiLocalTrack: any) {
        return jitsiLocalTrack.isVideoTrack() && jitsiLocalTrack.videoType === 'camera';
    }

    startEffect(stream: MediaStream) {
        this._stream = stream;

        this._maskFrameTimerWorker = new Worker(timerWorkerScript, {
            name: 'Blur effect worker'
        });
        this._maskFrameTimerWorker.onmessage = this._onMaskFrameTimer;

        const firstVideoTrack = this._stream.getVideoTracks()[0];
        const { height, frameRate, width }
            = firstVideoTrack.getSettings ? firstVideoTrack.getSettings() : firstVideoTrack.getConstraints();

        this._outputCanvasElement.width = parseInt(width, 10);
        this._outputCanvasElement.height = parseInt(height, 10);
        this._outputCanvasCtx = this._outputCanvasElement.getContext('2d');

        this._inputVideoElement.width = parseInt(width, 10);
        this._inputVideoElement.height = parseInt(height, 10);
        this._inputVideoElement.autoplay = true;
        this._inputVideoElement.srcObject = this._stream;

        this._inputVideoElement.onloadeddata = () => {
            this._maskFrameTimerWorker.postMessage({
                id: SET_TIMEOUT,
                timeMs: 1000 / FPS
            });
        };

        return this._outputCanvasElement.captureStream(parseInt(frameRate, 10));
    }

    stopEffect() {
        this._maskFrameTimerWorker.postMessage({ id: CLEAR_TIMEOUT });
        this._maskFrameTimerWorker.terminate();
        this._prevAlpha = null;
        this._prevBinary = null;
    }
}

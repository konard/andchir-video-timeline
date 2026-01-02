declare module 'wavesurfer.js' {
  export interface WaveSurferOptions {
    /** Required: the element or CSS selector where the waveform will be rendered */
    container: HTMLElement | string;
    /** Audio URL */
    url?: string;
    /** Waveform height in pixels or 'auto' */
    height?: number | 'auto';
    /** Color of the waveform */
    waveColor?: string | string[] | CanvasGradient;
    /** Color of the progress mask */
    progressColor?: string | string[] | CanvasGradient;
    /** Color of the playback cursor */
    cursorColor?: string;
    /** Width of the cursor */
    cursorWidth?: number;
    /** Width of individual bars */
    barWidth?: number;
    /** Gap between bars */
    barGap?: number;
    /** Height multiplier for bars */
    barHeight?: number;
    /** Radius for rounded bars */
    barRadius?: number;
    /** Vertical alignment of bars */
    barAlign?: 'top' | 'bottom';
    /** Minimum height for bars */
    barMinHeight?: number;
    /** Stretch waveform to container */
    fillParent?: boolean;
    /** Enable/disable waveform interaction */
    interact?: boolean;
    /** Stretch waveform to full height */
    normalize?: boolean;
    /** Hide the scrollbar */
    hideScrollbar?: boolean;
    /** Minimum pixels per second */
    minPxPerSec?: number;
    /** Keep position in viewport during scroll */
    autoScroll?: boolean;
    /** Center cursor during playback */
    autoCenter?: boolean;
    /** Autoplay on load */
    autoplay?: boolean;
    /** Decoding sample rate */
    sampleRate?: number;
    /** Pre-computed audio data */
    peaks?: Float32Array[];
    /** Pre-computed duration */
    duration?: number;
    /** Existing media element */
    media?: HTMLMediaElement;
    /** Enable media controls */
    mediaControls?: boolean;
    /** Fetch method options */
    fetchParams?: RequestInit;
    /** Enable drag to seek */
    dragToSeek?: boolean | { debounce?: number };
    /** Audio playback rate */
    audioRate?: number;
    /** Split channels into separate waveforms */
    splitChannels?: WaveSurferOptions[];
    /** Backend type */
    backend?: 'MediaElement' | 'WebAudio';
    /** List of plugins */
    plugins?: any[];
    /** Custom render function */
    renderFunction?: (peaks: Float32Array[], ctx: CanvasRenderingContext2D) => void;
    /** CSP nonce for inline styles */
    cspNonce?: string;
    /** Maximum peak for normalization */
    maxPeak?: number;
  }

  export interface WaveSurferEvents {
    load: [url: string];
    loading: [percent: number];
    decode: [duration: number];
    ready: [duration: number];
    redraw: [];
    redrawcomplete: [];
    play: [];
    pause: [];
    finish: [];
    timeupdate: [currentTime: number];
    audioprocess: [currentTime: number];
    seeking: [currentTime: number];
    interaction: [newTime: number];
    click: [relativeX: number, relativeY: number];
    dblclick: [relativeX: number, relativeY: number];
    drag: [relativeX: number];
    dragstart: [relativeX: number];
    dragend: [relativeX: number];
    scroll: [visibleStartTime: number, visibleEndTime: number];
    zoom: [minPxPerSec: number];
    destroy: [];
    error: [error: Error];
  }

  export default class WaveSurfer {
    static create(options: WaveSurferOptions): WaveSurfer;

    /** Load audio from URL */
    load(url: string, peaks?: Float32Array[], duration?: number): Promise<void>;

    /** Load audio from Blob */
    loadBlob(blob: Blob, peaks?: Float32Array[], duration?: number): Promise<void>;

    /** Play audio */
    play(): Promise<void>;

    /** Pause audio */
    pause(): void;

    /** Stop audio playback and reset to beginning */
    stop(): void;

    /** Toggle between play and pause */
    playPause(): Promise<void>;

    /** Check if currently playing */
    isPlaying(): boolean;

    /** Seek to a time in seconds */
    setTime(time: number): void;

    /** Get current time in seconds */
    getCurrentTime(): number;

    /** Get audio duration in seconds */
    getDuration(): number;

    /** Set playback speed */
    setPlaybackRate(rate: number, preservePitch?: boolean): void;

    /** Get playback speed */
    getPlaybackRate(): number;

    /** Set volume (0 to 1) */
    setVolume(volume: number): void;

    /** Get volume */
    getVolume(): number;

    /** Mute/unmute audio */
    setMuted(muted: boolean): void;

    /** Check if muted */
    getMuted(): boolean;

    /** Set options dynamically */
    setOptions(options: Partial<WaveSurferOptions>): void;

    /** Zoom the waveform */
    zoom(minPxPerSec: number): void;

    /** Get the decoded audio data */
    getDecodedData(): AudioBuffer | null;

    /** Export the waveform as an image */
    exportImage(format?: string, quality?: number, type?: 'blob' | 'dataURL'): Promise<string[] | Blob[]>;

    /** Get the waveform wrapper element */
    getWrapper(): HTMLElement;

    /** Get scroll position */
    getScroll(): number;

    /** Set scroll position */
    setScroll(scrollLeft: number): void;

    /** Subscribe to an event */
    on<K extends keyof WaveSurferEvents>(
      event: K,
      callback: (...args: WaveSurferEvents[K]) => void
    ): () => void;

    /** Subscribe to an event once */
    once<K extends keyof WaveSurferEvents>(
      event: K,
      callback: (...args: WaveSurferEvents[K]) => void
    ): () => void;

    /** Unsubscribe from an event */
    un<K extends keyof WaveSurferEvents>(
      event: K,
      callback: (...args: WaveSurferEvents[K]) => void
    ): void;

    /** Unsubscribe from all events */
    unAll(): void;

    /** Destroy the instance */
    destroy(): void;

    /** Empty the waveform */
    empty(): void;

    /** Get the media element */
    getMediaElement(): HTMLMediaElement;

    /** Register a plugin */
    registerPlugin<T>(plugin: T): T;
  }
}

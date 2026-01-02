import {
  Component,
  Input,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  OnChanges,
  SimpleChanges,
  ViewChild,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import WaveSurfer from 'wavesurfer.js';

@Component({
  selector: 'app-audio-waveform',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './audio-waveform.component.html',
  styleUrl: './audio-waveform.component.css',
})
export class AudioWaveformComponent implements AfterViewInit, OnDestroy, OnChanges {
  @Input() url: string = '';
  @Input() waveColor: string = 'rgba(255, 255, 255, 0.7)';
  @Input() progressColor: string = 'rgba(255, 255, 255, 0.3)';
  @Input() height: number = 32;

  @ViewChild('waveformContainer') waveformContainer?: ElementRef<HTMLElement>;

  readonly isLoading = signal<boolean>(false);
  readonly hasError = signal<boolean>(false);

  private wavesurfer: WaveSurfer | null = null;
  private isInitialized = false;

  ngAfterViewInit(): void {
    this.initializeWavesurfer();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Re-initialize wavesurfer when URL changes
    if (changes['url'] && !changes['url'].firstChange && this.isInitialized) {
      this.loadAudio();
    }
  }

  ngOnDestroy(): void {
    this.destroyWavesurfer();
  }

  private initializeWavesurfer(): void {
    if (!this.waveformContainer?.nativeElement) {
      return;
    }

    this.destroyWavesurfer();

    this.wavesurfer = WaveSurfer.create({
      container: this.waveformContainer.nativeElement,
      waveColor: this.waveColor,
      progressColor: this.progressColor,
      height: this.height,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: false, // Disable interactions since we're in a timeline context
      hideScrollbar: true,
      cursorWidth: 0, // Hide cursor
    });

    // Event listeners
    this.wavesurfer.on('loading', () => {
      this.isLoading.set(true);
      this.hasError.set(false);
    });

    this.wavesurfer.on('ready', () => {
      this.isLoading.set(false);
      this.hasError.set(false);
    });

    this.wavesurfer.on('error', () => {
      this.isLoading.set(false);
      this.hasError.set(true);
    });

    this.isInitialized = true;

    // Load audio if URL is available
    if (this.url) {
      this.loadAudio();
    }
  }

  private loadAudio(): void {
    if (!this.wavesurfer || !this.url) {
      return;
    }

    this.isLoading.set(true);
    this.hasError.set(false);

    this.wavesurfer.load(this.url);
  }

  private destroyWavesurfer(): void {
    if (this.wavesurfer) {
      this.wavesurfer.destroy();
      this.wavesurfer = null;
    }
    this.isInitialized = false;
  }
}

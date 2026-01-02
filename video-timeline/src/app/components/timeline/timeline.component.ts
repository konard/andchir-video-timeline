import { Component, signal, computed, ViewChild, ElementRef, AfterViewInit, OnDestroy, effect, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MediaType, MediaItem, Track, TimelineState } from '../../models/timeline.models';
import { MediaLibraryComponent, MediaLibraryItem } from '../media-library/media-library.component';
import { MediaToolbarComponent } from '../media-toolbar/media-toolbar.component';
import { NotificationsComponent } from '../notifications/notifications.component';
import { AudioWaveformComponent } from '../audio-waveform/audio-waveform.component';
import { TimelineDragDropService } from '../../services/timeline-drag-drop.service';
import { PlaybackService } from '../../services/playback.service';
import { TimelineStorageService } from '../../services/timeline-storage.service';
import { TimelineHistoryService } from '../../services/timeline-history.service';

@Component({
  selector: 'app-timeline',
  standalone: true,
  imports: [CommonModule, MediaLibraryComponent, MediaToolbarComponent, NotificationsComponent, AudioWaveformComponent],
  templateUrl: './timeline.component.html',
  styleUrl: './timeline.component.css'
})
export class TimelineComponent implements AfterViewInit, OnDestroy {
  // Zoom levels: pixels per second
  private readonly MIN_ZOOM = 10;
  private readonly MAX_ZOOM = 200;
  private readonly ZOOM_STEP = 20;
  readonly TRACK_HEADER_WIDTH = 150; // Width of track header in pixels
  private readonly SNAP_PROXIMITY_MS = 500; // Snap to item if playhead is within 500ms
  private readonly MIN_ITEM_DURATION = 100; // Minimum item duration in milliseconds

  // Canvas dimensions for preview
  readonly PREVIEW_WIDTH = 640;
  readonly PREVIEW_HEIGHT = 360;

  // View references
  @ViewChild('timelineRuler') timelineRuler?: ElementRef<HTMLElement>;
  @ViewChild('notifications') notificationsComponent?: NotificationsComponent;
  @ViewChild('previewCanvas') previewCanvas?: ElementRef<HTMLCanvasElement>;

  // Timeline state
  readonly state = signal<TimelineState>({
    tracks: [
      { id: '1', name: 'Track 1', order: 0, items: [] },
      { id: '2', name: 'Track 2', order: 1, items: [] }
    ],
    playheadPosition: 0,
    zoomLevel: 50, // pixels per second
    totalDuration: 120000, // 120 seconds in milliseconds
    selectedItemId: null
  });

  // Computed values
  readonly pixelsPerMillisecond = computed(() => {
    return this.state().zoomLevel / 1000;
  });

  readonly timelineWidth = computed(() => {
    const state = this.state();
    // Calculate the maximum end time across all tracks
    let maxEndTime = state.totalDuration;

    for (const track of state.tracks) {
      for (const item of track.items) {
        const itemEndTime = item.startTime + item.duration;
        if (itemEndTime > maxEndTime) {
          maxEndTime = itemEndTime;
        }
      }
    }

    return maxEndTime * this.pixelsPerMillisecond();
  });

  readonly timelineLineHeight = computed(() => {
    const state = this.state();
    return state.tracks.length * 60 + 32;
  });

  readonly playheadPosition = computed(() => {
    return this.state().playheadPosition * this.pixelsPerMillisecond();
  });

  readonly playheadVisualPosition = computed(() => {
    return this.playheadPosition() + this.TRACK_HEADER_WIDTH;
  });

  // Computed: whether a media item is currently selected
  readonly hasSelectedItem = computed(() => {
    return this.state().selectedItemId !== null;
  });

  // Dragging state
  private draggedItem: MediaItem | null = null;
  private draggedItemOriginalTrackId: string | null = null;
  private dragOffsetTime: number = 0; // Offset in milliseconds from item start to cursor position
  private isDraggingPlayhead = false;
  private isDraggingFromRuler = false;
  private resizingItem: { item: MediaItem; edge: 'left' | 'right' } | null = null;
  private mouseDownPosition: { x: number; y: number } | null = null; // Track mouse down position for click detection
  private hasHistorySavedForCurrentOperation = false; // Track if history was saved for drag/resize operation

  // Video preview state
  readonly isPlaying = signal<boolean>(false);

  // Duration editor state
  readonly showDurationEditor = signal<boolean>(false);
  private editedDuration: number = 120; // Duration in seconds

  // Media library state
  readonly showMediaLibrary = signal<boolean>(false);
  private mediaLibraryTargetTrackId: string | null = null;

  // Clipboard state for copy/paste functionality
  private readonly clipboardItem = signal<MediaItem | null>(null);
  private readonly clipboardSourceTrackId = signal<string | null>(null);

  // Computed: whether a media item is in clipboard
  readonly hasClipboardItem = computed(() => {
    return this.clipboardItem() !== null;
  });

  // Computed: whether undo/redo is available
  readonly canUndo = computed(() => this.historyService.canUndo());
  readonly canRedo = computed(() => this.historyService.canRedo());

  // Render loop ID for cleanup
  private renderLoopId: number | null = null;

  constructor(
    private dragDropService: TimelineDragDropService,
    public playbackService: PlaybackService,
    private storageService: TimelineStorageService,
    private historyService: TimelineHistoryService
  ) {
    // Load saved state from LocalStorage on initialization
    const savedState = this.storageService.loadState();
    if (savedState) {
      this.state.set(savedState);
    }

    // Effect to sync playhead position from PlaybackService during playback
    effect(() => {
      if (this.playbackService.isPlaying()) {
        const position = this.playbackService.playheadPosition();
        this.state.update(s => ({
          ...s,
          playheadPosition: position
        }));
      }
    });

    // Effect to auto-save timeline state to LocalStorage on any change
    effect(() => {
      const currentState = this.state();
      this.storageService.saveState(currentState);
    });
  }

  ngAfterViewInit(): void {
    // Initialize canvas for preview rendering
    if (this.previewCanvas) {
      this.playbackService.setCanvas(this.previewCanvas.nativeElement);
    }

    // Start continuous render loop for preview (renders current frame even when paused)
    this.startRenderLoop();

    // Synchronize media and render initial frame if state was loaded from LocalStorage
    const currentState = this.state();
    if (currentState.tracks.length > 0) {
      this.playbackService.seek(currentState.tracks, currentState.playheadPosition);
    }
  }

  ngOnDestroy(): void {
    // Clean up render loop
    if (this.renderLoopId !== null) {
      cancelAnimationFrame(this.renderLoopId);
      this.renderLoopId = null;
    }

    // Stop playback
    this.playbackService.stop();
  }

  /**
   * Continuous render loop for preview canvas.
   * Keeps rendering even when paused so seeking updates the preview.
   */
  private startRenderLoop(): void {
    const render = () => {
      // Only render if we have active media and are not playing
      // (PlaybackService handles rendering during playback)
      if (!this.playbackService.isPlaying()) {
        this.playbackService.renderCurrentFrame();
      }
      this.renderLoopId = requestAnimationFrame(render);
    };
    this.renderLoopId = requestAnimationFrame(render);
  }

  // Track management
  addTrack(): void {
    // Save state before modification for undo
    this.saveStateToHistory();

    const currentState = this.state();
    const newTrack: Track = {
      id: `track-${Date.now()}`,
      name: `Track ${currentState.tracks.length + 1}`,
      order: currentState.tracks.length,
      items: []
    };

    this.state.update(s => ({
      ...s,
      tracks: [...s.tracks, newTrack]
    }));

    // Show notification for adding track
    this.notificationsComponent?.showNotification(
      `Track "${newTrack.name}" added.`,
      'success'
    );
  }

  removeTrack(trackId: string): void {
    const currentState = this.state();
    if (currentState.tracks.length <= 1) {
      return; // Keep at least one track
    }

    // Save state before modification for undo
    this.saveStateToHistory();

    // Get track name before removing
    const trackToRemove = currentState.tracks.find(t => t.id === trackId);
    const trackName = trackToRemove?.name || 'Track';

    this.state.update(s => ({
      ...s,
      tracks: s.tracks.filter(t => t.id !== trackId)
    }));

    // Show notification for removing track
    this.notificationsComponent?.showNotification(
      `Track "${trackName}" removed.`,
      'info'
    );
  }

  // Zoom controls
  zoomIn(): void {
    this.state.update(s => ({
      ...s,
      zoomLevel: Math.min(s.zoomLevel + this.ZOOM_STEP, this.MAX_ZOOM)
    }));
  }

  zoomOut(): void {
    this.state.update(s => ({
      ...s,
      zoomLevel: Math.max(s.zoomLevel - this.ZOOM_STEP, this.MIN_ZOOM)
    }));
  }

  // Utility method to extract coordinates from mouse or touch events
  private getEventCoordinates(event: MouseEvent | TouchEvent): { clientX: number; clientY: number } {
    if (event instanceof MouseEvent) {
      return { clientX: event.clientX, clientY: event.clientY };
    } else {
      const touch = event.touches[0] || event.changedTouches[0];
      return { clientX: touch.clientX, clientY: touch.clientY };
    }
  }

  // Playhead controls
  onRulerPointerDown(event: MouseEvent | TouchEvent): void {
    event.preventDefault();
    this.isDraggingFromRuler = true;

    // Immediately update position on pointer down
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const coords = this.getEventCoordinates(event);
    // Calculate position within the ruler element
    // getBoundingClientRect() already accounts for scroll, so we don't add scrollLeft
    const x = coords.clientX - rect.left;
    const newPosition = x / this.pixelsPerMillisecond();
    const currentState = this.state();
    const clampedPosition = Math.max(0, Math.min(newPosition, currentState.totalDuration));

    this.state.update(s => ({
      ...s,
      playheadPosition: clampedPosition
    }));

    // Sync position to playback service for seeking
    this.playbackService.seek(currentState.tracks, clampedPosition);
  }

  onPlayheadPointerDown(event: MouseEvent | TouchEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingPlayhead = true;
  }


  // Media item drag and drop
  onMediaItemPointerDown(event: MouseEvent | TouchEvent, item: MediaItem, track: Track): void {
    const target = event.target as HTMLElement;

    // Check if clicking/touching on resize handle
    if (target.classList.contains('resize-handle')) {
      // Save state for undo before resize operation starts
      this.saveStateToHistory();
      this.hasHistorySavedForCurrentOperation = true;

      this.resizingItem = {
        item,
        edge: target.classList.contains('resize-handle-left') ? 'left' : 'right'
      };
      event.preventDefault();
      return;
    }

    const coords = this.getEventCoordinates(event);
    this.mouseDownPosition = { x: coords.clientX, y: coords.clientY };

    const mediaItemElement = event.currentTarget as HTMLElement;
    const rect = mediaItemElement.getBoundingClientRect();
    const clickX = coords.clientX - rect.left;

    // Convert pixel offset to time offset
    this.dragOffsetTime = clickX / this.pixelsPerMillisecond();

    // Save state for undo before drag operation starts
    this.saveStateToHistory();
    this.hasHistorySavedForCurrentOperation = true;

    this.draggedItem = item;
    this.draggedItemOriginalTrackId = track.id;
    event.preventDefault();
  }

  onTrackPointerDown(event: MouseEvent | TouchEvent): void {
    // Deselect when clicking/touching track background (not on media item)
    const target = event.target as HTMLElement;
    if (target.classList.contains('track')) {
      this.deselectMediaItem();
    }
  }

  onTrackPointerMove(event: MouseEvent | TouchEvent, track: Track): void {
    if (this.resizingItem) {
      this.handleResize(event, track);
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (!this.draggedItem) return;

    const coords = this.getEventCoordinates(event);
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = coords.clientX - rect.left;
    const requestedStartTime = Math.max(0, x / this.pixelsPerMillisecond() - this.dragOffsetTime);

    this.state.update(s => {
      const updatedTracks = s.tracks.map(t => {
        if (t.id === track.id) {
          // Get all items except the dragged one for collision detection
          const otherItems = t.items.filter(i => i.id !== this.draggedItem!.id);

          // Fix for issue #81: Find snap targets (playhead and items on all tracks)
          const snapTargets = this.dragDropService.findSnapTargets(
            this.draggedItem!.id,
            s.tracks,
            s.playheadPosition
          );

          // Calculate valid position and duration considering collisions, gap fitting, and snapping
          const validPosition = this.dragDropService.getValidDragPosition(
            this.draggedItem!,
            requestedStartTime,
            otherItems,
            s.totalDuration,
            snapTargets
          );

          // Check if item already exists in this track
          const itemExists = t.items.some(i => i.id === this.draggedItem!.id);

          if (itemExists) {
            // Update position and duration in current track
            return {
              ...t,
              items: t.items.map(i =>
                i.id === this.draggedItem!.id
                  ? {
                      ...i,
                      startTime: validPosition.startTime,
                      duration: validPosition.duration,
                      trackId: track.id
                    }
                  : i
              )
            };
          } else {
            // Add to new track with adjusted position and duration
            return {
              ...t,
              items: [
                ...otherItems,
                {
                  ...this.draggedItem!,
                  startTime: validPosition.startTime,
                  duration: validPosition.duration,
                  trackId: track.id
                }
              ]
            };
          }
        } else if (t.id === this.draggedItemOriginalTrackId && t.id !== track.id) {
          // Remove from original track only if moving to different track
          return {
            ...t,
            items: t.items.filter(i => i.id !== this.draggedItem!.id)
          };
        }
        return t;
      });

      // Update the original track ID to current track for smooth dragging within same track
      this.draggedItemOriginalTrackId = track.id;

      return { ...s, tracks: updatedTracks };
    });
  }

  private handleResize(event: MouseEvent | TouchEvent, track: Track): void {
    if (!this.resizingItem) return;

    const coords = this.getEventCoordinates(event);
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    // Fix for issue #83: getBoundingClientRect() returns viewport-relative coordinates,
    // and coords.clientX is also viewport-relative, so we don't need to add scrollLeft
    const x = coords.clientX - rect.left;
    const timeAtCursor = x / this.pixelsPerMillisecond();

    this.state.update(s => {
      // Fix for issue #87: Find snap targets for resize operations
      const snapTargets = this.dragDropService.findSnapTargets(
        this.resizingItem!.item.id,
        s.tracks,
        s.playheadPosition
      );

      const updatedTracks = s.tracks.map(t => {
        if (t.id === track.id) {
          // Get resize bounds considering adjacent items
          const bounds = this.dragDropService.getResizeBounds(
            this.resizingItem!.item,
            t.items,
            this.resizingItem!.edge,
            s.totalDuration
          );

          return {
            ...t,
            items: t.items.map(i => {
              if (i.id === this.resizingItem!.item.id) {
                if (this.resizingItem!.edge === 'left') {
                  // Fix for issue #89: Handle mediaStartTime when resizing from left
                  // Apply snapping to left edge (start time)
                  let newStartTime = Math.max(
                    bounds.minTime,
                    Math.min(timeAtCursor, bounds.maxTime)
                  );

                  // Apply snapping if within snap distance
                  let minDistance = this.dragDropService.SNAP_DISTANCE_MS;
                  for (const target of snapTargets) {
                    const distance = Math.abs(newStartTime - target);
                    if (distance < minDistance) {
                      minDistance = distance;
                      // Only snap if within bounds
                      if (target >= bounds.minTime && target <= bounds.maxTime) {
                        newStartTime = target;
                      }
                    }
                  }

                  // Calculate how much the timeline position is changing
                  const deltaTime = newStartTime - i.startTime;
                  const newDuration = i.duration - deltaTime;

                  // Update media start time (trimming from source media)
                  const currentMediaStartTime = i.mediaStartTime || 0;
                  const newMediaStartTime = currentMediaStartTime + deltaTime;

                  // Check if we're trying to extend beyond the start of source media
                  if (newMediaStartTime < 0) {
                    // Can only extend left by currentMediaStartTime amount
                    const maxExtension = currentMediaStartTime;
                    const finalStartTime = i.startTime - maxExtension;
                    const finalDuration = i.duration + maxExtension;

                    // Ensure we don't exceed maxDuration
                    if (i.maxDuration && finalDuration > i.maxDuration) {
                      return {
                        ...i,
                        startTime: finalStartTime + (finalDuration - i.maxDuration),
                        duration: i.maxDuration,
                        mediaStartTime: 0
                      };
                    }

                    return {
                      ...i,
                      startTime: finalStartTime,
                      duration: finalDuration,
                      mediaStartTime: 0
                    };
                  }

                  // Ensure media end doesn't exceed maxDuration
                  if (i.maxDuration && newMediaStartTime + newDuration > i.maxDuration) {
                    const maxAllowedDuration = i.maxDuration - newMediaStartTime;
                    return {
                      ...i,
                      startTime: i.startTime + (i.duration - maxAllowedDuration),
                      duration: maxAllowedDuration,
                      mediaStartTime: newMediaStartTime
                    };
                  }

                  return {
                    ...i,
                    startTime: newStartTime,
                    duration: newDuration,
                    mediaStartTime: newMediaStartTime
                  };
                } else {
                  // Fix for issue #87: Apply snapping to right edge (end time)
                  let newEndTime = Math.max(
                    bounds.minTime,
                    Math.min(timeAtCursor, bounds.maxTime)
                  );

                  // Apply snapping if within snap distance
                  let minDistance = this.dragDropService.SNAP_DISTANCE_MS;
                  for (const target of snapTargets) {
                    const distance = Math.abs(newEndTime - target);
                    if (distance < minDistance) {
                      minDistance = distance;
                      // Only snap if within bounds
                      if (target >= bounds.minTime && target <= bounds.maxTime) {
                        newEndTime = target;
                      }
                    }
                  }

                  const newDuration = newEndTime - i.startTime;

                  // Limit duration by maxDuration if specified
                  const limitedDuration = i.maxDuration
                    ? Math.min(newDuration, i.maxDuration)
                    : newDuration;

                  return { ...i, duration: limitedDuration };
                }
              }
              return i;
            })
          };
        }
        return t;
      });

      return { ...s, tracks: updatedTracks };
    });
  }

  onPointerUp(event: MouseEvent | TouchEvent): void {
    // Detect if this was a click/tap (not a drag) on a media item
    if (this.draggedItem && this.mouseDownPosition) {
      const coords = this.getEventCoordinates(event);
      const dx = coords.clientX - this.mouseDownPosition.x;
      const dy = coords.clientY - this.mouseDownPosition.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // If pointer moved less than 5 pixels, consider it a click/tap
      if (distance < 5) {
        this.selectMediaItem(this.draggedItem.id);
      }
    }

    this.draggedItem = null;
    this.draggedItemOriginalTrackId = null;
    this.dragOffsetTime = 0;
    this.isDraggingPlayhead = false;
    this.isDraggingFromRuler = false;
    this.resizingItem = null;
    this.mouseDownPosition = null;
    this.hasHistorySavedForCurrentOperation = false; // Reset history flag
  }

  onDocumentPointerMove(event: MouseEvent | TouchEvent): void {
    if (this.isDraggingPlayhead || this.isDraggingFromRuler) {
      // Fix for issue #50: Use ViewChild reference to ensure we use the exact same element as onRulerPointerDown
      if (!this.timelineRuler) {
        return;
      }

      const coords = this.getEventCoordinates(event);
      const rulerElement = this.timelineRuler.nativeElement;
      // Use the same calculation as onRulerPointerDown
      // getBoundingClientRect() already accounts for scroll, so we don't add scrollLeft
      const rect = rulerElement.getBoundingClientRect();
      const x = coords.clientX - rect.left;
      const newPosition = x / this.pixelsPerMillisecond();
      const currentState = this.state();
      const clampedPosition = Math.max(0, Math.min(newPosition, currentState.totalDuration));

      this.state.update(s => ({
        ...s,
        playheadPosition: clampedPosition
      }));

      // Sync position to playback service for seeking (but don't call too frequently during drag)
      this.playbackService.seek(currentState.tracks, clampedPosition);
    }

    // Fix for issue #96: Handle media item dragging and resizing at document level for touch events
    // This allows dragging between tracks on mobile devices
    if (event instanceof TouchEvent) {
      if (this.draggedItem) {
        // Find which track the touch is currently over
        const targetTrack = this.findTrackAtCoordinates(this.getEventCoordinates(event));
        if (targetTrack) {
          // Reuse existing drag logic
          this.onTrackPointerMove(event, targetTrack);
        }
      } else if (this.resizingItem) {
        // Find the track that contains the resizing item
        const targetTrack = this.findTrackContainingItem(this.resizingItem.item.id);
        if (targetTrack) {
          // Reuse existing resize logic
          this.handleResize(event, targetTrack);
        }
      }
    }
  }

  // Helper method to find which track is at the given Y coordinate
  private findTrackAtCoordinates(coords: { clientX: number; clientY: number }): Track | null {
    const trackElements = document.querySelectorAll('.track');
    for (const trackElement of Array.from(trackElements)) {
      const rect = trackElement.getBoundingClientRect();
      if (coords.clientY >= rect.top && coords.clientY <= rect.bottom) {
        const trackIndex = Array.from(trackElements).indexOf(trackElement);
        const tracks = this.state().tracks;
        if (trackIndex >= 0 && trackIndex < tracks.length) {
          return tracks[trackIndex];
        }
      }
    }
    return null;
  }

  // Helper method to find the track containing a specific item
  private findTrackContainingItem(itemId: string): Track | null {
    const currentState = this.state();
    for (const track of currentState.tracks) {
      if (track.items.some(item => item.id === itemId)) {
        return track;
      }
    }
    return null;
  }

  // Helper methods
  getItemStyle(item: MediaItem) {
    return {
      left: `${item.startTime * this.pixelsPerMillisecond()}px`,
      width: `${item.duration * this.pixelsPerMillisecond()}px`
    };
  }

  getMediaTypeClass(type: MediaType): string {
    return `media-${type}`;
  }

  formatTime(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const cs = Math.floor((milliseconds % 1000) / 10);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
  }

  /**
   * Calculate appropriate time interval for markers based on zoom level
   * to prevent marker labels from overlapping
   */
  private getMarkerInterval(): number {
    // Minimum spacing between markers in pixels to prevent overlap
    // Enough space for "0:00.000" text (about 50-60px)
    const MIN_MARKER_SPACING_PX = 60;

    // Calculate how much time represents MIN_MARKER_SPACING_PX at current zoom
    const pixelsPerMs = this.pixelsPerMillisecond();
    const minTimeSpacing = MIN_MARKER_SPACING_PX / pixelsPerMs;

    // Define possible intervals (in ms): 100ms, 250ms, 500ms, 1s, 2s, 5s, 10s, 30s, 60s
    const intervals = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];

    // Find the smallest interval that's larger than or equal to minTimeSpacing
    for (const interval of intervals) {
      if (interval >= minTimeSpacing) {
        return interval;
      }
    }

    // If even 60s is too small, use larger intervals
    return Math.ceil(minTimeSpacing / 60000) * 60000;
  }

  getTimeMarkers(): { position: number; label: string }[] {
    const markers: { position: number; label: string }[] = [];
    const stepMs = this.getMarkerInterval(); // Dynamic interval based on zoom level

    // Fix for issue #85: Do not show the last time mark at totalDuration
    // to prevent container expansion from the text label
    for (let time = 0; time < this.state().totalDuration; time += stepMs) {
      markers.push({
        position: time * this.pixelsPerMillisecond(),
        label: this.formatTime(time)
      });
    }

    return markers;
  }

  // Add placeholder media item
  addMediaItem(type: MediaType, trackId: string): void {
    const currentState = this.state();
    const track = currentState.tracks.find(t => t.id === trackId);

    if (!track) return;

    // Save state before modification for undo
    this.saveStateToHistory();

    const playheadTime = currentState.playheadPosition;
    const totalDuration = currentState.totalDuration;
    const newItemDuration = type === MediaType.IMAGE ? 5000 : 3000;

    // Determine the start time for the new item using the service
    const startTime = this.dragDropService.calculateNewItemStartTime(
      playheadTime,
      track.items,
      this.SNAP_PROXIMITY_MS
    );

    // Fix for issue #48: Ensure new item doesn't exceed totalDuration
    const maxAllowedDuration = totalDuration - startTime;
    const finalDuration = Math.min(newItemDuration, maxAllowedDuration);

    // Fix for issue #64: Verify that the new item doesn't overlap with any existing items
    const testItem: MediaItem = {
      id: 'temp',
      type,
      startTime,
      duration: finalDuration,
      trackId,
      name: '',
      isPlaceholder: true
    };

    // Validate and adjust position if needed
    const validatedStartTime = this.dragDropService.validateItemPosition(testItem, track.items);

    // Recalculate duration limit if position was adjusted
    const adjustedMaxAllowedDuration = totalDuration - validatedStartTime;
    const adjustedDuration = Math.min(newItemDuration, adjustedMaxAllowedDuration);

    // Create the final non-overlapping item
    const newItem: MediaItem = {
      id: `item-${Date.now()}`,
      type,
      startTime: validatedStartTime,
      duration: adjustedDuration,
      trackId,
      name: `${type} placeholder`,
      isPlaceholder: true
    };

    // Set maxDuration for audio and video placeholders
    if (type === MediaType.VIDEO) {
      newItem.maxDuration = Math.min(10000, adjustedMaxAllowedDuration); // 10 seconds default for video
    } else if (type === MediaType.AUDIO) {
      newItem.maxDuration = Math.min(15000, adjustedMaxAllowedDuration); // 15 seconds default for audio
    }

    this.state.update(s => ({
      ...s,
      tracks: s.tracks.map(t =>
        t.id === trackId
          ? { ...t, items: [...t.items, newItem] }
          : t
      )
    }));

    // Show notification for adding media
    this.notificationsComponent?.showNotification(
      'Media added to timeline.',
      'success'
    );
  }

  removeMediaItem(itemId: string, trackId: string): void {
    // Save state before modification for undo
    this.saveStateToHistory();

    this.state.update(s => ({
      ...s,
      tracks: s.tracks.map(t =>
        t.id === trackId
          ? { ...t, items: t.items.filter(i => i.id !== itemId) }
          : t
      ),
      // Deselect if removing selected item
      selectedItemId: s.selectedItemId === itemId ? null : s.selectedItemId
    }));

    // Show notification for removing media
    this.notificationsComponent?.showNotification(
      'Media removed from timeline.',
      'info'
    );
  }

  // Media selection
  selectMediaItem(itemId: string): void {
    this.state.update(s => ({
      ...s,
      selectedItemId: itemId
    }));
  }

  deselectMediaItem(): void {
    this.state.update(s => ({
      ...s,
      selectedItemId: null
    }));
  }

  isItemSelected(itemId: string): boolean {
    return this.state().selectedItemId === itemId;
  }

  readonly MediaType = MediaType;

  /**
   * Create a new project by clearing the timeline and LocalStorage
   */
  newProject(): void {
    // Stop playback if playing
    if (this.playbackService.isPlaying()) {
      this.playbackService.stop();
      this.isPlaying.set(false);
    }

    // Reset timeline state to initial values
    this.state.set({
      tracks: [
        { id: '1', name: 'Track 1', order: 0, items: [] },
        { id: '2', name: 'Track 2', order: 1, items: [] }
      ],
      playheadPosition: 0,
      zoomLevel: 50,
      totalDuration: 120000,
      selectedItemId: null
    });

    // Clear LocalStorage
    this.storageService.clearState();

    // Show notification
    this.notificationsComponent?.showNotification(
      'New project created. Timeline cleared.',
      'success'
    );

    // Clear undo/redo history when creating a new project
    this.historyService.clearHistory();
  }

  /**
   * Push current state to history before making a change.
   * Should be called at the start of any operation that modifies the timeline.
   */
  private saveStateToHistory(): void {
    this.historyService.pushState(this.state());
  }

  /**
   * Undo the last action.
   * Restores the previous timeline state.
   */
  undo(): void {
    const previousState = this.historyService.undo(this.state());
    if (previousState) {
      this.state.set(previousState);

      // Sync playback service with new state
      this.playbackService.seek(previousState.tracks, previousState.playheadPosition);

      this.notificationsComponent?.showNotification('Undo successful.', 'info');
    }
  }

  /**
   * Redo the last undone action.
   * Restores the next timeline state.
   */
  redo(): void {
    const nextState = this.historyService.redo(this.state());
    if (nextState) {
      this.state.set(nextState);

      // Sync playback service with new state
      this.playbackService.seek(nextState.tracks, nextState.playheadPosition);

      this.notificationsComponent?.showNotification('Redo successful.', 'info');
    }
  }

  /**
   * Handle keyboard shortcuts for undo/redo.
   */
  @HostListener('document:keydown', ['$event'])
  handleKeyboardShortcuts(event: KeyboardEvent): void {
    // Skip if user is typing in an input field
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }

    // Ctrl+Z or Cmd+Z for undo
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.undo();
    }

    // Ctrl+Y or Cmd+Shift+Z for redo
    if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.key === 'z' && event.shiftKey))) {
      event.preventDefault();
      this.redo();
    }
  }

  // Video preview controls
  togglePlayback(): void {
    const currentState = this.state();

    if (this.playbackService.isPlaying()) {
      this.playbackService.pause();
      this.isPlaying.set(false);
    } else {
      // Sync playhead position to PlaybackService before starting
      this.playbackService.setPlayheadPosition(currentState.playheadPosition);
      this.playbackService.play(currentState.tracks, currentState.totalDuration);
      this.isPlaying.set(true);
    }
  }

  skipBackward(): void {
    const currentState = this.state();
    const newPosition = Math.max(0, currentState.playheadPosition - 5000);

    this.state.update(s => ({
      ...s,
      playheadPosition: newPosition
    }));

    // Sync position and update media
    this.playbackService.seek(currentState.tracks, newPosition);
  }

  skipForward(): void {
    const currentState = this.state();
    const newPosition = Math.min(currentState.totalDuration, currentState.playheadPosition + 5000);

    this.state.update(s => ({
      ...s,
      playheadPosition: newPosition
    }));

    // Sync position and update media
    this.playbackService.seek(currentState.tracks, newPosition);
  }

  // Duration editor methods
  openDurationEditor(): void {
    this.editedDuration = this.state().totalDuration / 1000;
    this.showDurationEditor.set(true);
  }

  closeDurationEditor(): void {
    this.showDurationEditor.set(false);
  }

  onDurationInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = parseFloat(input.value);
    if (!isNaN(value) && value > 0) {
      this.editedDuration = value;
    }
  }

  saveDuration(): void {
    // Save state before modification for undo
    this.saveStateToHistory();

    const newDurationMs = Math.max(1000, this.editedDuration * 1000); // At least 1 second
    this.state.update(s => ({
      ...s,
      totalDuration: newDurationMs,
      // Ensure playhead doesn't exceed new duration
      playheadPosition: Math.min(s.playheadPosition, newDurationMs)
    }));
    this.closeDurationEditor();
  }

  // Media library methods
  openMediaLibrary(trackId: string): void {
    this.mediaLibraryTargetTrackId = trackId;
    this.showMediaLibrary.set(true);
  }

  closeMediaLibrary(): void {
    this.showMediaLibrary.set(false);
    this.mediaLibraryTargetTrackId = null;
  }

  onMediaSelected(media: MediaLibraryItem): void {
    if (!this.mediaLibraryTargetTrackId) return;

    const currentState = this.state();
    const track = currentState.tracks.find(t => t.id === this.mediaLibraryTargetTrackId);

    if (!track) return;

    // Save state before modification for undo
    this.saveStateToHistory();

    const playheadTime = currentState.playheadPosition;
    const totalDuration = currentState.totalDuration;

    // Determine the start time for the new item using the service
    const startTime = this.dragDropService.calculateNewItemStartTime(
      playheadTime,
      track.items,
      this.SNAP_PROXIMITY_MS
    );

    // Ensure item doesn't exceed totalDuration
    const maxAllowedDuration = totalDuration - startTime;
    const finalDuration = Math.min(media.duration, maxAllowedDuration);

    // Verify that the new item doesn't overlap with any existing items
    const testItem: MediaItem = {
      id: 'temp',
      type: media.type,
      startTime,
      duration: finalDuration,
      trackId: this.mediaLibraryTargetTrackId,
      name: '',
      isPlaceholder: false
    };

    // Validate and adjust position if needed
    const validatedStartTime = this.dragDropService.validateItemPosition(testItem, track.items);

    // Recalculate duration limit if position was adjusted
    const adjustedMaxAllowedDuration = totalDuration - validatedStartTime;
    const adjustedDuration = Math.min(media.duration, adjustedMaxAllowedDuration);

    // Create the final non-overlapping item
    const newItem: MediaItem = {
      id: `item-${Date.now()}`,
      type: media.type,
      startTime: validatedStartTime,
      duration: adjustedDuration,
      trackId: this.mediaLibraryTargetTrackId,
      name: media.name,
      url: media.url, // Pass URL from media library for playback
      isPlaceholder: false
    };

    // Set maxDuration for audio and video
    if (media.type === MediaType.VIDEO) {
      newItem.maxDuration = Math.min(media.duration, adjustedMaxAllowedDuration);
    } else if (media.type === MediaType.AUDIO) {
      newItem.maxDuration = Math.min(media.duration, adjustedMaxAllowedDuration);
    }

    this.state.update(s => ({
      ...s,
      tracks: s.tracks.map(t =>
        t.id === this.mediaLibraryTargetTrackId
          ? { ...t, items: [...t.items, newItem] }
          : t
      )
    }));

    // Show notification for adding media
    this.notificationsComponent?.showNotification(
      `"${media.name}" added to timeline.`,
      'success'
    );

    // Close the media library after selection
    this.closeMediaLibrary();
  }

  /**
   * Trim (split) the selected media item at the playhead position.
   * Creates two separate items from the original media.
   */
  trimSelectedMedia(): void {
    const currentState = this.state();
    const selectedItemId = currentState.selectedItemId;

    if (!selectedItemId) {
      return;
    }

    // Find the selected item and its track
    let selectedItem: MediaItem | null = null;
    let selectedTrack: Track | null = null;

    for (const track of currentState.tracks) {
      const item = track.items.find(i => i.id === selectedItemId);
      if (item) {
        selectedItem = item;
        selectedTrack = track;
        break;
      }
    }

    if (!selectedItem || !selectedTrack) {
      return;
    }

    const playheadTime = currentState.playheadPosition;
    const itemStart = selectedItem.startTime;
    const itemEnd = itemStart + selectedItem.duration;

    // Check if playhead is within the selected media item
    if (playheadTime <= itemStart || playheadTime >= itemEnd) {
      // Playhead is not within the selected media - show notification
      this.notificationsComponent?.showNotification(
        'Position the playhead within the selected media to trim it.',
        'warning'
      );
      return;
    }

    // Ensure both parts will have at least MIN_ITEM_DURATION
    const firstPartDuration = playheadTime - itemStart;
    const secondPartDuration = itemEnd - playheadTime;

    if (firstPartDuration < this.MIN_ITEM_DURATION || secondPartDuration < this.MIN_ITEM_DURATION) {
      this.notificationsComponent?.showNotification(
        'Cannot trim: resulting parts would be too short.',
        'warning'
      );
      return;
    }

    // Save state before modification for undo
    this.saveStateToHistory();

    // Calculate mediaStartTime adjustments
    const originalMediaStartTime = selectedItem.mediaStartTime || 0;
    const secondPartMediaStartTime = originalMediaStartTime + firstPartDuration;

    // Create two new items from the original
    const firstPart: MediaItem = {
      ...selectedItem,
      id: `item-${Date.now()}-1`,
      duration: firstPartDuration
      // mediaStartTime stays the same for first part
    };

    const secondPart: MediaItem = {
      ...selectedItem,
      id: `item-${Date.now()}-2`,
      startTime: playheadTime,
      duration: secondPartDuration,
      mediaStartTime: secondPartMediaStartTime
    };

    // Update the state: remove original, add two new parts
    this.state.update(s => ({
      ...s,
      tracks: s.tracks.map(t => {
        if (t.id === selectedTrack!.id) {
          return {
            ...t,
            items: [
              ...t.items.filter(i => i.id !== selectedItemId),
              firstPart,
              secondPart
            ]
          };
        }
        return t;
      }),
      // Deselect after trimming
      selectedItemId: null
    }));

    this.notificationsComponent?.showNotification(
      'Media trimmed successfully.',
      'success'
    );
  }

  /**
   * Copy the selected media item to the clipboard.
   * Stores a copy of the item and the track it was copied from.
   */
  copySelectedMedia(): void {
    const currentState = this.state();
    const selectedItemId = currentState.selectedItemId;

    if (!selectedItemId) {
      return;
    }

    // Find the selected item and its track
    let selectedItem: MediaItem | null = null;
    let selectedTrackId: string | null = null;

    for (const track of currentState.tracks) {
      const item = track.items.find(i => i.id === selectedItemId);
      if (item) {
        selectedItem = item;
        selectedTrackId = track.id;
        break;
      }
    }

    if (!selectedItem || !selectedTrackId) {
      return;
    }

    // Store a copy of the item in clipboard
    this.clipboardItem.set({ ...selectedItem });
    this.clipboardSourceTrackId.set(selectedTrackId);

    this.notificationsComponent?.showNotification(
      'Media copied to clipboard.',
      'success'
    );
  }

  /**
   * Paste the clipboard media item at the playhead position.
   * Pastes on the same track where the item was copied from.
   * If there's no space at playhead position, finds the next available slot.
   */
  pasteMedia(): void {
    const copiedItem = this.clipboardItem();
    const sourceTrackId = this.clipboardSourceTrackId();

    if (!copiedItem || !sourceTrackId) {
      return;
    }

    const currentState = this.state();
    const playheadTime = currentState.playheadPosition;
    const totalDuration = currentState.totalDuration;

    // Find the source track
    let targetTrack = currentState.tracks.find(t => t.id === sourceTrackId);

    // If source track no longer exists, use the first track
    if (!targetTrack) {
      targetTrack = currentState.tracks[0];
      if (!targetTrack) {
        this.notificationsComponent?.showNotification(
          'No tracks available to paste media.',
          'error'
        );
        return;
      }
    }

    const itemDuration = copiedItem.duration;

    // Try to find a valid position starting from playhead
    const pastePosition = this.findPastePosition(
      playheadTime,
      itemDuration,
      targetTrack.items,
      totalDuration
    );

    if (pastePosition === null) {
      this.notificationsComponent?.showNotification(
        'No space available to paste media on this track.',
        'warning'
      );
      return;
    }

    // Save state before modification for undo
    this.saveStateToHistory();

    // Create a new item with a new ID
    const newItem: MediaItem = {
      ...copiedItem,
      id: `item-${Date.now()}`,
      startTime: pastePosition,
      trackId: targetTrack.id
    };

    // Add the new item to the track
    this.state.update(s => ({
      ...s,
      tracks: s.tracks.map(t =>
        t.id === targetTrack!.id
          ? { ...t, items: [...t.items, newItem] }
          : t
      )
    }));

    this.notificationsComponent?.showNotification(
      'Media pasted successfully.',
      'success'
    );
  }

  /**
   * Find a valid position to paste media item.
   * First tries at the playhead position, then finds the next available gap.
   */
  private findPastePosition(
    preferredPosition: number,
    duration: number,
    existingItems: MediaItem[],
    totalDuration: number
  ): number | null {
    // Check if we can fit at the preferred position (playhead)
    if (this.canFitAtPosition(preferredPosition, duration, existingItems, totalDuration)) {
      return preferredPosition;
    }

    // Sort existing items by start time
    const sortedItems = [...existingItems].sort((a, b) => a.startTime - b.startTime);

    // Find all gaps on the track and try to place the item
    const gaps = this.dragDropService.findAllGaps(sortedItems);

    // First, try to find a gap that starts at or after the playhead
    for (const gap of gaps) {
      // Calculate actual gap size (considering totalDuration for infinite gaps)
      const effectiveGapEnd = gap.gapEnd === Infinity ? totalDuration : gap.gapEnd;
      const gapSize = effectiveGapEnd - gap.gapStart;

      if (gap.gapStart >= preferredPosition && gapSize >= duration) {
        return gap.gapStart;
      }
    }

    // If no gap after playhead, try any gap that can fit the item
    for (const gap of gaps) {
      // Calculate actual gap size (considering totalDuration for infinite gaps)
      const effectiveGapEnd = gap.gapEnd === Infinity ? totalDuration : gap.gapEnd;
      const gapSize = effectiveGapEnd - gap.gapStart;

      if (gapSize >= duration) {
        return gap.gapStart;
      }
    }

    // No suitable position found
    return null;
  }

  /**
   * Check if an item can fit at a specific position without overlapping.
   */
  private canFitAtPosition(
    position: number,
    duration: number,
    existingItems: MediaItem[],
    totalDuration: number
  ): boolean {
    // Check bounds
    if (position < 0 || position + duration > totalDuration) {
      return false;
    }

    // Check for overlaps with existing items
    const endPosition = position + duration;
    for (const item of existingItems) {
      const itemEnd = item.startTime + item.duration;
      // Check if there's an overlap
      if (position < itemEnd && endPosition > item.startTime) {
        return false;
      }
    }

    return true;
  }
}

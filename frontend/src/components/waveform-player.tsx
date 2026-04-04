'use client';

import type WaveSurferType from 'wavesurfer.js';
import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { usePlayer } from '@/lib/player-context';
import { api } from '@/lib/api';

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function WaveformPlayer() {
  const { currentTrack, isPlaying, pause, toggle, reportProgress, registerSeek, reportDuration } = usePlayer();
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurferType | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [ready, setReady] = useState(false);

  // Keep isPlayingRef current for use in async callbacks
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Initialize / rebuild WaveSurfer whenever the track changes
  useEffect(() => {
    if (!currentTrack) return;

    let ws: WaveSurferType | null = null;
    let cancelled = false;

    setReady(false);
    setCurrentTime(0);
    setDuration(0);

    async function init() {
      if (!containerRef.current || cancelled) return;

      const { default: WaveSurfer } = await import('wavesurfer.js');
      const { default: HoverPlugin } = await import('wavesurfer.js/dist/plugins/hover.esm.js');
      if (cancelled || !containerRef.current) return;

      // Calculate how many peaks fit the container at the chosen bar dimensions.
      const BAR_WIDTH = 2;
      const BAR_GAP = 1;
      const containerWidth = containerRef.current.clientWidth || 800;
      const numPeaks = Math.min(2000, Math.max(50, Math.ceil(containerWidth / (BAR_WIDTH + BAR_GAP))));

      // Fetch peaks from the backend so WaveSurfer doesn't need to decode
      // the audio via AudioContext (which fails in sandboxed WKWebView).
      const peaks = await api.getFilePeaks(currentTrack!.filePath, numPeaks);
      if (cancelled || !containerRef.current) return;

      // Use an <audio> element for playback so WaveSurfer uses the native
      // media pipeline instead of Web Audio API.
      const audio = new Audio(api.getAudioUrl(currentTrack!.filePath));
      audio.crossOrigin = 'anonymous';
      audio.preload = 'metadata';
      audioRef.current = audio;

      // Wait until audio.duration is a finite positive number before creating
      // WaveSurfer. For AIFF files (served as transcoded WAV), loadedmetadata
      // can fire with duration=Infinity if the browser hasn't read the full
      // RIFF header yet. We also listen to durationchange so we catch the
      // moment the browser settles on a real value.
      await new Promise<void>((resolve) => {
        if (isFinite(audio.duration) && audio.duration > 0) { resolve(); return; }
        const cleanup = () => {
          audio.removeEventListener('durationchange', check);
          audio.removeEventListener('loadedmetadata', check);
          audio.removeEventListener('error', onError);
        };
        const check = () => {
          if (isFinite(audio.duration) && audio.duration > 0) { cleanup(); resolve(); }
        };
        const onError = () => { cleanup(); resolve(); };
        audio.addEventListener('durationchange', check);
        audio.addEventListener('loadedmetadata', check);
        audio.addEventListener('error', onError, { once: true });
      });
      if (cancelled || !containerRef.current) return;
      // Bail on a hard load error (duration stays NaN).
      if (!isFinite(audio.duration) || audio.duration <= 0) return;
      const knownDuration = audio.duration;

      const isDark = document.documentElement.classList.contains('dark');

      // Build canvas gradients for the SoundCloud-style waveform.
      const tmpCanvas = document.createElement('canvas');
      const tmpCtx = tmpCanvas.getContext('2d')!;
      const h = 128;

      const waveGrad = tmpCtx.createLinearGradient(0, 0, 0, h * 1.35);
      if (isDark) {
        waveGrad.addColorStop(0, '#55566a');
        waveGrad.addColorStop((h * 0.7) / h, '#44455a');
        waveGrad.addColorStop((h * 0.7 + 1) / h, '#8888aa');
        waveGrad.addColorStop((h * 0.7 + 2) / h, '#8888aa');
        waveGrad.addColorStop((h * 0.7 + 3) / h, '#333345');
        waveGrad.addColorStop(1, '#333345');
      } else {
        waveGrad.addColorStop(0, '#aaaaab');
        waveGrad.addColorStop((h * 0.7) / h, '#909091');
        waveGrad.addColorStop((h * 0.7 + 1) / h, '#ffffff');
        waveGrad.addColorStop((h * 0.7 + 2) / h, '#ffffff');
        waveGrad.addColorStop((h * 0.7 + 3) / h, '#bbbbbb');
        waveGrad.addColorStop(1, '#bbbbbb');
      }

      const progressGrad = tmpCtx.createLinearGradient(0, 0, 0, h * 1.35);
      /* Primary colors (defined in globals.css: --primary-light, --primary-dark, --primary-accent) */
      progressGrad.addColorStop(0, isDark ? '#d0fd5a' : '#bde752');
      progressGrad.addColorStop((h * 0.7) / h, '#a8cd49');
      progressGrad.addColorStop((h * 0.7 + 1) / h, '#ffffff');
      progressGrad.addColorStop((h * 0.7 + 2) / h, '#ffffff');
      progressGrad.addColorStop((h * 0.7 + 3) / h, '#a8cd49');
      progressGrad.addColorStop(1, '#a8cd49');

      ws = WaveSurfer.create({
        container: containerRef.current,
        height: 44,
        barWidth: BAR_WIDTH,
        barGap: BAR_GAP,
        barRadius: 2,
        normalize: true,
        waveColor: waveGrad,
        progressColor: progressGrad,
        cursorWidth: 0,
        interact: true,
        peaks: [peaks],
        duration: knownDuration,
        media: audio,
        plugins: [
          HoverPlugin.create({
            lineColor: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)',
            lineWidth: 1,
            labelSize: 9,
            labelColor: isDark ? 'rgba(184,188,198,0.95)' : 'rgba(51,51,51,0.9)',
            labelBackground: isDark ? 'rgba(12,16,25,0.82)' : 'rgba(255,255,255,0.82)',
            labelPreferLeft: true,
            formatTimeCallback: formatTime,
          }),
        ],
      });

      wsRef.current = ws;

      ws.on('ready', () => {
        if (cancelled) return;
        setDuration(knownDuration);
        reportDuration(knownDuration);
        setReady(true);
        registerSeek((ratio) => {
          audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
        });
        if (isPlayingRef.current) ws!.play();
      });

      ws.on('audioprocess', () => {
        const t = ws!.getCurrentTime();
        setCurrentTime(t);
        reportProgress(t / knownDuration);
      });

      ws.on('finish', () => {
        pause();
        audio.currentTime = 0;
        setCurrentTime(0);
        reportProgress(0);
      });

      ws.on('seeking', () => {
        const t = ws!.getCurrentTime();
        setCurrentTime(t);
        reportProgress(t / knownDuration);
      });

      ws.on('error', (err) => {
        if (!cancelled) console.error('WaveSurfer error:', err);
      });
    }

    init();

    return () => {
      cancelled = true;
      registerSeek(null);
      reportProgress(0);
      reportDuration(0);
      ws?.destroy();
      wsRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }
    };
  }, [currentTrack?.filePath, pause, reportProgress, registerSeek, reportDuration]);

  // Sync isPlaying state to WaveSurfer
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    if (isPlaying) {
      ws.play();
    } else {
      ws.pause();
    }
  }, [isPlaying, ready]);

  if (!currentTrack) return null;

  const trackLabel = currentTrack.title ?? currentTrack.fileName;
  const artistLabel = currentTrack.artist;

  return (
    <div data-testid="waveform-player" className="fixed bottom-0 left-14 right-0 h-17 bg-card border-t border-border/60 flex items-center gap-4 px-4 z-40 shadow-[0_-8px_32px_rgba(0,0,0,0.18)]">
      {/* Play / Pause */}
      <button
        onClick={() => toggle()}
        disabled={!ready}
        className="size-9 rounded-full disabled:opacity-40 text-primary-foreground flex items-center justify-center shrink-0 transition-colors cursor-pointer disabled:cursor-default"
        style={{ backgroundColor: ready ? 'var(--primary)' : undefined }}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <Pause className="size-4" />
        ) : (
          <Play className="size-4 ml-0.5" />
        )}
      </button>

      {/* Track info */}
      <div className="w-52 shrink-0 min-w-0">
        <p className="text-xs font-semibold truncate text-foreground leading-snug">{trackLabel}</p>
        {artistLabel && (
          <p className="text-[10px] text-muted-foreground truncate leading-snug">{artistLabel}</p>
        )}
      </div>

      {/* Waveform canvas */}
      <div ref={containerRef} className="flex-1 min-w-0" style={{ cursor: 'pointer' }} />

      {/* Time display */}
      <span className="text-[10px] font-mono text-muted-foreground shrink-0 w-18 text-right tabular-nums">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
    </div>
  );
}

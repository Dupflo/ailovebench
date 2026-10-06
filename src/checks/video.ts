import { access } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './build.js';
import type { CheckResult } from './types.js';

export interface VideoInspection {
  exists: boolean;
  codec: string | null;
  width: number | null;
  height: number | null;
  /** Seconds. */
  duration: number | null;
  fps: number | null;
  /** Longest black stretch, in seconds. */
  longestBlack: number;
  /** Longest frozen stretch (no visible change), in seconds. */
  longestFreeze: number;
  /** Contact sheet: 10 frames taken at regular intervals. */
  sheet: string | null;
}

export interface VideoSpec {
  file: string;
  duration: [number, number];
  width: number;
  height: number;
  fps: number;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const ratio = (r: string | undefined) => {
  if (!r) return null;
  const [a, b] = r.split('/').map(Number);
  return b ? a! / b : a ?? null;
};

/** Longest interval from ffmpeg's `black_duration:` / `freeze_duration:` lines. */
function longest(output: string, key: string): number {
  return Math.max(0, ...[...output.matchAll(new RegExp(`${key}:\\s*([\\d.]+)`, 'g'))].map((m) => Number(m[1])));
}

/**
 * Probes a delivered video with ffprobe / ffmpeg: format, black screens (blackdetect), frozen
 * frames (freezedetect), and a 5×2 contact sheet written to `outDir`.
 */
export async function inspectVideo(file: string, outDir: string): Promise<VideoInspection> {
  const empty: VideoInspection = { exists: false, codec: null, width: null, height: null, duration: null, fps: null, longestBlack: 0, longestFreeze: 0, sheet: null };
  try {
    await access(file);
  } catch {
    return empty;
  }
  const probe = await runCommand(`ffprobe -v error -print_format json -show_streams -show_format ${q(file)}`, outDir, 60_000);
  let info: any = {};
  try {
    info = JSON.parse(probe.output);
  } catch {
    return { ...empty, exists: true };
  }
  const v = (info.streams ?? []).find((s: any) => s.codec_type === 'video') ?? {};
  const duration = Number(info.format?.duration ?? v.duration) || null;

  const detect = await runCommand(
    `ffmpeg -hide_banner -nostats -i ${q(file)} -vf "blackdetect=d=0.3:pix_th=0.10,freezedetect=n=0.003:d=0.8" -an -f null -`,
    outDir,
    5 * 60_000,
  );
  const sheet = path.join(outDir, 'video-sheet.png');
  const every = duration ? Math.max(duration / 10, 0.1) : 1;
  const sheetRun = await runCommand(
    `ffmpeg -hide_banner -loglevel error -y -i ${q(file)} -vf "fps=1/${every.toFixed(3)},scale=384:-1,tile=5x2:padding=4:color=white" -frames:v 1 ${q(sheet)}`,
    outDir,
    2 * 60_000,
  );

  return {
    exists: true,
    codec: v.codec_name ?? null,
    width: v.width ?? null,
    height: v.height ?? null,
    duration,
    fps: ratio(v.avg_frame_rate) ?? ratio(v.r_frame_rate),
    longestBlack: longest(detect.output, 'black_duration'),
    longestFreeze: longest(detect.output, 'freeze_duration'),
    sheet: sheetRun.ok ? sheet : null,
  };
}

/** The task's video requirements as checks; a missing file is one failure, not a cascade. */
export function videoChecks(v: VideoInspection, spec: VideoSpec, rel: (p: string) => string = (p) => p): CheckResult[] {
  if (!v.exists) return [{ id: 'video.exists', label: `Vidéo ${spec.file} livrée`, labelEn: `Video ${spec.file} delivered`, status: 'fail', detail: 'fichier absent après le build', detailEn: 'file missing after the build' }];
  const art = v.sheet ? [rel(v.sheet)] : undefined;
  const r = (x: number | null) => (x === null ? '?' : Math.round(x * 10) / 10);
  return [
    { id: 'video.exists', label: `Vidéo ${spec.file} livrée`, labelEn: `Video ${spec.file} delivered`, status: 'pass', detail: spec.file, ...(art ? { artifacts: art } : {}) },
    { id: 'video.codec', label: 'Codec H.264', status: v.codec === 'h264' ? 'pass' : 'fail', detail: v.codec ?? 'inconnu', ...(v.codec ? {} : { detailEn: 'unknown' }) },
    {
      id: 'video.resolution', label: `Résolution ${spec.width}×${spec.height}`, labelEn: `Resolution ${spec.width}×${spec.height}`,
      status: v.width === spec.width && v.height === spec.height ? 'pass' : 'fail', detail: `${v.width ?? '?'}×${v.height ?? '?'}`,
    },
    {
      id: 'video.duration', label: `Durée ${spec.duration[0]}–${spec.duration[1]} s`, labelEn: `Duration ${spec.duration[0]}–${spec.duration[1]} s`,
      status: v.duration !== null && v.duration >= spec.duration[0] && v.duration <= spec.duration[1] ? 'pass' : 'fail',
      ...(v.duration !== null ? { value: r(v.duration) as number } : {}), detail: `${r(v.duration)} s`,
    },
    {
      id: 'video.fps', label: `${spec.fps} images/s`, labelEn: `${spec.fps} frames/s`, status: v.fps !== null && Math.abs(v.fps - spec.fps) <= 1 ? 'pass' : 'fail',
      ...(v.fps !== null ? { value: r(v.fps) as number } : {}),
    },
    {
      id: 'video.black', label: 'Pas d\'écran noir de plus d\'1 s', labelEn: 'No black screen longer than 1 s', status: v.longestBlack <= 1 ? 'pass' : 'fail',
      value: r(v.longestBlack) as number, detail: `plus long écran noir : ${r(v.longestBlack)} s`, detailEn: `longest black screen: ${r(v.longestBlack)} s`,
    },
    {
      id: 'video.freeze', label: 'Pas d\'image figée de plus de 1,5 s', labelEn: 'No frozen frame longer than 1.5 s', status: v.longestFreeze <= 1.5 ? 'pass' : 'fail',
      value: r(v.longestFreeze) as number, detail: `plus long arrêt sur image : ${r(v.longestFreeze)} s`, detailEn: `longest freeze: ${r(v.longestFreeze)} s`,
    },
  ];
}

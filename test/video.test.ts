import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/checks/build.js';
import { inspectVideo, videoChecks } from '../src/checks/video.js';

let dir: string;
const ff = (args: string) => runCommand(`ffmpeg -hide_banner -loglevel error -y ${args}`, dir, 120_000);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'bm-video-'));
  // A good one: 10 s of moving test pattern, 1920×1080, 30 fps, H.264.
  await ff(`-f lavfi -i testsrc2=size=1920x1080:rate=30:duration=10 -c:v libx264 -pix_fmt yuv420p good.mp4`);
  // A bad one: 3 s of black, then 4 s frozen, at the wrong size.
  await ff(`-f lavfi -i color=black:size=1280x720:rate=30:duration=3 -f lavfi -i testsrc2=size=1280x720:rate=30:duration=0.04 -filter_complex "[1:v]loop=loop=119:size=1:start=0,setpts=N/30/TB[f];[0:v][f]concat=n=2:v=1[v]" -map "[v]" -c:v libx264 -pix_fmt yuv420p bad.mp4`);
}, 180_000);

const spec = { file: 'x.mp4', duration: [9.5, 10.5] as [number, number], width: 1920, height: 1080, fps: 30 };

describe('video checks', () => {
  it('passes a clean 10 s 1080p H.264 video and draws a contact sheet', async () => {
    const v = await inspectVideo(path.join(dir, 'good.mp4'), dir);
    expect(v).toMatchObject({ exists: true, codec: 'h264', width: 1920, height: 1080 });
    expect(v.duration).toBeCloseTo(10, 0);
    expect(Math.round(v.fps!)).toBe(30);
    expect(v.longestBlack).toBeLessThan(0.5);
    expect(v.longestFreeze).toBeLessThan(1);
    expect((await stat(v.sheet!)).size).toBeGreaterThan(10_000);
    expect(videoChecks(v, spec).filter((c) => c.status !== 'pass')).toEqual([]);
  }, 120_000);

  it('catches black screens, frozen frames and a wrong size or duration', async () => {
    const v = await inspectVideo(path.join(dir, 'bad.mp4'), dir);
    const failed = videoChecks(v, spec).filter((c) => c.status === 'fail').map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(['video.resolution', 'video.duration', 'video.black', 'video.freeze']));
  }, 120_000);

  it('reports a missing file as a failure, not a crash', async () => {
    const v = await inspectVideo(path.join(dir, 'missing.mp4'), dir);
    expect(v.exists).toBe(false);
    expect(videoChecks(v, spec)).toEqual([expect.objectContaining({ id: 'video.exists', status: 'fail' })]);
  });
});

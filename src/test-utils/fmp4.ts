export interface TestTrack {
  id: number;
  handler: "vide" | "soun";
  timescale: number;
  defaultSampleDuration?: number;
  /** video only, defaults to 1920x1080 */
  width?: number;
  height?: number;
  /** audio only, defaults to aac */
  codec?: "aac" | "opus";
}

export interface TestRun {
  trackId: number;
  durations: number[];
  samples: Buffer[];
  /** the first sample is marked as a non-sync sample through the trun first sample flags */
  nonSyncStart?: boolean;
  /** baseMediaDecodeTime of the tfdt, defaults to 0 */
  decodeTime?: bigint;
}

export interface TestProducerReference {
  trackId: number;
  ntp: bigint;
  mediaTime: bigint;
  flags?: number;
}

export interface TestSegmentOptions {
  prft?: TestProducerReference;
  defaultBaseIsMoof?: boolean;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function u64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(value);
  return buffer;
}

export function box(type: string, ...children: Buffer[]): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + children.reduce((sum, child) => sum + child.length, 0));
  header.write(type, 4, "latin1");
  return Buffer.concat([header, ...children]);
}

export function fullBox(type: string, version: number, flags: number, ...payload: Buffer[]): Buffer {
  return box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...payload);
}

function trak(track: TestTrack): Buffer {
  const tkhd = Buffer.alloc(80);
  tkhd.writeUInt32BE(track.id, 8);
  const mdhd = Buffer.alloc(20);
  mdhd.writeUInt32BE(track.timescale, 8);
  const hdlr = Buffer.concat([u32(0), Buffer.from(track.handler, "latin1"), Buffer.alloc(13)]);

  const esds = fullBox("esds", 0, 0, Buffer.from([
    0x03, 0x19, 0x00, 0x01, 0x00,
    0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x05, 0x02, 0x12, 0x10,
    0x06, 0x01, 0x02,
  ]));
  // channel count at offset 16 of the audio sample entry, width and height at offset 24 of the visual sample entry
  const audioEntry = Buffer.alloc(28);
  audioEntry.writeUInt16BE(1, 16);
  const visualEntry = Buffer.alloc(78);
  visualEntry.writeUInt16BE(track.width ?? 1920, 24);
  visualEntry.writeUInt16BE(track.height ?? 1080, 26);
  // Main profile, compatibility flags 1 and 2, constraint byte 0xB0, level 93
  const hvcC = box("hvcC", Buffer.from([
    0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x00, 93,
    0xf0, 0x00, 0xfc, 0xfd, 0xf8, 0xf8, 0x00, 0x00, 0x0f, 0x00,
  ]));
  // mono, pre-skip 312, 48 kHz input, mapping family 0
  const dOps = box("dOps", Buffer.from([0x00, 0x01, 0x01, 0x38, 0x00, 0x00, 0xbb, 0x80, 0x00, 0x00, 0x00]));
  const audioSampleEntry = track.codec === "opus" ? box("Opus", audioEntry, dOps) : box("mp4a", audioEntry, esds);
  const entry = track.handler === "soun" ? audioSampleEntry : box("hvc1", visualEntry, hvcC);

  return box("trak",
    fullBox("tkhd", 0, 3, tkhd),
    box("mdia",
      fullBox("mdhd", 0, 0, mdhd),
      fullBox("hdlr", 0, 0, hdlr),
      box("minf", box("stbl", fullBox("stsd", 0, 0, u32(1), entry))),
    ),
  );
}

export function initSegment(tracks: TestTrack[]): Buffer {
  return Buffer.concat([
    box("ftyp", Buffer.from("iso6", "latin1"), u32(0), Buffer.from("iso6cmfc", "latin1")),
    box("moov",
      fullBox("mvhd", 0, 0, Buffer.alloc(96)),
      ...tracks.map(trak),
      box("mvex", ...tracks.map(track => fullBox("trex", 0, 0, u32(track.id), u32(1), u32(track.defaultSampleDuration ?? 0), u32(0), u32(0)))),
    ),
  ]);
}

export function prft(reference: TestProducerReference): Buffer {
  const times = Buffer.alloc(16);
  times.writeBigUInt64BE(reference.ntp, 0);
  times.writeBigUInt64BE(reference.mediaTime, 8);
  return fullBox("prft", 1, reference.flags ?? 0, u32(reference.trackId), times);
}

export function mediaSegment(sequence: number, runs: TestRun[], options: TestSegmentOptions = {}): Buffer {
  const defaultBaseIsMoof = options.defaultBaseIsMoof ?? true;
  const trafs = (offsets: number[]) => runs.map((run, index) => box("traf",
    fullBox("tfhd", 0, defaultBaseIsMoof ? 0x20000 : 0, u32(run.trackId)),
    fullBox("tfdt", 1, 0, u64(run.decodeTime ?? 0n)),
    fullBox("trun", 0, run.nonSyncStart ? 0x305 : 0x301, u32(run.samples.length), u32(offsets[index]),
      ...(run.nonSyncStart ? [u32(0x10000)] : []),
      ...run.samples.flatMap((sample, sampleIndex) => [u32(run.durations[sampleIndex]), u32(sample.length)])),
  ));

  const mfhd = fullBox("mfhd", 0, 0, u32(sequence));
  const moofSize = box("moof", mfhd, ...trafs(runs.map(() => 0))).length;
  const lengths = runs.map(run => run.samples.reduce((sum, sample) => sum + sample.length, 0));
  const offsets = runs.map((_, index) => {
    if (!defaultBaseIsMoof && index > 0) {
      return 0;
    }
    return moofSize + 8 + lengths.slice(0, index).reduce((sum, length) => sum + length, 0);
  });

  return Buffer.concat([
    ...(options.prft ? [prft(options.prft)] : []),
    box("moof", mfhd, ...trafs(offsets)),
    box("mdat", ...runs.flatMap(run => run.samples)),
  ]);
}

/**
 * One CMAF track of a muxed fMP4 recording: a CMAF track carries a single media type, so audio and video are uploaded
 * as separate tracks.
 *
 * @group Camera Secure Video
 */
export interface CMAFTrack {
  id: number;
  kind: "video" | "audio";
  /**
   * track name in the upload paths, the names the iCloud ingest expects: `high`, `mid` and `low` for the video tracks
   * by resolution, `audio1` and up for the audio tracks
   */
  name: string;
  timescale: number;
  /** RFC 6381 codecs value from the sample entry; known for HEVC, AVC and AAC */
  codecs?: string;
  /** video only, from the visual sample entry */
  width?: number;
  height?: number;
  /** audio only, from the audio sample entry */
  channels?: number;
  /** CMAF header holding only this track */
  init: Buffer;
  defaultSampleDuration: number;
  defaultSampleFlags: number;
}

/**
 * The part of a media segment that belongs to one track.
 *
 * @group Camera Secure Video
 */
export interface CMAFTrackSegment {
  track: CMAFTrack;
  data: Buffer;
  /** in seconds, from the sample durations */
  duration: number;
  samples: number;
  /** the first sample is a sync sample, so the segment can be decoded on its own */
  startsWithSync: boolean;
}

interface Box {
  type: string;
  start: number;
  contentStart: number;
  end: number;
}

interface Run {
  start: number;
  length: number;
}

interface ProducerReference {
  flags: number;
  trackId: number;
  /** NTP timestamp, 32.32 fixed point */
  ntp: bigint;
  /** decode time in the timescale of the reference track */
  mediaTime: bigint;
}

const VIDEO_TRACK_NAMES = ["high", "mid", "low"];

const TFHD_BASE_DATA_OFFSET = 0x1;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x2;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x8;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x10;
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x20;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x20000;
const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_SAMPLE_FLAGS = 0x4;
const TRUN_SAMPLE_DURATION = 0x100;
const TRUN_SAMPLE_SIZE = 0x200;
const TRUN_SAMPLE_FLAGS = 0x400;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSET = 0x800;
const SAMPLE_IS_NON_SYNC = 0x10000;

function boxes(buffer: Buffer, start = 0, end = buffer.length): Box[] {
  const result: Box[] = [];
  let position = start;
  while (position + 8 <= end) {
    let size = buffer.readUInt32BE(position);
    let contentStart = position + 8;
    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(position + 8));
      contentStart += 8;
    } else if (size === 0) {
      size = end - position;
    }
    if (size < 8 || position + size > end) {
      throw new Error(`truncated ${buffer.toString("latin1", position + 4, position + 8)} box`);
    }
    result.push({ type: buffer.toString("latin1", position + 4, position + 8), start: position, contentStart, end: position + size });
    position += size;
  }
  return result;
}

function child(buffer: Buffer, parent: Box, type: string): Box | undefined {
  return boxes(buffer, parent.contentStart, parent.end).find(box => box.type === type);
}

function slice(buffer: Buffer, box: Box): Buffer {
  return buffer.subarray(box.start, box.end);
}

function makeBox(type: string, ...children: Buffer[]): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + children.reduce((sum, buffer) => sum + buffer.length, 0), 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, ...children]);
}

function fullBoxVersion(buffer: Buffer, box: Box): number {
  return buffer.readUInt8(box.contentStart);
}

function trackId(buffer: Buffer, trak: Box): number {
  const tkhd = child(buffer, trak, "tkhd");
  if (!tkhd) {
    throw new Error("trak without tkhd");
  }
  return buffer.readUInt32BE(tkhd.contentStart + (fullBoxVersion(buffer, tkhd) === 1 ? 20 : 12));
}

function descriptorLength(buffer: Buffer, position: number): { length: number, next: number } {
  let length = 0;
  for (let i = 0; i < 4; i++) {
    const byte = buffer.readUInt8(position++);
    length = (length << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) {
      break;
    }
  }
  return { length, next: position };
}

// RFC 6381: mp4a.<objectTypeIndication hex>.<audio object type>, the object type is the first 5 bits of the
// AudioSpecificConfig in the esds decoder specific info
function aacCodecs(buffer: Buffer, entry: Box): string | undefined {
  const esds = boxes(buffer, entry.contentStart + 28, entry.end).find(box => box.type === "esds");
  if (!esds) {
    return undefined;
  }

  let position = esds.contentStart + 4;
  let objectType: number | undefined;
  while (position + 2 <= esds.end) {
    const tag = buffer.readUInt8(position);
    const { length, next } = descriptorLength(buffer, position + 1);
    if (tag === 0x03) {
      const flags = buffer.readUInt8(next + 2);
      position = next + 3 + (flags & 0x80 ? 2 : 0);
      position += flags & 0x40 ? 1 + buffer.readUInt8(position) : 0;
      position += flags & 0x20 ? 2 : 0;
    } else if (tag === 0x04) {
      objectType = buffer.readUInt8(next);
      position = next + 13;
    } else if (tag === 0x05) {
      if (objectType === undefined || length === 0) {
        return undefined;
      }
      let audioObjectType = buffer.readUInt8(next) >> 3;
      if (audioObjectType === 31 && length > 1) {
        audioObjectType = 32 + (((buffer.readUInt8(next) & 0x07) << 3) | (buffer.readUInt8(next + 1) >> 5));
      }
      return `mp4a.${objectType.toString(16)}.${audioObjectType}`;
    } else {
      position = next + length;
    }
  }
  return undefined;
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function reverseBits(value: number): number {
  let reversed = 0;
  for (let bit = 0; bit < 32; bit++) {
    reversed = (reversed << 1) | ((value >>> bit) & 1);
  }
  return reversed >>> 0;
}

// RFC 6381 with ISO/IEC 14496-15 annex E: avc1.PPCCLL from the avcC profile, constraint and level bytes;
// hvc1.<space><profile>.<reversed compatibility flags>.<tier><level>.<constraint bytes without trailing zeros>
function videoCodecs(buffer: Buffer, entry: Box): string | undefined {
  const children = boxes(buffer, entry.contentStart + 78, entry.end);
  const avcC = children.find(box => box.type === "avcC");
  if (avcC) {
    const c = avcC.contentStart;
    return `${entry.type}.${hex(buffer.readUInt8(c + 1))}${hex(buffer.readUInt8(c + 2))}${hex(buffer.readUInt8(c + 3))}`.toLowerCase();
  }
  const hvcC = children.find(box => box.type === "hvcC");
  if (hvcC) {
    const c = hvcC.contentStart;
    const general = buffer.readUInt8(c + 1);
    const space = ["", "A", "B", "C"][general >> 6];
    const tier = general & 0x20 ? "H" : "L";
    const compatibility = reverseBits(buffer.readUInt32BE(c + 2)).toString(16).toUpperCase();
    const constraints = [...buffer.subarray(c + 6, c + 12)];
    while (constraints.length && constraints[constraints.length - 1] === 0) {
      constraints.pop();
    }
    const level = buffer.readUInt8(c + 12);
    return [`${entry.type}.${space}${general & 0x1f}`, compatibility, `${tier}${level}`, ...constraints.map(hex)].join(".");
  }
  return undefined;
}

function sampleEntry(buffer: Buffer, mdia: Box): Box | undefined {
  const minf = child(buffer, mdia, "minf");
  const stbl = minf && child(buffer, minf, "stbl");
  const stsd = stbl && child(buffer, stbl, "stsd");
  return stsd ? boxes(buffer, stsd.contentStart + 8, stsd.end)[0] : undefined;
}

function describeEntry(buffer: Buffer, kind: "video" | "audio", entry: Box | undefined): Pick<CMAFTrack, "codecs" | "width" | "height" | "channels"> {
  if (!entry) {
    return {};
  }
  try {
    if (kind === "video") {
      return {
        codecs: videoCodecs(buffer, entry),
        width: buffer.readUInt16BE(entry.contentStart + 24),
        height: buffer.readUInt16BE(entry.contentStart + 26),
      };
    }
    return {
      codecs: entry.type === "Opus" ? "Opus" : aacCodecs(buffer, entry),
      channels: buffer.readUInt16BE(entry.contentStart + 16),
    };
  } catch {
    return {};
  }
}

// a CMAF header carries the CMAF track brand (ISO/IEC 23000-19)
function cmafFileType(buffer: Buffer, ftyp: Box | undefined): Buffer {
  const brands = new Set<string>();
  if (ftyp) {
    for (let position = ftyp.contentStart + 8; position + 4 <= ftyp.end; position += 4) {
      brands.add(buffer.toString("latin1", position, position + 4));
    }
  }
  brands.add("iso6");
  brands.add("cmfc");
  const major = ftyp ? buffer.subarray(ftyp.contentStart, ftyp.contentStart + 8) : Buffer.from("iso6\0\0\0\0", "latin1");
  return makeBox("ftyp", major, ...[...brands].map(brand => Buffer.from(brand, "latin1")));
}

/**
 * Splits a muxed fMP4 init segment (ftyp + moov) into one init segment per audio or video track.
 *
 * @group Camera Secure Video
 */
export function splitInitSegment(init: Buffer): CMAFTrack[] {
  const top = boxes(init);
  const ftyp = top.find(box => box.type === "ftyp");
  const moov = top.find(box => box.type === "moov");
  if (!moov) {
    throw new Error("init segment without moov");
  }

  const moovChildren = boxes(init, moov.contentStart, moov.end);
  const mvex = moovChildren.find(box => box.type === "mvex");
  const mvexChildren = mvex ? boxes(init, mvex.contentStart, mvex.end) : [];
  const shared = moovChildren.filter(box => box.type !== "trak" && box.type !== "mvex");

  const tracks: CMAFTrack[] = [];
  for (const trak of moovChildren.filter(box => box.type === "trak")) {
    const mdia = child(init, trak, "mdia");
    const hdlr = mdia && child(init, mdia, "hdlr");
    const mdhd = mdia && child(init, mdia, "mdhd");
    if (!mdia || !hdlr || !mdhd) {
      continue;
    }
    const handler = init.toString("latin1", hdlr.contentStart + 8, hdlr.contentStart + 12);
    const kind = handler === "vide" ? "video" : handler === "soun" ? "audio" : undefined;
    if (!kind) {
      continue;
    }

    const id = trackId(init, trak);
    const trex = mvexChildren.find(box => box.type === "trex" && init.readUInt32BE(box.contentStart + 4) === id);
    const mvexOthers = mvexChildren.filter(box => box.type !== "trex").map(box => slice(init, box));
    const moovOut = makeBox("moov",
      ...shared.map(box => slice(init, box)),
      slice(init, trak),
      ...(mvex ? [makeBox("mvex", ...mvexOthers, ...(trex ? [slice(init, trex)] : []))] : []),
    );

    tracks.push({
      id,
      kind,
      name: kind,
      timescale: init.readUInt32BE(mdhd.contentStart + (fullBoxVersion(init, mdhd) === 1 ? 20 : 12)),
      ...describeEntry(init, kind, sampleEntry(init, mdia)),
      init: Buffer.concat([cmafFileType(init, ftyp), moovOut]),
      defaultSampleDuration: trex ? init.readUInt32BE(trex.contentStart + 12) : 0,
      defaultSampleFlags: trex ? init.readUInt32BE(trex.contentStart + 20) : 0,
    });
  }

  const video = tracks.filter(track => track.kind === "video")
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  if (video.length > VIDEO_TRACK_NAMES.length) {
    throw new Error(`at most ${VIDEO_TRACK_NAMES.length} video tracks are supported, the init segment has ${video.length}`);
  }
  video.forEach((track, index) => {
    track.name = VIDEO_TRACK_NAMES[index];
  });
  const audio = tracks.filter(track => track.kind === "audio");
  audio.forEach((track, index) => {
    track.name = `audio${index + 1}`;
  });
  return [...video, ...audio];
}

interface RebuiltTraf {
  traf: Buffer;
  runs: Run[];
  ticks: number;
  samples: number;
  startsWithSync: boolean;
  /** baseMediaDecodeTime of the tfdt */
  decodeTime?: bigint;
  /** writes the trun data offsets once the start of the new sample data relative to the moof is known */
  patch(dataStart: number): void;
}

function rebuildTraf(segment: Buffer, base: number, traf: Box, track: CMAFTrack): RebuiltTraf {
  const children = boxes(segment, traf.contentStart, traf.end);
  const tfhd = children.find(box => box.type === "tfhd")!;
  const tfhdFlags = segment.readUInt32BE(tfhd.contentStart) & 0xffffff;
  if (tfhdFlags & TFHD_BASE_DATA_OFFSET) {
    throw new Error("tfhd base data offsets are not supported");
  }
  let field = tfhd.contentStart + 8 + (tfhdFlags & TFHD_SAMPLE_DESCRIPTION_INDEX ? 4 : 0);
  const defaultDuration = tfhdFlags & TFHD_DEFAULT_SAMPLE_DURATION ? segment.readUInt32BE(field) : track.defaultSampleDuration;
  field += tfhdFlags & TFHD_DEFAULT_SAMPLE_DURATION ? 4 : 0;
  const defaultSize = tfhdFlags & TFHD_DEFAULT_SAMPLE_SIZE ? segment.readUInt32BE(field) : 0;
  field += tfhdFlags & TFHD_DEFAULT_SAMPLE_SIZE ? 4 : 0;
  const defaultFlags = tfhdFlags & TFHD_DEFAULT_SAMPLE_FLAGS ? segment.readUInt32BE(field) : track.defaultSampleFlags;
  const tfdt = children.find(box => box.type === "tfdt");
  const decodeTime = tfdt && (fullBoxVersion(segment, tfdt) === 1
    ? segment.readBigUInt64BE(tfdt.contentStart + 4)
    : BigInt(segment.readUInt32BE(tfdt.contentStart + 4)));
  let firstFlags: number | undefined;

  const out = Buffer.from(segment.subarray(traf.start, traf.end));
  const runs: Run[] = [];
  const offsetFields: number[] = [];
  let ticks = 0;
  let samples = 0;
  let next = base;

  for (const trun of children.filter(box => box.type === "trun")) {
    const flags = segment.readUInt32BE(trun.contentStart) & 0xffffff;
    const count = segment.readUInt32BE(trun.contentStart + 4);
    samples += count;
    let position = trun.contentStart + 8;
    if (flags & TRUN_DATA_OFFSET) {
      next = base + segment.readInt32BE(position);
      offsetFields.push(position - traf.start);
      position += 4;
    } else {
      offsetFields.push(-1);
    }
    const firstSampleFlags = flags & TRUN_FIRST_SAMPLE_FLAGS ? segment.readUInt32BE(position) : undefined;
    position += flags & TRUN_FIRST_SAMPLE_FLAGS ? 4 : 0;

    let length = 0;
    for (let i = 0; i < count; i++) {
      ticks += flags & TRUN_SAMPLE_DURATION ? segment.readUInt32BE(position) : defaultDuration;
      position += flags & TRUN_SAMPLE_DURATION ? 4 : 0;
      length += flags & TRUN_SAMPLE_SIZE ? segment.readUInt32BE(position) : defaultSize;
      position += flags & TRUN_SAMPLE_SIZE ? 4 : 0;
      if (firstFlags === undefined) {
        firstFlags = firstSampleFlags ?? (flags & TRUN_SAMPLE_FLAGS ? segment.readUInt32BE(position) : defaultFlags);
      }
      position += flags & TRUN_SAMPLE_FLAGS ? 4 : 0;
      position += flags & TRUN_SAMPLE_COMPOSITION_TIME_OFFSET ? 4 : 0;
    }
    runs.push({ start: next, length });
    next += length;
  }

  if (offsetFields.some(offset => offset < 0)) {
    throw new Error("trun without data offset");
  }
  const patch = (dataStart: number) => {
    let offset = dataStart;
    runs.forEach((run, index) => {
      out.writeInt32BE(offset, offsetFields[index]);
      offset += run.length;
    });
  };
  const startsWithSync = firstFlags === undefined || !(firstFlags & SAMPLE_IS_NON_SYNC);
  return { traf: out, runs, ticks, samples, startsWithSync, decodeTime, patch };
}

function producerReference(buffer: Buffer, prft: Box): ProducerReference {
  const c = prft.contentStart;
  return {
    flags: buffer.readUInt32BE(c) & 0xffffff,
    trackId: buffer.readUInt32BE(c + 4),
    ntp: buffer.readBigUInt64BE(c + 8),
    mediaTime: fullBoxVersion(buffer, prft) === 1 ? buffer.readBigUInt64BE(c + 16) : BigInt(buffer.readUInt32BE(c + 16)),
  };
}

// the wall clock of the track's first sample: the reference time shifted by the distance between the two decode times
function trackProducerReference(reference: ProducerReference, referenceTimescale: number | undefined, track: CMAFTrack,
  decodeTime: bigint): Buffer {
  const shift = referenceTimescale
    ? (decodeTime << 32n) / BigInt(track.timescale) - (reference.mediaTime << 32n) / BigInt(referenceTimescale)
    : 0n;
  const shifted = reference.ntp + shift;
  const content = Buffer.alloc(24);
  content.writeUInt32BE((1 << 24) | reference.flags, 0);
  content.writeUInt32BE(track.id, 4);
  content.writeBigUInt64BE(shifted >= 0n && shifted < 1n << 64n ? shifted : reference.ntp, 8);
  content.writeBigUInt64BE(decodeTime, 16);
  return makeBox("prft", content);
}

/**
 * Splits a muxed fMP4 media segment ([prft] moof mdat, possibly repeated) into one CMAF segment per track. Sample data
 * is copied unchanged. A prft in front of a moof is written again for every track, since HKSV and DASH-IF ingest want
 * one in every segment; other boxes are left out.
 *
 * @group Camera Secure Video
 */
export function splitMediaSegment(segment: Buffer, tracks: CMAFTrack[]): CMAFTrackSegment[] {
  const parts = new Map<number, Buffer[]>(tracks.map(track => [track.id, []]));
  const ticks = new Map<number, number>(tracks.map(track => [track.id, 0]));
  const samples = new Map<number, number>(tracks.map(track => [track.id, 0]));
  const startsWithSync = new Map<number, boolean>();

  let reference: ProducerReference | undefined;
  for (const box of boxes(segment)) {
    if (box.type === "prft") {
      reference = producerReference(segment, box);
      continue;
    }
    if (box.type !== "moof") {
      continue;
    }
    const moofReference = reference;
    // a prft describes the moof right after it
    reference = undefined;
    const referenceTimescale = moofReference && tracks.find(track => track.id === moofReference.trackId)?.timescale;

    const mfhd = child(segment, box, "mfhd");
    const mfhdSize = mfhd ? mfhd.end - mfhd.start : 0;
    // without default-base-is-moof a traf continues where the data of the previous one ended
    let previousEnd = box.start;
    for (const traf of boxes(segment, box.contentStart, box.end).filter(entry => entry.type === "traf")) {
      const tfhd = child(segment, traf, "tfhd");
      if (!tfhd) {
        continue;
      }
      const base = segment.readUInt32BE(tfhd.contentStart) & TFHD_DEFAULT_BASE_IS_MOOF ? box.start : previousEnd;
      const track = tracks.find(entry => entry.id === segment.readUInt32BE(tfhd.contentStart + 4));
      if (!track) {
        continue;
      }

      const rebuilt = rebuildTraf(segment, base, traf, track);
      const lastRun = rebuilt.runs.at(-1);
      previousEnd = lastRun ? lastRun.start + lastRun.length : previousEnd;
      rebuilt.patch(8 + mfhdSize + rebuilt.traf.length + 8);
      const moof = makeBox("moof", ...(mfhd ? [slice(segment, mfhd)] : []), rebuilt.traf);
      const mdat = makeBox("mdat", ...rebuilt.runs.map(run => segment.subarray(run.start, run.start + run.length)));
      const prft = moofReference && rebuilt.decodeTime !== undefined
        ? [trackProducerReference(moofReference, referenceTimescale, track, rebuilt.decodeTime)]
        : [];

      parts.get(track.id)!.push(...prft, moof, mdat);
      ticks.set(track.id, ticks.get(track.id)! + rebuilt.ticks);
      samples.set(track.id, samples.get(track.id)! + rebuilt.samples);
      if (!startsWithSync.has(track.id)) {
        startsWithSync.set(track.id, rebuilt.startsWithSync);
      }
    }
  }

  return tracks
    .filter(track => parts.get(track.id)!.length > 0)
    .map(track => ({
      track,
      data: Buffer.concat(parts.get(track.id)!),
      duration: ticks.get(track.id)! / track.timescale,
      samples: samples.get(track.id)!,
      startsWithSync: startsWithSync.get(track.id) ?? true,
    }));
}

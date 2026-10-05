/**
 * One CMAF track of a muxed fMP4 recording: a CMAF track carries a single media type, so audio and video are uploaded
 * as separate tracks.
 *
 * @group Camera Secure Video
 */
export interface CMAFTrack {
  id: number;
  kind: "video" | "audio";
  /** track name in the upload paths, `video` or `audio`, numbered from the second track of a kind on */
  name: string;
  timescale: number;
  /** HLS codecs attribute, only known for AAC audio tracks */
  codecs?: string;
  /** init segment holding only this track */
  init: Buffer;
  defaultSampleDuration: number;
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

const TFHD_BASE_DATA_OFFSET = 0x1;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x2;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x8;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x10;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x20000;
const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_SAMPLE_FLAGS = 0x4;
const TRUN_SAMPLE_DURATION = 0x100;
const TRUN_SAMPLE_SIZE = 0x200;
const TRUN_SAMPLE_FLAGS = 0x400;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSET = 0x800;

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
function parseAacCodecs(buffer: Buffer, stsd: Box): string | undefined {
  const mp4a = boxes(buffer, stsd.contentStart + 8, stsd.end).find(box => box.type === "mp4a");
  if (!mp4a) {
    return undefined;
  }
  const esds = boxes(buffer, mp4a.contentStart + 28, mp4a.end).find(box => box.type === "esds");
  if (!esds) {
    return undefined;
  }

  let position = esds.contentStart + 4;
  const end = esds.end;
  let objectType: number | undefined;
  while (position + 2 <= end) {
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

function aacCodecs(buffer: Buffer, stsd: Box): string | undefined {
  try {
    return parseAacCodecs(buffer, stsd);
  } catch {
    return undefined;
  }
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
  const counts = { video: 0, audio: 0 };
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

    const minf = child(init, mdia, "minf");
    const stbl = minf && child(init, minf, "stbl");
    const stsd = stbl && child(init, stbl, "stsd");

    counts[kind]++;
    tracks.push({
      id,
      kind,
      name: counts[kind] === 1 ? kind : `${kind}${counts[kind]}`,
      timescale: init.readUInt32BE(mdhd.contentStart + (fullBoxVersion(init, mdhd) === 1 ? 20 : 12)),
      codecs: kind === "audio" && stsd ? aacCodecs(init, stsd) : undefined,
      init: Buffer.concat([...(ftyp ? [slice(init, ftyp)] : []), moovOut]),
      defaultSampleDuration: trex ? init.readUInt32BE(trex.contentStart + 12) : 0,
    });
  }
  return tracks;
}

interface RebuiltTraf {
  traf: Buffer;
  runs: Run[];
  ticks: number;
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

  const out = Buffer.from(segment.subarray(traf.start, traf.end));
  const runs: Run[] = [];
  const offsetFields: number[] = [];
  let ticks = 0;
  let next = base;

  for (const trun of children.filter(box => box.type === "trun")) {
    const flags = segment.readUInt32BE(trun.contentStart) & 0xffffff;
    const count = segment.readUInt32BE(trun.contentStart + 4);
    let position = trun.contentStart + 8;
    if (flags & TRUN_DATA_OFFSET) {
      next = base + segment.readInt32BE(position);
      offsetFields.push(position - traf.start);
      position += 4;
    } else {
      offsetFields.push(-1);
    }
    position += flags & TRUN_FIRST_SAMPLE_FLAGS ? 4 : 0;

    let length = 0;
    for (let i = 0; i < count; i++) {
      ticks += flags & TRUN_SAMPLE_DURATION ? segment.readUInt32BE(position) : defaultDuration;
      position += flags & TRUN_SAMPLE_DURATION ? 4 : 0;
      length += flags & TRUN_SAMPLE_SIZE ? segment.readUInt32BE(position) : defaultSize;
      position += flags & TRUN_SAMPLE_SIZE ? 4 : 0;
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
  return { traf: out, runs, ticks, patch };
}

/**
 * Splits a muxed fMP4 media segment ([prft] moof mdat, possibly repeated) into one segment per track. Sample data is
 * copied unchanged; a prft box goes to the track it references.
 *
 * @group Camera Secure Video
 */
export function splitMediaSegment(segment: Buffer, tracks: CMAFTrack[]): CMAFTrackSegment[] {
  const parts = new Map<number, Buffer[]>(tracks.map(track => [track.id, []]));
  const ticks = new Map<number, number>(tracks.map(track => [track.id, 0]));
  let prfts: Box[] = [];

  for (const box of boxes(segment)) {
    if (box.type === "prft") {
      prfts.push(box);
      continue;
    }
    if (box.type !== "moof") {
      continue;
    }

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
      const references = prfts.filter(prft => segment.readUInt32BE(prft.contentStart + 4) === track.id).map(prft => slice(segment, prft));

      parts.get(track.id)!.push(...references, moof, mdat);
      ticks.set(track.id, ticks.get(track.id)! + rebuilt.ticks);
    }
    prfts = [];
  }

  return tracks
    .filter(track => parts.get(track.id)!.length > 0)
    .map(track => ({ track, data: Buffer.concat(parts.get(track.id)!), duration: ticks.get(track.id)! / track.timescale }));
}

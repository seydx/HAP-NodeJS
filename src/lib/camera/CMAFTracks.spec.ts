import { initSegment, mediaSegment } from "../../test-utils/fmp4";
import { splitInitSegment, splitMediaSegment } from "./CMAFTracks";

const VIDEO = { id: 1, handler: "vide" as const, timescale: 90000 };
const AUDIO = { id: 2, handler: "soun" as const, timescale: 32000, defaultSampleDuration: 1024 };

function topLevel(buffer: Buffer): { type: string, start: number, end: number }[] {
  const result = [];
  let position = 0;
  while (position + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(position);
    result.push({ type: buffer.toString("latin1", position + 4, position + 8), start: position, end: position + size });
    position += size;
  }
  return result;
}

function count(buffer: Buffer, type: string): number {
  let found = 0;
  for (let index = buffer.indexOf(type, 0, "latin1"); index >= 0; index = buffer.indexOf(type, index + 1, "latin1")) {
    found++;
  }
  return found;
}

// the payload a single-traf segment points at: moof start + trun data offset
function payload(segment: Buffer): Buffer {
  const boxes = topLevel(segment);
  const moof = boxes.find(entry => entry.type === "moof")!;
  const mdat = boxes.find(entry => entry.type === "mdat")!;
  const trun = segment.indexOf("trun", moof.start, "latin1") - 4;
  const dataOffset = segment.readInt32BE(trun + 16);
  expect(moof.start + dataOffset).toBe(mdat.start + 8);
  return segment.subarray(mdat.start + 8, mdat.end);
}

describe("CMAFTracks", () => {
  test("splits the init segment into one init per track", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, AUDIO]));

    expect(tracks.map(({ id, kind, name, timescale, codecs, defaultSampleDuration }) => ({ id, kind, name, timescale, codecs, defaultSampleDuration })))
      .toEqual([
        { id: 1, kind: "video", name: "video", timescale: 90000, codecs: undefined, defaultSampleDuration: 0 },
        { id: 2, kind: "audio", name: "audio", timescale: 32000, codecs: "mp4a.40.2", defaultSampleDuration: 1024 },
      ]);
    for (const track of tracks) {
      expect(topLevel(track.init).map(entry => entry.type)).toEqual(["ftyp", "moov"]);
      expect(count(track.init, "trak")).toBe(1);
      expect(count(track.init, "trex")).toBe(1);
      expect(count(track.init, "mvhd")).toBe(1);
    }
    expect(count(tracks[0].init, "hvc1")).toBe(1);
    expect(count(tracks[1].init, "mp4a")).toBe(1);
  });

  test("numbers further tracks of the same kind", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, { ...VIDEO, id: 3 }, AUDIO]));
    expect(tracks.map(track => track.name)).toEqual(["video", "video2", "audio"]);
  });

  test("splits a muxed fragment and keeps every sample byte", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, AUDIO]));
    const videoSamples = [Buffer.alloc(300, 0xaa), Buffer.alloc(120, 0xab)];
    const audioSamples = [Buffer.alloc(50, 0xba), Buffer.alloc(60, 0xbb), Buffer.alloc(70, 0xbc)];
    const segment = mediaSegment(7, [
      { trackId: 1, durations: [180000, 180000], samples: videoSamples },
      { trackId: 2, durations: [1024, 1024, 1024], samples: audioSamples },
    ], { prftTrackId: 1 });

    const [video, audio] = splitMediaSegment(segment, tracks);

    expect(video.track.name).toBe("video");
    expect(video.duration).toBe(4);
    expect(topLevel(video.data).map(entry => entry.type)).toEqual(["prft", "moof", "mdat"]);
    expect(payload(video.data)).toEqual(Buffer.concat(videoSamples));

    expect(audio.track.name).toBe("audio");
    expect(audio.duration).toBeCloseTo(3072 / 32000);
    expect(topLevel(audio.data).map(entry => entry.type)).toEqual(["moof", "mdat"]);
    expect(payload(audio.data)).toEqual(Buffer.concat(audioSamples));
    expect(count(audio.data, "traf")).toBe(1);
  });

  test("follows the previous traf when the moof is not the base", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, AUDIO]));
    const videoSamples = [Buffer.alloc(40, 0x01)];
    const audioSamples = [Buffer.alloc(30, 0x02)];
    const segment = mediaSegment(1, [
      { trackId: 1, durations: [90000], samples: videoSamples },
      { trackId: 2, durations: [1024], samples: audioSamples },
    ], { defaultBaseIsMoof: false });

    const [video, audio] = splitMediaSegment(segment, tracks);
    expect(payload(video.data)).toEqual(videoSamples[0]);
    expect(payload(audio.data)).toEqual(audioSamples[0]);
  });

  test("leaves out tracks without samples in the fragment", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, AUDIO]));
    const segment = mediaSegment(1, [{ trackId: 1, durations: [90000], samples: [Buffer.alloc(10)] }]);
    expect(splitMediaSegment(segment, tracks).map(part => part.track.name)).toEqual(["video"]);
  });
});

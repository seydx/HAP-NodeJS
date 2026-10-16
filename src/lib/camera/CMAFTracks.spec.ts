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

    expect(tracks).toMatchObject([
      { id: 1, kind: "video", name: "high", timescale: 90000, codecs: "hvc1.1.6.L93.B0", width: 1920, height: 1080, defaultSampleDuration: 0 },
      { id: 2, kind: "audio", name: "audio1", timescale: 32000, codecs: "mp4a.40.2", channels: 1, defaultSampleDuration: 1024 },
    ]);
    for (const track of tracks) {
      expect(topLevel(track.init).map(entry => entry.type)).toEqual(["ftyp", "moov"]);
      // CMAF headers carry the CMAF track brand
      expect(track.init.toString("latin1", 16, track.init.readUInt32BE(0))).toBe("iso6cmfc");
      expect(count(track.init, "trak")).toBe(1);
      expect(count(track.init, "trex")).toBe(1);
      expect(count(track.init, "mvhd")).toBe(1);
    }
    expect(count(tracks[0].init, "hvc1")).toBe(1);
    expect(count(tracks[1].init, "mp4a")).toBe(1);
  });

  test("describes an Opus audio track", () => {
    const [, audio] = splitInitSegment(initSegment([VIDEO, { ...AUDIO, timescale: 48000, codec: "opus" }]));
    expect(audio).toMatchObject({ kind: "audio", name: "audio1", codecs: "Opus", channels: 1 });
    expect(count(audio.init, "Opus")).toBe(1);
    expect(count(audio.init, "dOps")).toBe(1);
  });

  test("names the video tracks by resolution and numbers the audio tracks", () => {
    const low = { ...VIDEO, id: 3, width: 640, height: 360 };
    const mid = { ...VIDEO, id: 4, width: 1280, height: 720 };
    const tracks = splitInitSegment(initSegment([low, AUDIO, VIDEO, mid, { ...AUDIO, id: 5 }]));
    expect(tracks.map(track => `${track.id} ${track.name}`)).toEqual(["1 high", "4 mid", "3 low", "2 audio1", "5 audio2"]);
    expect(() => splitInitSegment(initSegment([VIDEO, low, mid, { ...VIDEO, id: 6 }]))).toThrow("at most 3 video tracks");
  });

  test("splits a muxed fragment and keeps every sample byte", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, AUDIO]));
    const videoSamples = [Buffer.alloc(300, 0xaa), Buffer.alloc(120, 0xab)];
    const audioSamples = [Buffer.alloc(50, 0xba), Buffer.alloc(60, 0xbb), Buffer.alloc(70, 0xbc)];
    const segment = mediaSegment(7, [
      { trackId: 1, durations: [180000, 180000], samples: videoSamples },
      { trackId: 2, durations: [1024, 1024, 1024], samples: audioSamples },
    ]);

    const [video, audio] = splitMediaSegment(segment, tracks);

    expect(video.track.name).toBe("high");
    expect(video.duration).toBe(4);
    expect(video.samples).toBe(2);
    expect(topLevel(video.data).map(entry => entry.type)).toEqual(["moof", "mdat"]);
    expect(payload(video.data)).toEqual(Buffer.concat(videoSamples));

    expect(audio.track.name).toBe("audio1");
    expect(audio.duration).toBeCloseTo(3072 / 32000);
    expect(audio.samples).toBe(3);
    expect(topLevel(audio.data).map(entry => entry.type)).toEqual(["moof", "mdat"]);
    expect(payload(audio.data)).toEqual(Buffer.concat(audioSamples));
    expect(count(audio.data, "traf")).toBe(1);
  });

  test("writes the prft again for every track", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, AUDIO]));
    const ntp = 0xec5f3a1000000000n;
    // video starts at 10 s, audio 0.1 s later; the prft refers to the video track
    const segment = mediaSegment(3, [
      { trackId: 1, durations: [90000], samples: [Buffer.alloc(40, 0x01)], decodeTime: 900000n },
      { trackId: 2, durations: [1024], samples: [Buffer.alloc(30, 0x02)], decodeTime: 323200n },
    ], { prft: { trackId: 1, ntp, mediaTime: 900000n, flags: 0x18 } });

    const [video, audio] = splitMediaSegment(segment, tracks);
    for (const [part, mediaTime, expectedNtp] of [[video, 900000n, ntp], [audio, 323200n, ntp + 429496729n]] as const) {
      expect(topLevel(part.data).map(entry => entry.type)).toEqual(["prft", "moof", "mdat"]);
      expect(part.data.readUInt8(8)).toBe(1);
      expect(part.data.readUInt32BE(8) & 0xffffff).toBe(0x18);
      expect(part.data.readUInt32BE(12)).toBe(part.track.id);
      expect(part.data.readBigUInt64BE(16)).toBe(expectedNtp);
      expect(part.data.readBigUInt64BE(24)).toBe(mediaTime);
      expect(payload(part.data.subarray(32))).toHaveLength(part.track.kind === "video" ? 40 : 30);
    }
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

  test("tells whether a fragment starts with a sync sample", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, AUDIO]));
    const sample = Buffer.alloc(10);
    const synced = splitMediaSegment(mediaSegment(1, [{ trackId: 1, durations: [90000], samples: [sample] }]), tracks);
    const unsynced = splitMediaSegment(mediaSegment(2, [{ trackId: 1, durations: [90000], samples: [sample], nonSyncStart: true }]), tracks);
    expect(synced[0].startsWithSync).toBe(true);
    expect(unsynced[0].startsWithSync).toBe(false);
    // the data offset still points at the samples after the extra first sample flags field
    expect(payload(unsynced[0].data)).toEqual(sample);
  });

  test("leaves out tracks without samples in the fragment", () => {
    const tracks = splitInitSegment(initSegment([VIDEO, AUDIO]));
    const segment = mediaSegment(1, [{ trackId: 1, durations: [90000], samples: [Buffer.alloc(10)] }]);
    expect(splitMediaSegment(segment, tracks).map(part => part.track.name)).toEqual(["high"]);
  });
});

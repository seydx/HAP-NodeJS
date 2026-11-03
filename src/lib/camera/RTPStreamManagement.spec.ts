import type { MockInstance } from 'vitest'

import { Buffer } from 'node:buffer'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AudioBitrate,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraRecordingOptions,
  H264Level,
  H264Profile,
  MediaContainerType,
  RecordingPacket,
  VideoCodecType,
} from '../camera/index.js'
import {
  CameraController,
  CameraControllerOptions,
  CameraRecordingDelegate,
  CameraStreamingDelegate,
  PrepareStreamCallback,
} from '../controller/index.js'
import { HAPStatus } from '../HAPServer.js'
import { HAPConnection } from '../util/eventedhttp.js'
import * as tlv from '../util/tlv.js'
import * as uuid from '../util/uuid.js'
import RTPProxy from './RTPProxy.js'
import { CameraStreamingOptions, RTPStreamManagement, SRTPCryptoSuites } from './RTPStreamManagement.js'

import '../definitions/index.js'

class MockDelegate implements CameraStreamingDelegate, CameraRecordingDelegate {
  handleSnapshotRequest(): void {
    throw new Error('Unsupported!')
  }

  handleStreamRequest(): void {
    throw new Error('Unsupported!')
  }

  prepareStream(): void {
    throw new Error('Unsupported!')
  }

  async* handleRecordingStreamRequest(): AsyncGenerator<RecordingPacket> {
    yield {
      data: Buffer.alloc(64, 0),
      isLast: true,
    }
  }

  closeRecordingStream(): void {}

  updateRecordingActive(): void {}

  updateRecordingConfiguration(): void {}
}

const baseStreamingOptions: CameraStreamingOptions = {
  supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
  video: {
    codec: {
      profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
      levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
    },
    resolutions: [
      [1920, 1080, 30],
      [1280, 720, 30],
      [320, 240, 15],
    ],
  },
  audio: {
    twoWayAudio: true,
    codecs: [
      {
        type: AudioStreamingCodecType.AAC_ELD,
        samplerate: AudioStreamingSamplerate.KHZ_24,
      },
    ],
  },
}

const baseRecordingOptions: CameraRecordingOptions = {
  prebufferLength: 4000,
  mediaContainerConfiguration: [
    {
      type: MediaContainerType.FRAGMENTED_MP4,
      fragmentLength: 8000,
    },
  ],
  video: {
    type: VideoCodecType.H264,
    parameters: baseStreamingOptions.video.codec,
    resolutions: baseStreamingOptions.video.resolutions,
  },
  audio: {
    codecs: [
      {
        type: AudioRecordingCodecType.AAC_ELD,
        audioChannels: 1,
        bitrateMode: AudioBitrate.VARIABLE,
        samplerate: AudioRecordingSamplerate.KHZ_48,
      },
    ],
  },
}

function buildControllerOptions(streamingOptions: CameraStreamingOptions): CameraControllerOptions {
  const delegate = new MockDelegate()
  return {
    cameraStreamCount: 2,
    delegate,
    streamingOptions,
    recording: {
      options: baseRecordingOptions,
      delegate,
    },
    sensors: { motion: true, occupancy: true },
  }
}

// matches the private const enums in RTPStreamManagement.ts
const SetupEndpointsTypes = {
  SESSION_ID: 0x01,
  CONTROLLER_ADDRESS: 0x03,
  VIDEO_SRTP_PARAMETERS: 0x04,
  AUDIO_SRTP_PARAMETERS: 0x05,
} as const
const AddressTypes = {
  ADDRESS_VERSION: 0x01,
  ADDRESS: 0x02,
  VIDEO_RTP_PORT: 0x03,
  AUDIO_RTP_PORT: 0x04,
} as const
const SRTPParametersTypes = {
  SRTP_CRYPTO_SUITE: 0x01,
  MASTER_KEY: 0x02,
  MASTER_SALT: 0x03,
} as const

function buildSetupEndpointsTlv(withPorts = true): string {
  const addressTlv = withPorts
    ? tlv.encode(
        AddressTypes.ADDRESS_VERSION, 0x00, // IPV4
        AddressTypes.ADDRESS, '127.0.0.1',
        AddressTypes.VIDEO_RTP_PORT, tlv.writeUInt16(5000),
        AddressTypes.AUDIO_RTP_PORT, tlv.writeUInt16(5001),
      )
    : tlv.encode(
        AddressTypes.ADDRESS_VERSION, 0x00, // IPV4
        AddressTypes.ADDRESS, '127.0.0.1',
      )
  const srtpTlv = tlv.encode(
    SRTPParametersTypes.SRTP_CRYPTO_SUITE, SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
    SRTPParametersTypes.MASTER_KEY, Buffer.alloc(16),
    SRTPParametersTypes.MASTER_SALT, Buffer.alloc(14),
  )
  const payload = tlv.encode(
    SetupEndpointsTypes.SESSION_ID, uuid.write('11111111-1111-1111-1111-111111111111'),
    SetupEndpointsTypes.CONTROLLER_ADDRESS, addressTlv,
    SetupEndpointsTypes.VIDEO_SRTP_PARAMETERS, srtpTlv,
    SetupEndpointsTypes.AUDIO_SRTP_PARAMETERS, srtpTlv,
  )
  return payload.toString('base64')
}

function buildMockConnection(): HAPConnection {
  return {
    localAddress: '127.0.0.1',
    getLocalAddress: vi.fn().mockReturnValue('127.0.0.1'),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn().mockReturnValue(10),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as HAPConnection
}

describe('rTPStreamManagement', () => {
  describe('_handleStartStream malformed TLV (fix 34056583)', () => {
    let controller: CameraController

    beforeEach(() => {
      controller = new CameraController(buildControllerOptions(baseStreamingOptions))
      controller.constructServices()
      controller.configureServices()
    })

    afterEach(() => {
      controller.handleFactoryReset()
    })

    it('empty video configuration should call callback with INVALID_VALUE_IN_REQUEST', () => {
      const rtp = controller.streamManagements[0] as RTPStreamManagement
      const callback = vi.fn();

      // empty video/audio config — every indexed buffer access (e.g.
      // `videoParameters[VideoCodecParametersTypes.PROFILE_ID][0]`) would
      // throw without the try/catch from 34056583.

      (rtp as any)._handleStartStream({}, {}, callback)

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0]).toBe(HAPStatus.INVALID_VALUE_IN_REQUEST)
    })

    it('video configuration missing CODEC_PARAMETERS should not throw', () => {
      const rtp = controller.streamManagements[0] as RTPStreamManagement
      const callback = vi.fn()

      // SelectedVideoParametersTypes.CODEC_TYPE = 0x01 — provide that but
      // omit CODEC_PARAMETERS / ATTRIBUTES / RTP_PARAMETERS so the inner
      // `tlv.decode(undefined)` would have crashed without the guard.
      const videoConfig = {
        0x01: Buffer.from([0x00]),
      }

      expect(() => {
        (rtp as any)._handleStartStream(videoConfig, {}, callback)
      }).not.toThrow()

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0]).toBe(HAPStatus.INVALID_VALUE_IN_REQUEST)
    })
  })

  describe('handleSetupEndpoints proxy rejection (fix 0ce74c4e)', () => {
    let controller: CameraController
    let setupSpy: MockInstance

    beforeEach(() => {
      const proxyOptions: CameraStreamingOptions = {
        ...baseStreamingOptions,
        proxy: true,
      }
      controller = new CameraController(buildControllerOptions(proxyOptions))
      controller.constructServices()
      controller.configureServices()
    })

    afterEach(() => {
      setupSpy?.mockRestore()
      controller.handleFactoryReset()
    })

    it('should fail gracefully when RTPProxy.setup rejects', async () => {
      setupSpy = vi.spyOn(RTPProxy.prototype, 'setup')
        .mockImplementation(() => Promise.reject(new Error('socket creation failed')))

      const rtp = controller.streamManagements[0] as RTPStreamManagement
      const error = await new Promise<Error | undefined>((resolve) => {
        // @ts-expect-error: private method access
        rtp.handleSetupEndpoints(buildSetupEndpointsTlv(), (err) => {
          resolve(err as Error | undefined)
        }, buildMockConnection())
      })

      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toBe('socket creation failed')
    })

    it('should set setupEndpointsResponse to ERROR status when proxy setup rejects', async () => {
      setupSpy = vi.spyOn(RTPProxy.prototype, 'setup')
        .mockImplementation(() => Promise.reject(new Error('bind failed')))

      const rtp = controller.streamManagements[0] as RTPStreamManagement
      await new Promise<void>((resolve) => {
        // @ts-expect-error: private method access
        rtp.handleSetupEndpoints(buildSetupEndpointsTlv(), () => resolve(), buildMockConnection())
      })

      const response = (rtp as any).setupEndpointsResponse as string
      const decoded = tlv.decode(Buffer.from(response, 'base64'))
      // SetupEndpointsResponseTypes.STATUS = 0x02; SetupEndpointsStatus.ERROR = 0x02
      expect(decoded[0x02].readUInt8(0)).toBe(0x02)
    })
  })

  describe('handleSetupEndpoints malformed TLV', () => {
    let controller: CameraController

    beforeEach(() => {
      controller = new CameraController(buildControllerOptions(baseStreamingOptions))
      controller.constructServices()
      controller.configureServices()
    })

    afterEach(() => {
      controller.handleFactoryReset()
    })

    it('should reject a request without ports and not keep the stream busy', async () => {
      const rtp = controller.streamManagements[0] as RTPStreamManagement
      const callback = vi.fn()

      expect(() => {
        // @ts-expect-error: private method access
        rtp.handleSetupEndpoints(buildSetupEndpointsTlv(false), callback, buildMockConnection())
      }).not.toThrow()

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0]).toBe(HAPStatus.INVALID_VALUE_IN_REQUEST)
      expect(rtp.streamStatus).toBe(0) // StreamingStatus.AVAILABLE
      expect(rtp.sessionIdentifier).toBeUndefined()

      // the next valid request must not be answered with BUSY
      await new Promise<void>((resolve) => {
        // @ts-expect-error: private method access
        rtp.handleSetupEndpoints(buildSetupEndpointsTlv(), () => resolve(), buildMockConnection())
      })
      const decoded = tlv.decode(Buffer.from((rtp as any).setupEndpointsResponse as string, 'base64'))
      // SetupEndpointsResponseTypes.STATUS = 0x02; SetupEndpointsStatus.BUSY = 0x01
      expect(decoded[0x02].readUInt8(0)).not.toBe(0x01)
    })
  })

  describe('handleSetupEndpoints invalid PrepareStreamResponse', () => {
    let controller: CameraController

    beforeEach(() => {
      controller = new CameraController(buildControllerOptions(baseStreamingOptions))
      controller.constructServices()
      controller.configureServices()
    })

    afterEach(() => {
      vi.restoreAllMocks()
      controller.handleFactoryReset()
    })

    it('should answer with an error when a delayed response is missing the audio info', async () => {
      const rtp = controller.streamManagements[0] as RTPStreamManagement
      const prepareStream = (_request: unknown, callback: PrepareStreamCallback) => {
        // like most plugins, call back after some asynchronous work
        setTimeout(() => callback(undefined, {
          video: {
            port: 5000,
            ssrc: 1,
            srtp_key: Buffer.alloc(16),
            srtp_salt: Buffer.alloc(14),
          },
        }), 1)
      }
      vi.spyOn(MockDelegate.prototype, 'prepareStream').mockImplementation(prepareStream as () => void)

      const errors: Error[] = []
      const onUncaught = (error: Error) => errors.push(error)
      process.on('uncaughtException', onUncaught)

      try {
        const error = await new Promise<Error | undefined>((resolve, reject) => {
          setTimeout(() => reject(new Error('SetupEndpoints callback was never called')), 500)
          // @ts-expect-error: private method access
          rtp.handleSetupEndpoints(buildSetupEndpointsTlv(), err => resolve(err as Error | undefined), buildMockConnection())
        })

        expect(error).toBeInstanceOf(Error)
      } finally {
        process.off('uncaughtException', onUncaught)
      }

      expect(errors).toEqual([])
      expect(rtp.streamStatus).toBe(0) // StreamingStatus.AVAILABLE
      const decoded = tlv.decode(Buffer.from((rtp as any).setupEndpointsResponse as string, 'base64'))
      // SetupEndpointsResponseTypes.STATUS = 0x02; SetupEndpointsStatus.ERROR = 0x02
      expect(decoded[0x02].readUInt8(0)).toBe(0x02)
    })
  })
})

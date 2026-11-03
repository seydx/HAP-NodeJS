import type { Mock } from 'vitest'

import { EventEmitter } from 'node:events'

import dbus, { DBusError, MessageBus } from 'dbus-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AvahiAdvertiser, CiaoAdvertiser, DBusInvokeError, PairingFeatureFlag, ResolvedAdvertiser, StatusFlag } from './Advertiser.js'
import { AccessoryInfo } from './model/AccessoryInfo.js'

type InvokeHandler = (msg: any) => unknown

const buses: { connection: EventEmitter, invoke: Mock }[] = []
let invokeHandler: InvokeHandler = () => undefined

// Advertiser.ts calls systemBus() through dbus-native's default export, so a spy there catches every bus it opens
function fakeSystemBus(): MessageBus {
  const connection = Object.assign(new EventEmitter(), {
    stream: {
      destroy: vi.fn(),
    },
  })
  process.nextTick(() => connection.emit('connect'))

  const bus = {
    connection,
    invoke: vi.fn(async (msg: any) => invokeHandler(msg)),
  }
  buses.push(bus)
  return bus as unknown as MessageBus
}

function dbusError(dbusName: string, message: string): DBusError {
  const error = new DBusError(message)
  error.dbusName = dbusName
  return error
}

describe('ciaoAdvertiser', () => {
  describe('ff and sf', () => {
    it('should correctly format pairing feature flags', () => {
      expect(CiaoAdvertiser.ff()).toEqual(0)
      expect(CiaoAdvertiser.ff(PairingFeatureFlag.SUPPORTS_HARDWARE_AUTHENTICATION)).toEqual(1)
      expect(CiaoAdvertiser.ff(PairingFeatureFlag.SUPPORTS_SOFTWARE_AUTHENTICATION)).toEqual(2)
      expect(CiaoAdvertiser.ff(
        PairingFeatureFlag.SUPPORTS_HARDWARE_AUTHENTICATION,
        PairingFeatureFlag.SUPPORTS_SOFTWARE_AUTHENTICATION,
      )).toEqual(3)
    })

    it('should correctly format status flags', () => {
      expect(CiaoAdvertiser.sf()).toEqual(0)

      expect(CiaoAdvertiser.sf(StatusFlag.NOT_PAIRED)).toEqual(1)
      expect(CiaoAdvertiser.sf(StatusFlag.NOT_JOINED_WIFI)).toEqual(2)
      expect(CiaoAdvertiser.sf(StatusFlag.PROBLEM_DETECTED)).toEqual(4)

      expect(CiaoAdvertiser.sf(StatusFlag.NOT_PAIRED, StatusFlag.NOT_JOINED_WIFI)).toEqual(3)
      expect(CiaoAdvertiser.sf(StatusFlag.NOT_PAIRED, StatusFlag.PROBLEM_DETECTED)).toEqual(5)
      expect(CiaoAdvertiser.sf(StatusFlag.NOT_JOINED_WIFI, StatusFlag.PROBLEM_DETECTED)).toEqual(6)

      expect(CiaoAdvertiser.sf(StatusFlag.NOT_PAIRED, StatusFlag.NOT_JOINED_WIFI, StatusFlag.PROBLEM_DETECTED)).toEqual(7)
    })
  })
})

describe('dBusInvokeError', () => {
  it('should take the D-Bus error name from a dbus-native DBusError', () => {
    const error = new DBusInvokeError(dbusError('org.freedesktop.DBus.Error.AccessDenied', 'Access denied'))

    expect(error.errorName).toEqual('org.freedesktop.DBus.Error.AccessDenied')
    expect(error.message).toEqual('Access denied')
  })
})

describe('d-Bus advertisers', () => {
  beforeEach(() => {
    buses.length = 0
    invokeHandler = () => undefined
    vi.spyOn(dbus, 'systemBus').mockImplementation(fakeSystemBus)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should listen for handlerError on every system bus it opens', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(new AvahiAdvertiser(AccessoryInfo.create('AA:BB:CC:DD:EE:FF'))).toBeInstanceOf(AvahiAdvertiser)
      expect(new ResolvedAdvertiser(AccessoryInfo.create('AA:BB:CC:DD:EE:FF'))).toBeInstanceOf(ResolvedAdvertiser)

      expect(buses).toHaveLength(2)
      for (const bus of buses) {
        expect(bus.connection.listenerCount('handlerError')).toEqual(1)
        bus.connection.emit('handlerError', new Error('Rejected send message'))
      }
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Rejected send message'))
    } finally {
      warn.mockRestore()
    }
  })

  it('should warn about a connection error on every system bus it opens instead of crashing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(new AvahiAdvertiser(AccessoryInfo.create('AA:BB:CC:DD:EE:FF'))).toBeInstanceOf(AvahiAdvertiser)
      expect(new ResolvedAdvertiser(AccessoryInfo.create('AA:BB:CC:DD:EE:FF'))).toBeInstanceOf(ResolvedAdvertiser)
      await new Promise(resolve => process.nextTick(resolve)) // the fake buses connect on the next tick

      expect(buses).toHaveLength(2)
      for (const bus of buses) {
        expect(() => bus.connection.emit('error', new Error('read ECONNRESET'))).not.toThrow()
      }
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('read ECONNRESET'))
    } finally {
      warn.mockRestore()
    }
  })

  it('should not warn when the system bus cannot be reached while checking availability', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const available = AvahiAdvertiser.isAvailable()
      // fails before the fake bus connects on the next tick
      buses[0].connection.emit('error', new Error('connect ENOENT /var/run/dbus/system_bus_socket'))
      await expect(available).resolves.toBe(false)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('should read MulticastDNS from systemd-resolved as a plain value', async () => {
    invokeHandler = msg => msg.member === 'Get'
      ? 'yes'
      : undefined
    await expect(ResolvedAdvertiser.isAvailable()).resolves.toBe(true)

    invokeHandler = msg => msg.member === 'Get'
      ? 'no'
      : undefined
    await expect(ResolvedAdvertiser.isAvailable()).resolves.toBe(false)
  })

  it('should point at the mDNS wiki when systemd-resolved refuses permission', async () => {
    invokeHandler = () => {
      throw dbusError('org.freedesktop.DBus.Error.AccessDenied', 'Access denied')
    }
    const advertiser = new ResolvedAdvertiser(AccessoryInfo.create('AA:BB:CC:DD:EE:FF'))
    advertiser.initPort(51826)

    await expect(advertiser.startAdvertising()).rejects.toThrow('Permissions issue')
  })
})

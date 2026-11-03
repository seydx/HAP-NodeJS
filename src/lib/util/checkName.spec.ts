import type { MockInstance } from 'vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkName } from './checkName.js'

describe('#checkName()', () => {
  let consoleWarnSpy: MockInstance

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
  })

  it('accessory Name ending with !', async () => {
    checkName('displayName', 'Name', 'bad name!')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)

    expect(consoleWarnSpy).toHaveBeenCalledWith('HAP-NodeJS WARNING: The accessory \'displayName\' has an invalid \'Name\' characteristic (\'bad name!\'). Please ensure the name starts and ends with a letter or number. Only letters, numbers, spaces, apostrophes, and common punctuation are supported. Avoid emojis or unsupported symbols. This may prevent the accessory from being added in the Home App or cause unresponsiveness.')
  })

  it('accessory Name beginning with !', async () => {
    checkName('displayName', 'Name', '!bad name')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)

    expect(consoleWarnSpy).toHaveBeenCalledWith('HAP-NodeJS WARNING: The accessory \'displayName\' has an invalid \'Name\' characteristic (\'!bad name\'). Please ensure the name starts and ends with a letter or number. Only letters, numbers, spaces, apostrophes, and common punctuation are supported. Avoid emojis or unsupported symbols. This may prevent the accessory from being added in the Home App or cause unresponsiveness.')
  })

  it('accessory Name containing !', async () => {
    checkName('displayName', 'Name', 'bad ! name')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(0)
  })

  it('accessory Name beginning with \'', async () => {
    checkName('displayName', 'Name', ' \'bad name')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)

    expect(consoleWarnSpy).toHaveBeenCalledWith('HAP-NodeJS WARNING: The accessory \'displayName\' has an invalid \'Name\' characteristic (\' \'bad name\'). Please ensure the name starts and ends with a letter or number. Only letters, numbers, spaces, apostrophes, and common punctuation are supported. Avoid emojis or unsupported symbols. This may prevent the accessory from being added in the Home App or cause unresponsiveness.')
  })

  it('accessory Name containing \'', async () => {
    checkName('displayName', 'Name', 'good \' name')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(0)
  })

  it('accessory Name containing /', async () => {
    checkName('displayName', 'Name', 'good / name')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(0)
  })

  it('accessory Name containing &', async () => {
    checkName('displayName', 'Name', 'good & name')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(0)
  })

  it('accessory Name containing :', async () => {
    checkName('displayName', 'Name', 'good : name')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(0)
  })

  it('accessory Name containing ()', async () => {
    checkName('displayName', 'Name', 'good (name) here')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(0)
  })

  it('accessory Name of a single letter or number', async () => {
    checkName('displayName', 'Name', 'A')
    checkName('displayName', 'Name', '1')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(0)
  })

  it('accessory Name of a single symbol', async () => {
    checkName('displayName', 'Name', '!')

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })
})

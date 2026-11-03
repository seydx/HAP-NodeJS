import { vi } from 'vitest'

class Advertisement {
  updateTxt = vi.fn()
  stop = vi.fn()
  destroy = vi.fn()
}

class BonjourService {
  publish = vi.fn(() => {
    return new Advertisement()
  })

  destroy = vi.fn()
}

export default (): BonjourService => {
  return new BonjourService()
}

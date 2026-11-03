import { describe, expect, it } from 'vitest'

// we just test that we can import index e.g. without any cyclic imports
import './index.js'

describe('index', () => {
  it('index import', () => {
    expect(true).toBeTruthy()
  })
})

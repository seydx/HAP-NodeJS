import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, vi } from 'vitest'

import { HAPStorage } from './src/lib/model/HAPStorage.js'

// Characteristic and Service don't load their own definitions (that made an import cycle), so the
// static properties like Service.Lightbulb only exist once the definitions are loaded, as src/index.ts does first
import './src/lib/definitions/index.js'

// Jest picked up __mocks__/bonjour-hap.ts for every test file on its own; vitest needs to be told
vi.mock('bonjour-hap')

// Redirect the HAPStorage singleton into a fresh temporary directory for every test file,
// so suites which exercise persistence (e.g. through Accessory.publish()) never touch
// a real "persist" directory inside the repository.
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hap-nodejs-vitest-'))
HAPStorage.setCustomStoragePath(storageDir)

afterAll(() => {
  fs.rmSync(storageDir, { recursive: true, force: true })
})

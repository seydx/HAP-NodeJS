import * as hapNodeJs from './hap.js'

export * from './hap.js'

// Until 2.3.0 this package was CommonJS, so `import hap from '@homebridge/hap-nodejs'` received the whole module
// (homebridge itself imports it that way). Keep that working: the default export is the module as a whole.
export default hapNodeJs

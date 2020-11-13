import Module from 'module'
import { basename, dirname, extname, resolve } from 'path'
import { InputOptions, OutputOptions } from 'rollup'
import { terser } from 'rollup-plugin-terser'
import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import alias from '@rollup/plugin-alias'
import json from '@rollup/plugin-json'
import replace from '@rollup/plugin-replace'
import virtual from '@rollup/plugin-virtual'
import analyze from 'rollup-plugin-analyzer'

import hasha from 'hasha'
import { SLSOptions } from '../config'
import { resolvePath } from '../utils'
import dynamicRequire from './dynamic-require'

export type RollupConfig = InputOptions & { output: OutputOptions }

export const getRollupConfig = (config: SLSOptions) => {
  const genericMocks = [
    // @nuxt/devalue
    'consola',
    // vue2
    'encoding',
    'stream',
    'he',
    'resolve',
    'source-map',
    'lodash.template',
    'serialize-javascript',
    // vue3
    '@babel/parser',
    '@vue/compiler-core',
    '@vue/compiler-dom',
    '@vue/compiler-ssr'
  ]

  const providedDeps = [
    '@nuxt/devalue',
    'vue-bundle-renderer',
    '@cloudflare/kv-asset-handler'
  ]

  const extensions = ['.ts', '.mjs', '.js', '.json', '.node']

  const external = []

  const aliases: {[key: string]: string} = {}

  if (config.node === false) {
    // Generic mocks
    Object.assign(aliases, [...genericMocks, ...Module.builtinModules].reduce((p, c) => ({ ...p, [c]: '~mock' }), {}))

    // Custom
    aliases.depd = '~runtime/mocks/depd'
    aliases.http = '~runtime/mocks/http'

    // Builtin (browserify)
    aliases.buffer = require.resolve('buffer/index.js')
    aliases.util = require.resolve('util/util.js')
    aliases.events = require.resolve('events/events.js')
    aliases.inherits = require.resolve('inherits/inherits_browser.js')
  } else {
    external.push(...Module.builtinModules)
  }

  const outFile = resolve(config.targetDir, config.outName)

  const options: RollupConfig = {
    input: resolvePath(config, config.entry),
    output: {
      file: outFile,
      format: 'cjs',
      intro: '',
      outro: '',
      preferConst: true
    },
    external,
    plugins: []
  }

  if (config.logStartup) {
    options.output.intro += 'global._startTime = process.hrtime();'
    // eslint-disable-next-line no-template-curly-in-string
    options.output.outro += 'global._endTime = process.hrtime(global._startTime); global._coldstart = ((global._endTime[0] * 1e9) + global._endTime[1]) / 1e6; console.log(`λ Cold start took: ${global._coldstart}ms`);'
  }

  // https://github.com/rollup/plugins/tree/master/packages/replace
  options.plugins.push(replace({
    values: {
      'process.env.NODE_ENV': '"production"',
      'typeof window': '"undefined"',
      'process.env.ROUTER_BASE': JSON.stringify(config.routerBase),
      'process.env.PUBLIC_PATH': JSON.stringify(config.publicPath),
      'process.env.NUXT_STATIC_BASE': JSON.stringify(config.staticAssets.base),
      'process.env.NUXT_STATIC_VERSION': JSON.stringify(config.staticAssets.version),
      // @ts-ignore
      'process.env.NUXT_FULL_STATIC': config.fullStatic
    }
  }))

  // Dynamic Require Support
  options.plugins.push(dynamicRequire({
    dir: resolve(config.buildDir, 'dist/server'),
    outDir: (config.node === false || config.inlineChunks) ? undefined : dirname(outFile),
    chunksDir: '_' + basename(outFile, extname(outFile)),
    globbyOptions: {
      ignore: [
        'server.js'
      ]
    }
  }))

  // Provide serverMiddleware
  const getImportId = p => '_' + hasha(p).substr(0, 6)
  options.plugins.push(virtual({
    '~serverMiddleware': `
      ${config.serverMiddleware.map(m => `import ${getImportId(m.handle)} from '${m.handle}';`).join('\n')}

      export default [
        ${config.serverMiddleware.map(m => `{ route: '${m.route}', handle: ${getImportId(m.handle)} }`).join(',\n')}
      ];
    `
  }))

  // https://github.com/rollup/plugins/tree/master/packages/alias
  const renderer = config.renderer || 'vue2'
  options.plugins.push(alias({
    entries: {
      '~runtime': config.runtimeDir,
      '~renderer': require.resolve(resolve(config.runtimeDir, 'ssr', renderer)),
      '~build': config.buildDir,
      '~mock': require.resolve(resolve(config.runtimeDir, 'mocks/generic')),
      ...providedDeps.reduce((p, c) => ({ ...p, [c]: require.resolve(c) }), {}),
      ...aliases
    }
  }))

  // https://github.com/rollup/plugins/tree/master/packages/node-resolve
  options.plugins.push(nodeResolve({
    extensions,
    preferBuiltins: true,
    rootDir: config.rootDir,
    // https://www.npmjs.com/package/resolve
    customResolveOptions: { basedir: config.rootDir },
    mainFields: ['main'] // Force resolve CJS (@vue/runtime-core ssrUtils)
  }))

  // https://github.com/rollup/plugins/tree/master/packages/commonjs
  options.plugins.push(commonjs({
    extensions: extensions.filter(ext => ext !== '.json')
  }))

  // https://github.com/rollup/plugins/tree/master/packages/json
  options.plugins.push(json())

  if (config.analyze) {
    // https://github.com/doesdev/rollup-plugin-analyzer
    options.plugins.push(analyze())
  }

  if (config.minify !== false) {
    options.plugins.push(terser())
  }

  return options
}

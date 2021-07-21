'use strict'

const path = require('path')
const Module = require('module')
const resolve = require('resolve')
const debug = require('debug')('require-in-the-middle')
const parse = require('module-details-from-path')
const callsites = require('callsites')

module.exports = Hook

const builtins = Module.builtinModules

const isCore = builtins
  ? (filename) => builtins.includes(filename)
  // Fallback in case `builtins` isn't available in the current Node.js
  // version. This isn't as acurate, as some core modules contain slashes, but
  // all modern versions of Node.js supports `buildins`, so it shouldn't affect
  // many people.
  : (filename) => filename.includes(path.sep) === false

// 'foo/bar.js' or 'foo/bar/index.js' => 'foo/bar'
const normalize = /([/\\]index)?(\.js)?$/

function Hook (modules, options, onrequire) {
  if ((this instanceof Hook) === false) return new Hook(modules, options, onrequire)
  if (typeof modules === 'function') {
    onrequire = modules
    modules = null
    options = null
  } else if (typeof options === 'function') {
    onrequire = options
    options = modules
    modules = null // HACK: changes original behavior with 2 args
  }

  if (typeof Module._resolveFilename !== 'function') {
    console.error('Error: Expected Module._resolveFilename to be a function (was: %s) - aborting!', typeof Module._resolveFilename)
    console.error('Please report this error as an issue related to Node.js %s at %s', process.version, require('./package.json').bugs.url)
    return
  }

  this.cache = new Map()
  this._unhooked = false
  this._origRequire = Module.prototype.require

  const self = this
  const patching = new Set()
  const internals = options ? options.internals === true : false
  const hasWhitelist = Array.isArray(modules)

  if (hasWhitelist) {
    throw new Error('whitelist not supported')
  }

  debug('registering require hook')

  this._require = Module.prototype.require = function (id) {
    if (self._unhooked === true) {
      // if the patched require function could not be removed because
      // someone else patched it after it was patched here, we just
      // abort and pass the request onwards to the original require
      debug('ignoring require call - module is soft-unhooked')
      return self._origRequire.apply(this, arguments)
    }

    const sites = callsites()
    // console.log('SITES', sites.map(site => site.getFileName()))
    const requiredByPath = sites[2]?.getFileName() // HACK: '2' is specific to our loader
    let requiredBy
    if (requiredByPath != null) {
      const requiredByStat = parse(requiredByPath, options?.topLevel)
      if (requiredByStat !== undefined) {
        requiredBy = requiredByStat
        requiredBy.filename = requiredByPath
      }
    }

    const filename = Module._resolveFilename(id, this)
    const core = isCore(filename)
    let stat

    debug('processing %s module require(\'%s\'): %s', core === true ? 'core' : 'non-core', id, filename)

    // return known patched modules immediately
    if (self.cache.has(filename) === true) {
      debug('returning already patched cached module: %s', filename)

      const entry = self.cache.get(filename)

      if (entry.subsequent) {
        entry.subsequent(requiredBy)
      }

      return entry.exports
    }

    // Check if this module has a patcher in-progress already.
    // Otherwise, mark this module as patching in-progress.
    const isPatching = patching.has(filename)
    if (isPatching === false) {
      patching.add(filename)
    }

    const exports = self._origRequire.apply(this, arguments)

    // debug('finished origRequire for %s %s', id, filename)

    // If it's already patched, just return it as-is.
    if (isPatching === true) {
      debug('module is in the process of being patched already - ignoring: %s', filename)
      return exports
    }

    // The module has already been loaded,
    // so the patching mark can be cleaned up.
    patching.delete(filename)

    if (core === true) {
      if (hasWhitelist === true && modules.includes(filename) === false) {
        debug('ignoring core module not on whitelist: %s', filename)
        return exports // abort if module name isn't on whitelist
      }
      stat = {
        filename: filename,
        name: filename
      }
    // } else if (hasWhitelist === true && modules.includes(filename)) {
    //   // whitelist includes the absolute path to the file including extension
    //   const parsedPath = path.parse(filename)
    //   moduleName = parsedPath.name
    //   basedir = parsedPath.dir
    } else {
      stat = parse(filename, options?.topLevel)
      if (stat === undefined) {
        debug('could not parse filename: %s', filename)
        return exports // abort if filename could not be parsed
      }
      // moduleName = stat.name
      // basedir = stat.basedir
      stat.filename = filename

      const fullModuleName = resolveModuleName(stat)

      debug('resolved filename to module: %s (id: %s, resolved: %s, basedir: %s)', stat.name, id, fullModuleName, stat.basedir)

      // Ex: require('foo/lib/../bar.js')
      // moduleName = 'foo'
      // fullModuleName = 'foo/bar'
      if (hasWhitelist === true && modules.includes(stat.name) === false) {
        if (modules.includes(fullModuleName) === false) return exports // abort if module name isn't on whitelist

        // if we get to this point, it means that we're requiring a whitelisted sub-module
        stat.name = fullModuleName
      } else {
        // figure out if this is the main module file, or a file inside the module
        let res
        try {
          res = resolve.sync(stat.name, { basedir: stat.basedir })
        } catch (e) {
          debug('could not resolve module: %s', stat.name)
          return exports // abort if module could not be resolved (e.g. no main in package.json and no index.js file)
        }

        if (res !== filename) {
          // this is a module-internal file
          if (internals === true) {
            // use the module-relative path to the file, prefixed by original module name
            // stat.name = stat.name + path.sep + path.relative(stat.basedir, filename)
            debug('preparing to process require of internal file: %s', stat.name)
          } else {
            debug('ignoring require of non-main module file: %s', res)
            return exports // abort if not main module file
          }
        }
      }
    }

    // only call onrequire the first time a module is loaded
    if (self.cache.has(filename) === false) {
      // ensure that the cache entry is assigned a value before calling
      // onrequire, in case calling onrequire requires the same module.
      self.cache.set(filename, { exports })
      debug('calling require hook: %s', stat.name)
      self.cache.set(filename, {
        exports: onrequire(exports, stat, true, requiredBy),
        subsequent: (requiredBy) => { onrequire(undefined, stat, false, requiredBy) }
      })
    }

    debug('returning module: %s', stat.name)
    return self.cache.get(filename).exports
  }
}

Hook.prototype.unhook = function () {
  this._unhooked = true
  if (this._require === Module.prototype.require) {
    Module.prototype.require = this._origRequire
    debug('unhook successful')
  } else {
    debug('unhook unsuccessful')
  }
}

function resolveModuleName (stat) {
  const normalizedPath = path.sep !== '/' ? stat.path.split(path.sep).join('/') : stat.path
  return path.posix.join(stat.name, normalizedPath).replace(normalize, '')
}

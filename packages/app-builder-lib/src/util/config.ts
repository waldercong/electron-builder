import { DebugLogger, deepAssign, InvalidConfigurationError, log } from "builder-util"
import { statOrNull } from "builder-util/out/fs"
import { readJson } from "fs-extra-p"
import { Lazy } from "lazy-val"
import * as path from "path"
import { getConfig as _getConfig, loadParentConfig, orNullIfFileNotExist, ReadConfigRequest, validateConfig as _validateConfig } from "read-config-file"
import { FileSet } from ".."
import { Configuration } from "../configuration"
import { reactCra } from "../presets/rectCra"

// https://github.com/electron-userland/electron-builder/issues/1847
function mergePublish(config: Configuration, configFromOptions: Configuration) {
  // if config from disk doesn't have publish (or object), no need to handle, it will be simply merged by deepAssign
  const publish = Array.isArray(config.publish) ? configFromOptions.publish : null
  if (publish != null) {
    delete (configFromOptions as any).publish
  }

  deepAssign(config, configFromOptions)

  if (publish == null) {
    return
  }

  const listOnDisk = config.publish as Array<any>
  if (listOnDisk.length === 0) {
    config.publish = publish
  }
  else {
    // apply to first
    Object.assign(listOnDisk[0], publish)
  }
}

export async function getConfig(projectDir: string, configPath: string | null, configFromOptions: Configuration | null | undefined, packageMetadata: Lazy<{ [key: string]: any } | null> = new Lazy(() => orNullIfFileNotExist(readJson(path.join(projectDir, "package.json"))))): Promise<Configuration> {
  const configRequest: ReadConfigRequest = {packageKey: "build", configFilename: "electron-builder", projectDir, packageMetadata}
  const configAndEffectiveFile = await _getConfig<Configuration>(configRequest, configPath)
  const config = configAndEffectiveFile == null ? {} : configAndEffectiveFile.result
  if (configFromOptions != null) {
    mergePublish(config, configFromOptions)
  }

  if (configAndEffectiveFile != null) {
    log.info({file: configAndEffectiveFile.configFile == null ? 'package.json ("build" field)' : configAndEffectiveFile.configFile}, "loaded configuration")
  }

  let extendsSpec = config.extends
  if (extendsSpec == null && extendsSpec !== null) {
    const metadata = await packageMetadata.value || {}
    const devDependencies = metadata.devDependencies
    const dependencies = metadata.dependencies
    if ((dependencies != null && "react-scripts" in dependencies) || (devDependencies != null && "react-scripts" in devDependencies)) {
      extendsSpec = "react-cra"
      config.extends = extendsSpec
    }
    else if (devDependencies != null && "electron-webpack" in devDependencies) {
      extendsSpec = "electron-webpack/electron-builder.yml"
      config.extends = extendsSpec
    }
  }

  let parentConfig: Configuration | null
  if (extendsSpec === "react-cra") {
    parentConfig = await reactCra(projectDir)
    log.info({preset: extendsSpec}, "loaded parent configuration")
  }
  else if (extendsSpec != null) {
    const parentConfigAndEffectiveFile = await loadParentConfig<Configuration>(configRequest, extendsSpec)
    log.info({file: parentConfigAndEffectiveFile.configFile}, "loaded parent configuration")
    parentConfig = parentConfigAndEffectiveFile.result
  }
  else {
    parentConfig = null
  }

  return doMergeConfigs(config, parentConfig)
}

// normalize for easy merge
function normalizeFiles(configuration: Configuration, name: "files" | "extraFiles" | "extraResources") {
  let value = configuration[name]
  if (value == null) {
    return
  }

  if (!Array.isArray(value)) {
    value = [value]
  }

  itemLoop: for (let i = 0; i < value.length; i++) {
    let item = value[i]
    if (typeof item === "string") {
      // merge with previous if possible
      if (i !== 0) {
        let prevItemIndex = i - 1
        let prevItem: FileSet
        do {
          prevItem = value[prevItemIndex--] as FileSet
        } while (prevItem == null)

        if (prevItem.from == null && prevItem.to == null) {
          if (prevItem.filter == null) {
            prevItem.filter = [item]
          }
          else {
            (prevItem.filter as Array<string>).push(item)
          }
          value[i] = null as any
          continue itemLoop
        }
      }

      item = {
        filter: [item],
      }
      value[i] = item
    }
    else if (Array.isArray(item)) {
      throw new Error(`${name} configuration is invalid, nested array not expected for index ${i}: ` + item)
    }

    // make sure that merge logic is not complex - unify different presentations
    if (item.from === ".") {
      item.from = undefined
    }

    if (item.to === ".") {
      item.to = undefined
    }

    if (item.filter != null && typeof item.filter === "string") {
      item.filter = [item.filter]
    }
  }

  configuration[name] = value.filter(it => it != null)
}

function mergeFiles(configuration: Configuration, parentConfiguration: Configuration, mergedConfiguration: Configuration, name: "files" | "extraFiles" | "extraResources") {
  const list = configuration[name] as Array<FileSet> | null
  const parentList = parentConfiguration[name] as Array<FileSet> | null
  if (list == null || parentList == null) {
    return
  }

  const result = list.slice()
  mergedConfiguration[name] = result

  itemLoop: for (const item of parentConfiguration.files as Array<FileSet>) {
    for (const existingItem of list) {
      if (existingItem.from === item.from && existingItem.to === item.to) {
        if (item.filter != null) {
          if (existingItem.filter == null) {
            existingItem.filter = item.filter.slice()
          }
          else {
            existingItem.filter = (item.filter as Array<string>).concat(existingItem.filter)
          }
        }

        continue itemLoop
      }
    }

    // existing item not found, simply add
    result.push(item)
  }
}

export function doMergeConfigs(configuration: Configuration, parentConfiguration: Configuration | null) {
  normalizeFiles(configuration, "files")
  normalizeFiles(configuration, "extraFiles")
  normalizeFiles(configuration, "extraResources")

  if (parentConfiguration == null) {
    return deepAssign(getDefaultConfig(), configuration)
  }

  normalizeFiles(parentConfiguration, "files")
  normalizeFiles(parentConfiguration, "extraFiles")
  normalizeFiles(parentConfiguration, "extraResources")

  const result = deepAssign(getDefaultConfig(), parentConfiguration, configuration)
  mergeFiles(configuration, parentConfiguration, result, "files")
  return result
}

function getDefaultConfig(): Configuration {
  return {
    directories: {
      output: "dist",
      buildResources: "build",
    },
  }
}

const schemeDataPromise = new Lazy(() => readJson(path.join(__dirname, "..", "..", "scheme.json")))

export async function validateConfig(config: Configuration, debugLogger: DebugLogger) {
  const extraMetadata = config.extraMetadata
  if (extraMetadata != null) {
    if (extraMetadata.build != null) {
      throw new InvalidConfigurationError(`--em.build is deprecated, please specify as -c"`)
    }
    if (extraMetadata.directories != null) {
      throw new InvalidConfigurationError(`--em.directories is deprecated, please specify as -c.directories"`)
    }
  }

  // noinspection JSDeprecatedSymbols
  if (config.npmSkipBuildFromSource === false) {
    config.buildDependenciesFromSource = false
  }

  await _validateConfig(config, schemeDataPromise, (message, errors) => {
    if (debugLogger.isEnabled) {
      debugLogger.add("invalidConfig", JSON.stringify(errors, null, 2))
    }

    return `${message}

How to fix:
1. Open https://electron.build/configuration/configuration
2. Search the option name on the page.
  * Not found? The option was deprecated or not exists (check spelling).
  * Found? Check that the option in the appropriate place. e.g. "title" only in the "dmg", not in the root.
`
  })
}

const DEFAULT_APP_DIR_NAMES = ["app", "www"]

export async function computeDefaultAppDirectory(projectDir: string, userAppDir: string | null | undefined): Promise<string> {
  if (userAppDir != null) {
    const absolutePath = path.resolve(projectDir, userAppDir)
    const stat = await statOrNull(absolutePath)
    if (stat == null) {
      throw new InvalidConfigurationError(`Application directory ${userAppDir} doesn't exists`)
    }
    else if (!stat.isDirectory()) {
      throw new InvalidConfigurationError(`Application directory ${userAppDir} is not a directory`)
    }
    else if (projectDir === absolutePath) {
      log.warn({appDirectory: userAppDir}, `Specified application directory equals to project dir — superfluous or wrong configuration`)
    }
    return absolutePath
  }

  for (const dir of DEFAULT_APP_DIR_NAMES) {
    const absolutePath = path.join(projectDir, dir)
    const packageJson = path.join(absolutePath, "package.json")
    const stat = await statOrNull(packageJson)
    if (stat != null && stat.isFile()) {
      return absolutePath
    }
  }
  return projectDir
}
// dshm-backup 全量环境区段（environment）
//
// 目标：备份/恢复“插件本体 + 插件配置 + 技能 + 凭据/设置”，做到重装或插件爆掉后
// 不只是聊天记录和图片回来，插件也原样回来。
//
// 形态：外层备份 ZIP 内的一个嵌套 ZIP（data/environment.zip），条目路径相对 DSH_HOME。
//   · profiles/**（含 node_modules 插件安装目录，离线可用）
//   · skills/**、storages/**（workspace.json 由主恢复流程单独处理）
//   · 各插件在 DSH_HOME 下的设置目录与状态文件
//   · .credentials.yaml（可用 config.environment.includeCredentials=false 关闭）
//
// 安全边界：
//   · 不收录 sessions / attachments（由主备份区段负责，避免重复）；
//   · 不收录备份自身、staging、rollback、日志、host-ready.json（含临时 token）；
//   · 恢复时逐条校验目标必须落在 DSH_HOME 内，并拒绝写入受保护区段。
//
// 风格与其余 lib 文件一致：var/function，ESM 导出，零第三方依赖。

import { readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import * as fmt from "./format.js";
import * as util from "./util.js";
import { writeZip, extractZip } from "./zip.js";

// 不进入环境快照的 DSH_HOME 顶层条目（会话/附件由主流程处理；其余是缓存与运行时文件）
var TOP_DENY = {
  sessions: true,
  attachments: true,
  cache: true,
  "install-queue": true,
  "host-ready.json": true,
  ".anonymous-user-id": true,
  ".workbuddy-host-heartbeat.json": true,
  "app-lifecycle.json": true,
  "dshm-backup.log": true,
  "dshm-boot-rescue.log": true,
  "host-crash.log": true,
};

// 递归时跳过的目录：这些目录要么是缓存，要么是符号链接集合（手机档不允许符号链接）
var SKIP_DIR_NAMES = [".git", ".svn", ".hg", ".cache", ".bin", "__pycache__", ".Trash", ".Recent", ".virtfs_metadata"];

function compressionForName(name) {
  if (/\.(json|jsonl|md|txt|yml|yaml|log|csv|tsv|xml|js|mjs|cjs|ts|tsx|css|html)$/i.test(name)) return "deflate";
  return "store";
}

function isLogOrRuntimeFile(name) {
  return /\.(log|lock)$/i.test(name) || /(^|\/)\.DS_Store$/.test(name) || /\.tmp$/i.test(name);
}

function pluginNameFromEnvEntry(name) {
  // profiles/<profile>/node_modules/<pkg>/package.json（scoped 包多一层）
  var m = /^profiles\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(name);
  return m ? m[1] : null;
}

/**
 * 扫描需要进入环境快照的文件。返回 { files, warnings, credentialsIncluded }。
 * files 项：{ rel, abs, size }，rel 相对 DSH_HOME。
 */
export async function collectEnvironmentFiles(paths, options) {
  var settings = options || {};
  var includeCredentials = settings.includeCredentials !== false;
  var files = [];
  var warnings = [];
  var seen = {};
  var maxFiles = typeof settings.maxFiles === "number" ? settings.maxFiles : fmt.MAX_BACKUP_FILES;

  function addFile(abs, rel, size) {
    var normalized = rel.replace(/\\/g, "/");
    if (!normalized) return;
    var relSegments = normalized.split("/");
    for (var rs = 0; rs < relSegments.length; rs += 1) {
      if (relSegments[rs] === "." || relSegments[rs] === ".." || relSegments[rs] === "") return;
    }
    if (seen[normalized]) return;
    if (!fmt.isSafeZipEntryName(normalized)) {
      warnings.push("环境文件路径不安全，已跳过：" + normalized);
      return;
    }
    if (isLogOrRuntimeFile(normalized)) return;
    seen[normalized] = true;
    files.push({ rel: normalized, abs: abs, size: size });
  }

  var skipAbsPrefixes = [
    paths.backupDir,
    paths.stagingRoot,
    join(paths.stateDir, "backups"),
    join(paths.stateDir, "staging"),
    join(paths.stateDir, "rollback"),
    paths.sessionsDir,
    paths.attachmentsDir,
  ];

  async function walk(rootAbs, rootRel, extraSkipDirs) {
    var skipNames = SKIP_DIR_NAMES.concat(extraSkipDirs || []);
    var walkResult = await util.walkFiles(rootAbs, {
      skipDirNames: skipNames,
      skipAbsPrefixes: skipAbsPrefixes,
      maxFiles: Math.max(1, maxFiles - files.length),
    });
    var list = walkResult.files || [];
    for (var i = 0; i < list.length; i += 1) {
      addFile(list[i].abs, rootRel ? rootRel + "/" + list[i].rel : list[i].rel, list[i].size);
    }
    var warnList = walkResult.warnings || [];
    for (var w = 0; w < warnList.length; w += 1) {
      // 缓存/符号链接目录的跳过提示没有诊断价值，避免清单膨胀
      if (/\.cache|\.bin|符号链接|特殊文件/.test(warnList[w])) continue;
      if (/文件数量超过上限|已停止扫描|目录数量超过/.test(warnList[w])) {
        throw util.errorWithCode("ENVIRONMENT_TRUNCATED", "插件/配置扫描被截断，为避免不完整备份已中止：" + warnList[w], 413);
      }
      warnings.push(warnList[w]);
    }
    if (walkResult.exists === false) warnings.push("环境目录不存在： " + rootAbs);
  }

  var entries = null;
  try {
    entries = await readdir(paths.home, { withFileTypes: true });
  } catch (error) {
    throw util.errorWithCode("ENVIRONMENT_SCAN_FAILED", "读取 DSH_HOME 失败：" + util.errText(error), 500);
  }
  entries.sort(function (a, b) {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  for (var i = 0; i < entries.length; i += 1) {
    var entry = entries[i];
    var name = entry.name;
    if (TOP_DENY[name]) continue;
    if (name === "dshm-backup") {
      // 只带插件设置，不带备份包/状态/临时目录
      var configPath = join(paths.stateDir, "config.json");
      try {
        var configInfo = await stat(configPath);
        if (configInfo.isFile()) addFile(configPath, "dshm-backup/config.json", configInfo.size);
      } catch (_) {
        // 没有配置就用默认值
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (name === "storages") {
        // workspace.json 由主恢复流程重写；投影缓存可重建
        var storageWalk = await util.walkFiles(join(paths.home, name), {
          skipDirNames: SKIP_DIR_NAMES,
          skipAbsPrefixes: skipAbsPrefixes.concat([
            paths.workspaceRegistryPath,
            join(paths.storagesDir, "session_projcache"),
          ]),
          maxFiles: Math.max(1, maxFiles - files.length),
        });
        var storageFiles = storageWalk.files || [];
        for (var sf = 0; sf < storageFiles.length; sf += 1) {
          addFile(storageFiles[sf].abs, "storages/" + storageFiles[sf].rel, storageFiles[sf].size);
        }
        var storageWarnings = storageWalk.warnings || [];
        for (var sw = 0; sw < storageWarnings.length; sw += 1) {
          if (/文件数量超过上限|已停止扫描|目录数量超过/.test(storageWarnings[sw])) {
            throw util.errorWithCode("ENVIRONMENT_TRUNCATED", "storages 扫描被截断，为避免不完整备份已中止：" + storageWarnings[sw], 413);
          }
          warnings.push(storageWarnings[sw]);
        }
        continue;
      }
      await walk(join(paths.home, name), name);
    } else if (entry.isFile()) {
      try {
        var info = await stat(join(paths.home, name));
        addFile(join(paths.home, name), name, info.size);
      } catch (_) {
        warnings.push("环境文件读取失败（已跳过）：" + name);
      }
    } else {
      // 符号链接/特殊文件：手机档不应出现在 DSH_HOME 顶层，跳过并说明
      warnings.push("跳过符号链接/特殊文件： " + name);
    }
    if (files.length > maxFiles) {
      throw util.errorWithCode("ENVIRONMENT_TOO_MANY_FILES", "插件/配置文件数量超过上限（" + maxFiles + "），请先清理 node_modules", 413);
    }
  }
  if (files.length >= maxFiles) {
    throw util.errorWithCode("ENVIRONMENT_TOO_MANY_FILES", "插件/配置文件数量达到上限（" + maxFiles + "），为避免静默截断已中止", 413);
  }

  // 凭据开关：默认包含（灾难恢复后无需重新登录）；关闭时剔除已知凭据文件
  var credentialsIncluded = false;
  if (includeCredentials) {
    credentialsIncluded = files.some(function (item) {
      return item.rel === ".credentials.yaml" || item.rel.indexOf("openai-gateway/api-key") === 0;
    });
  } else {
    files = files.filter(function (item) {
      return item.rel !== ".credentials.yaml" && item.rel.indexOf("openai-gateway/api-key") !== 0;
    });
  }

  files.sort(function (a, b) {
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });
  return { files: files, warnings: warnings, credentialsIncluded: credentialsIncluded };
}

/**
 * 生成嵌套环境 ZIP。返回 { descriptor, path }：
 *   descriptor 会写进主清单；path 是 staging 内的 environment.zip。
 */
export async function buildEnvironmentSnapshot(runtime, stageRoot, options) {
  var settings = options || {};
  var paths = runtime.paths;
  var config = runtime.config || {};
  var envConfig = config.environment && typeof config.environment === "object" ? config.environment : {};
  var includeCredentials = envConfig.includeCredentials !== false;
  if (settings.includeCredentials !== undefined) includeCredentials = settings.includeCredentials !== false;

  var scan = await collectEnvironmentFiles(paths, { includeCredentials: includeCredentials });
  if (scan.files.length === 0) {
    return {
      descriptor: null,
      path: null,
      warnings: scan.warnings.concat(["没有可备份的插件/配置文件"]),
    };
  }
  var envZipPath = join(stageRoot, "environment.zip");
  var entries = [];
  var uncompressedBytes = 0;
  var pluginNames = {};
  for (var i = 0; i < scan.files.length; i += 1) {
    var item = scan.files[i];
    uncompressedBytes += item.size;
    entries.push({
      name: item.rel,
      source: { type: "file", path: item.abs },
      compress: compressionForName(item.rel),
    });
    var pluginName = pluginNameFromEnvEntry(item.rel);
    if (pluginName) pluginNames[pluginName] = true;
  }
  if (uncompressedBytes > fmt.MAX_BACKUP_BYTES) {
    throw util.errorWithCode("ENVIRONMENT_TOO_LARGE", "插件/配置解压后超过单包上限（< 4 GiB）", 413);
  }
  var zipResult = await writeZip(envZipPath, entries);
  var descriptor = {
    entry: fmt.ENVIRONMENT_ENTRY,
    size: zipResult.size,
    sha256: zipResult.sha256,
    fileCount: scan.files.length,
    uncompressedBytes: uncompressedBytes,
    profileName: paths.profileName,
    pluginCount: Object.keys(pluginNames).length,
    credentialsIncluded: scan.credentialsIncluded,
    capturedAt: util.nowIso(),
  };
  return { descriptor: descriptor, path: envZipPath, warnings: scan.warnings };
}

function isProtectedTarget(paths, target) {
  if (util.isInsidePath(paths.sessionsDir, target)) return true;
  if (util.isInsidePath(paths.attachmentsDir, target)) return true;
  if (util.isInsidePath(paths.backupDir, target)) return true;
  if (util.isInsidePath(paths.stagingRoot, target)) return true;
  if (util.isInsidePath(join(paths.stateDir, "backups"), target)) return true;
  if (util.isInsidePath(join(paths.stateDir, "staging"), target)) return true;
  if (util.isInsidePath(join(paths.stateDir, "rollback"), target)) return true;
  if (target === join(paths.home, "host-ready.json")) return true;
  return false;
}

/**
 * 把环境 ZIP 覆盖到当前 DSH_HOME。
 * 返回 { files, plugins, credentialsIncluded, warnings }。
 * 必须在主恢复把 staging 清掉之前调用。
 */
export async function applyEnvironmentSnapshot(runtime, envZipPath, stagingDir, options) {
  var settings = options || {};
  var paths = runtime.paths;
  var warnings = [];
  var treeDir = join(stagingDir, "env-tree");
  var extracted = await extractZip(envZipPath, treeDir, {
    maxTotalBytes: fmt.MAX_BACKUP_BYTES,
    maxFileBytes: fmt.MAX_BACKUP_BYTES,
    onProgress: typeof settings.onProgress === "function" ? settings.onProgress : undefined,
  });
  var list = Array.isArray(extracted.files) ? extracted.files : [];
  var applied = 0;
  var plugins = {};
  var credentialsIncluded = false;
  var sourceProfile = typeof settings.sourceProfile === "string" ? settings.sourceProfile : "";
  var targetProfile = paths.profileName;
  for (var i = 0; i < list.length; i += 1) {
    var name = list[i].name;
    if (!fmt.isSafeZipEntryName(name)) {
      throw util.errorWithCode("RESTORE_TARGET_UNSAFE", "环境区段包含不安全路径：" + name, 422);
    }
    // 跨 profile 恢复：把备份里的 profiles/<源 profile>/ 映射到当前活跃 profile，
    // 否则插件会写进一个冷启动时不会加载的目录。
    if (sourceProfile && targetProfile && sourceProfile !== targetProfile) {
      var sourcePrefix = "profiles/" + sourceProfile + "/";
      if (name.indexOf(sourcePrefix) === 0) {
        name = "profiles/" + targetProfile + "/" + name.slice(sourcePrefix.length);
      }
    }
    var target = join(paths.home, name);
    if (!util.isInsidePath(paths.home, target)) {
      throw util.errorWithCode("RESTORE_TARGET_UNSAFE", "环境区段目标越界：" + name, 422);
    }
    if (isProtectedTarget(paths, target)) {
      warnings.push("跳过受保护的环境条目： " + name);
      continue;
    }
    // 备份工具自身的配置包含安装相关的 backupDir，恢复时保留当前值，避免旧路径不可写。
    if (name === "dshm-backup/config.json") {
      warnings.push("保留当前备份工具配置，未覆盖 dshm-backup/config.json");
      continue;
    }
    await util.ensureDir(dirname(target));
    await util.copyFileBulk(join(treeDir, name), target);
    applied += 1;
    var pluginName = pluginNameFromEnvEntry(name);
    if (pluginName) plugins[pluginName] = true;
    if (name === ".credentials.yaml" || name.indexOf("openai-gateway/api-key") === 0) credentialsIncluded = true;
    if (typeof settings.onProgress === "function" && (i % 100 === 0 || i === list.length - 1)) {
      settings.onProgress(i + 1, list.length);
    }
  }
  return {
    files: applied,
    plugins: Object.keys(plugins).length,
    credentialsIncluded: credentialsIncluded,
    warnings: warnings,
  };
}

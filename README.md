# dshm-backup（DSHM 插件包）

DSHM（HarmonyOS 端 DeepSeek Harness）备份与迁移工具（**v0.1.8**，外部源码复核退回修复后重新生成；
修复项见 `../FIX_REPORT.md`），纯宿主插件 + 注入式 Web UI，零第三方依赖、零静态 `inject`。项目总览、备份位置、恢复限制见上一级 `README.md`；
只读侦查证据与手机验收清单见 `../FEASIBILITY.md` 与 `../HANDOFF_PHONE.md`。

## 安装（在手机上执行；平板不得安装本插件）

设置 → 插件 → 安装插件，输入：

```
github:<owner>/<repo>#<branch>
```

或当本包位于仓库子目录时：

```
github:<owner>/<repo>#<branch>&path:/dshm-backup
```

安装成功后**必须冷重启** DSHM：划掉后台，重新打开应用（页面刷新无效）。
重启后页面右下角出现「备份」按钮；正常页与插件加载失败页都会注入。

## 使用

- 立即备份 / 查看备份与基线 / 导入预览 / 确认恢复 / 校验备份：见注入面板。
- 备份默认写到 `<当前默认工作区>/dshm-backup/backups/`（用户可见目录，例如
  `/storage/Users/currentUser/Download/com.dshm.dshclient/dshm-backup/backups/`）。
- 备份包含明文聊天记录与工作区文件，请妥善保管；不包含凭据/token/cookie。
- 恢复要求目标为全新实例、核心版本一致；恢复后必须冷重启，重启前不要新建会话。
- 本插件不安装/启用/停用任何插件，只导出插件名单+版本（严格仅 name/version）供人工核对。

## 限制

- 首版只承诺同版本迁移（实际核心版本字符串完全一致）。
- 单包 < 4 GiB；不支持 ZIP64、加密、符号链接条目。
- 无系统文件选择/分享/后台服务。
- 平板端未真实执行本插件（本机无 node CLI）；真实安装/备份/恢复待手机金丝雀验收。

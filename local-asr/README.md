# Windows 原生语音识别服务

使用 faster-whisper，在 Windows 本机提供插件所需的 HTTP 接口。无需 Docker、WSL 或单独安装 FFmpeg；CPU 模式不需要 CUDA。该服务只负责语音转文字，译文仍由插件现有翻译引擎生成。

## 第一次安装

1. 安装 **64 位 Python 3.11**（[Python 官方下载](https://www.python.org/downloads/windows/)），保留 Python Launcher，或将 Python 加入 PATH。
2. 双击此目录的 **install.cmd**。它在此目录创建 `.venv`，通过 pip 安装依赖，不修改全局 Python 包，不要求管理员权限。
3. 安装完成后双击 **start.cmd**。首次启动会下载 `Systran/faster-whisper-small`，保存在此目录的 `models`；需要访问 Hugging Face 并等待下载完成。
4. 控制台显示 **READY** 后再开启插件听译。保持服务窗口打开，Ctrl+C 停止服务。以后只需运行 start.cmd。

这次交付没有执行安装、下载、启动或测试，需要你在本机验证。识别速度取决于电脑和模型；CPU 模式不保证能跟上实时播放。

## 插件怎么填写

在目标视频页点击工具栏插件按钮 → **通用视频听译 · 语音识别服务**：

| 项目 | 默认值 |
| --- | --- |
| 基础地址 | `http://127.0.0.1:8000/v1` |
| 模型 ID | `Systran/faster-whisper-small` |
| API Key | 留空，除非你设置了下方的认证环境变量 |
| 原语言 | 自动识别，或手动指定 |
| 分段 | 先使用默认 2 秒（停顿时提前发送） |

点击「获取可用模型 / 检查连接」会列出服务当前加载的模型。它不会安装或切换模型；需要切换模型时停止服务，以新模型参数重新启动，再在插件选择新的 ID。

Speaches 仍然可用，填写其 `/v1` 地址和模型 ID 即可。两个服务不要同时占用同一个端口。

## PowerShell 自定义启动

在此目录打开 PowerShell。脚本无需激活虚拟环境。

```powershell
# 指定 Python 路径安装（支持 Python 3.10–3.12 x64）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Python 'C:\Python311\python.exe'

# 换成较小模型，减少计算量（可能降低识别准确率）
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Model Systran/faster-whisper-base

# 改端口与 CPU 线程数
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Port 8001 -Threads 6

# 使用已下载的 CTranslate2 / faster-whisper 模型目录
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Model 'D:\Models\whisper-small' -ModelId 'my-whisper-small'

# NVIDIA GPU：需先自行配置兼容的 CUDA / cuDNN 运行库
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Device cuda -ComputeType float16
```

自定义本地模型目录必须是 faster-whisper 支持的 CTranslate2 格式，不能使用 whisper.cpp 的 GGML 模型。GPU 依赖请参考 [faster-whisper 官方说明](https://github.com/SYSTRAN/faster-whisper#gpu)，脚本不会自动安装 GPU 驱动或运行库。CPU 默认使用 `int8`。

可选开启认证，环境变量只对当前 PowerShell 及其子进程生效：

```powershell
$env:LOCAL_ASR_API_KEY = '替换为你自己设置的密钥'
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

然后在插件语音识别配置中填写相同 Key。不要将密钥写入仓库。

## 接口与边界

- 仅监听 `127.0.0.1`，不提供局域网公开服务。默认不启用认证；可用上述环境变量启用 Bearer 认证。
- `GET /health`：服务就绪信息。
- `GET /v1/models`：当前已加载模型。
- `POST /v1/audio/transcriptions`：multipart 表单，包含 `file`、`model`、可选 `language`、`response_format`。支持 `json`、`verbose_json`、`text`。
- 上传仅接受完整的单声道 16-bit PCM WAV，16 / 22.05 / 24 / 44.1 / 48 kHz，最长 30 秒、整个请求最多 4 MiB，适配插件的短音频分段。
- 模型启动时加载一次并复用，一次只处理一个请求，忙时返回 429。客户端中止请求不能强制打断已在执行的模型推理，需等待当前段完成。
- 音频和转写结果只在内存中处理，不写入音频或字幕历史；模型文件会保留。插件的翻译缓存规则保持不变。
- 允许扩展来源和无 Origin 的本地客户端，拒绝普通网页 Origin；不对互联网网站开放通用 CORS。

## 排错

- **找不到 Python / py -3.11 失败**：安装 Python 3.11 x64，或用 `install.ps1 -Python` 指定已安装的 3.10–3.12。
- **pip 下载失败**：检查网络、代理和证书，解决后重新运行 install.cmd，不必删除虚拟环境。
- **启动长时间未出现 READY**：查看模型下载进度。首次模型下载可能较慢，完成前插件不能正常识别。
- **端口被占用**：停止原先的 Speaches / 识别服务，或用 `-Port 8001` 并同步修改插件地址。
- **模型 404**：点击插件「获取可用模型」，选择服务列出的完整 ID。
- **缺少 DLL / GPU 初始化失败**：先恢复 CPU 默认参数；按官方说明配置 CUDA，部分 Windows 环境也需要 Microsoft Visual C++ 运行库。
- **429 / 超时**：等待前一个推理结束，换较小模型或 GPU 后再试。暂停、拖动视频后可能有旧请求仍在后台推理。

本项目独立实现 HTTP 包装层，运行时依赖 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（MIT）及其依赖，各自许可证适用。
